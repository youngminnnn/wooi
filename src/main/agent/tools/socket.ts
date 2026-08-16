import { createServer, type Server, type Socket } from 'node:net'
import { chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Workspace } from '@shared/types'
import { log } from '../../logger'
import { getStore } from '../../store'
import { ensureToolApproved } from './permission'
import { runAgentTool, runExternalAgentTool } from './registry'

/**
 * 인프로세스로 붙을 수 없는 백엔드(Codex)를 위한 도구 실행 창구.
 *
 * Claude 세션은 호스트 프로세스 안에서 도는 SDK MCP 서버로 붙지만, Codex 는 `codex app-server`
 * 가 **자기가 직접 spawn 하는 stdio MCP 서버**만 받는다. 그 서버는 우리 프로세스 밖에 있으므로
 * 함수 호출로 메인에 닿을 수 없다 — 그래서 로컬 소켓 하나를 열어 준다.
 *
 * 프로토콜은 개행 구분 JSON 한 줄씩이다(요청 1건 = 연결 1개). 도구 실행 자체는 Claude 와
 * **완전히 같은 테이블**을 탄다([[agent/tools/registry]]) — 전송만 둘이고 능력은 하나다.
 */

/** 유닉스 소켓 경로. userData 안에 두어 사용자별로 갈리고, 권한도 사용자 본인만 남긴다. */
export function toolSocketPath(userDataDir: string): string {
  return join(userDataDir, 'agent-tools.sock')
}

export interface ToolSocketRequest {
  /** 호출자 워크스페이스. Codex shim 이 자기 env 에서 읽어 싣는다(아래 검증). */
  workspaceId?: string
  /** 없으면 기존 호출과 같은 workspace 로 해석한다. */
  caller?: 'workspace' | 'external'
  tool: string
  args: unknown
}

/**
 * 주장된 워크스페이스가 지금 이 호출을 낼 수 있는 상태인지 확인한다.
 *
 * 이제 이 값은 모델이 아니라 shim 프로세스의 env 에서 온다([[codex/thread]] wooiMcpConfig) —
 * 모델은 볼 수도 적을 수도 없다. 그래도 검증은 남긴다: shim 은 우리 프로세스 밖에 있고 소켓은
 * 같은 사용자면 누구나 붙을 수 있으므로, 여기가 마지막 관문이다.
 *
 * 실재하고, 아카이브되지 않았고, **지금 턴이 돌고 있는** 워크스페이스여야 한다. 마지막 조건이
 * 핵심이다 — 도구는 에이전트가 도는 중에만 불리므로 정상 호출은 항상 통과하지만, 엉뚱한 id 는
 * 그 워크스페이스가 마침 동시에 돌고 있지 않는 한 걸린다.
 */
function verifyCaller(workspaceId: string | undefined, caller: 'workspace' | 'external'): Workspace | null {
  if (caller === 'external') {
    // 소켓의 0600은 다른 OS 사용자를 막을 뿐 같은 사용자 프로세스를 인증하지 않는다. 따라서 이
    // 플래그 자체는 인증 경계가 아니다. 실제 경계는 외부 전용 도구 allowlist와 수신 workspace의
    // PeerInboundPolicy이며, 호출 workspace가 애초에 없으므로 running 검사는 건너뛴다.
    return null
  }
  if (!workspaceId) throw new Error('No caller workspace was provided.')
  const ws = getStore()
    .getState()
    .workspaces.find((w) => w.id === workspaceId)
  if (!ws) throw new Error(`Unknown Wooi workspace: ${workspaceId}`)
  if (ws.archived) throw new Error('That workspace is archived.')
  if (ws.status !== 'running') {
    throw new Error(`Workspace ${workspaceId} is not running a turn, so it cannot be the caller.`)
  }
  return ws
}

let server: Server | null = null

/** 소켓을 연다. 이미 열려 있으면 아무것도 하지 않는다. */
export function startToolSocket(userDataDir: string): string {
  const path = toolSocketPath(userDataDir)
  if (server) return path

  // 앞선 실행이 비정상 종료해 남긴 소켓 파일이 있으면 bind 가 EADDRINUSE 로 실패한다.
  rmSync(path, { force: true })

  server = createServer((socket) => handleConnection(socket))
  server.on('error', (err) => log.error('agent tools: socket server failed', err))
  server.listen(path, () => {
    // 같은 머신의 다른 사용자가 붙어 앱을 조작하지 못하도록 본인만 남긴다.
    try {
      chmodSync(path, 0o600)
    } catch (err) {
      log.warn('agent tools: could not tighten socket permissions', err)
    }
    log.info(`agent tools: listening on ${path}`)
  })
  return path
}

export function stopToolSocket(userDataDir: string): void {
  server?.close()
  server = null
  rmSync(toolSocketPath(userDataDir), { force: true })
}

function handleConnection(socket: Socket): void {
  let buffer = ''
  socket.on('data', (chunk) => {
    buffer += chunk.toString()
    const i = buffer.indexOf('\n')
    if (i < 0) return
    const line = buffer.slice(0, i)
    buffer = ''
    void respond(socket, line)
  })
  socket.on('error', (err) => log.warn('agent tools: socket connection error', err))
}

async function respond(socket: Socket, line: string): Promise<void> {
  try {
    const req = JSON.parse(line) as ToolSocketRequest
    const caller = req.caller ?? 'workspace'
    const workspace = verifyCaller(req.workspaceId, caller)
    // 승인은 실행 직전에 받는다. Claude 는 SDK 의 canUseTool 이 같은 자리를 맡으므로 공용
    // 실행부가 아니라 **이 전송 계층**에 둔다 — 양쪽에 걸면 Claude 가 두 번 묻는다.
    if (workspace) await ensureToolApproved(workspace, req.tool, req.args)
    const data =
      caller === 'external'
        ? await runExternalAgentTool(req.tool, req.args)
        : await runAgentTool(req.workspaceId!, req.tool, req.args)
    write(socket, { ok: true, data })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    log.warn(`agent tools: call failed — ${error}`)
    write(socket, { ok: false, error })
  }
}

function write(socket: Socket, payload: { ok: boolean; data?: unknown; error?: string }): void {
  try {
    socket.write(JSON.stringify(payload) + '\n')
  } finally {
    socket.end()
  }
}
