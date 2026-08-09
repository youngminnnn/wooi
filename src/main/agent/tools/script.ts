import type { ScriptKind, ScriptStatus, Workspace } from '@shared/types'
import { waitForPortFree } from '../../net'
import { getStore } from '../../store'
import { scriptEnvFor } from '../../workspaces'
import type { AgentToolDeps, AgentToolHandler } from './registry'

/**
 * 리포의 setup/dev 스크립트를 에이전트가 앱을 통해 돌리게 하는 도구들.
 *
 * 에이전트가 `npm run dev` 를 자기 Bash 로 돌리면 두 가지가 깨진다. 그 프로세스는 세션에 묶여
 * 같이 죽고, 사람이 보는 ScriptPanel 에는 아무것도 뜨지 않는다 — **에이전트와 사람이 서로 다른
 * 로그를 본다.** 여기로 돌리면 "고친다 → 재시작한다 → 로그에서 에러를 읽는다" 검증 루프가 앱 안에서
 * 닫히고, 사람은 같은 패널에서 그 과정을 그대로 본다.
 */

/** 읽기 기본 줄 수. 대부분의 실패는 마지막 수십 줄에서 드러난다. */
const DEFAULT_TAIL_LINES = 200

/**
 * 모델이 무엇을 주든 넘길 수 없는 줄 수. dev 로그는 길이 제한이 없고 실패한 빌드는 수천 줄이
 * 나온다 — 그대로 주면 읽기 한 번에 수만 토큰이 들어간다.
 */
const MAX_TAIL_LINES = 500

/**
 * 줄 수와 별개로 거는 바이트 상한. 줄 수만 막으면 긴 줄 하나(미니파이된 번들, 거대한 stack trace)가
 * 상한을 통째로 먹는다.
 */
const MAX_OUTPUT_BYTES = 8 * 1024

function workspaceOf(workspaceId: string): Workspace {
  const ws = getStore()
    .getState()
    .workspaces.find((w) => w.id === workspaceId)
  if (!ws) throw new Error('This workspace no longer exists.')
  return ws
}

/** 모델이 준 kind 를 검증한다. 종류는 둘뿐이라 목록을 문장에 그대로 담아 돌려준다. */
function kindOf(args: Record<string, unknown>): ScriptKind {
  if (args.kind === 'setup' || args.kind === 'dev') return args.kind
  throw new Error('kind must be "setup" or "dev".')
}

/**
 * 이 워크스페이스에서 그 종류의 스크립트로 실제 실행될 명령. 비어 있으면 사용자가 아직 설정하지
 * 않은 것이다.
 *
 * 승인 카드도 같은 값을 보여 줘야 하므로([[agent/tools/permission]]) export 한다 — 사용자가 승인하는
 * 대상은 "dev 스크립트" 라는 이름이 아니라 그 안에서 돌아갈 명령 그 자체다.
 */
export function scriptCommandFor(ws: Workspace, kind: ScriptKind): string {
  const repo = getStore()
    .getState()
    .repos.find((r) => r.id === ws.repoId)
  if (!repo) return ''
  return (kind === 'setup' ? repo.setupScript : repo.devScript).trim()
}

function statusOf(deps: AgentToolDeps, workspaceId: string, kind: ScriptKind): ScriptStatus {
  const found = deps.scripts.getStatus(workspaceId).find((s) => s.kind === kind)
  return found ?? { kind, state: 'idle', exitCode: null }
}

export const runScript: AgentToolHandler = async (deps, workspaceId, args) => {
  const ws = workspaceOf(workspaceId)
  const kind = kindOf(args)

  const command = scriptCommandFor(ws, kind)
  if (!command) {
    throw new Error(
      `This repository has no ${kind} script configured — the user sets that in Wooi’s ` +
        'repository settings, so ask them for the command instead of guessing one.'
    )
  }

  // ScriptRunner.run 은 언제나 먼저 stop 한다. 즉 "이미 돌고 있으면" 은 no-op 이 아니라 재시작이고,
  // 그 차이를 모델이 알아야 한다 — 돌던 dev 서버를 끊고 다시 띄운 것이기 때문이다.
  const wasRunning = statusOf(deps, workspaceId, kind).state === 'running'

  // dev 는 실제로 포트를 바인딩한다. 재시작 시 앞선 프로세스가 포트를 놓기 전에 새로 띄우면
  // EADDRINUSE 로 죽으므로 잠깐 기다린다. 외부 점유 시의 포트 재배정까지는 하지 않는다 — 그건
  // 사용자 조작 경로(ipc.ts)의 몫이고, 여기서는 실패 이유가 로그에 남아 모델이 읽을 수 있다.
  const port = ws.devPort
  if (kind === 'dev' && wasRunning && port != null) {
    deps.scripts.stop(workspaceId, 'dev')
    await waitForPortFree(port, 1500)
  }

  deps.scripts.run(
    workspaceId,
    kind,
    command,
    ws.worktreePath,
    port != null ? scriptEnvFor(port) : undefined
  )

  return {
    kind,
    command,
    restarted: wasRunning,
    result: wasRunning
      ? `The ${kind} script was already running; Wooi stopped it and started it again.`
      : `The ${kind} script was started.`,
    note: 'It runs in the background — read its output with read_script_output.'
  }
}

export const stopScript: AgentToolHandler = async (deps, workspaceId, args) => {
  workspaceOf(workspaceId)
  const kind = kindOf(args)

  const wasRunning = statusOf(deps, workspaceId, kind).state === 'running'
  deps.scripts.stop(workspaceId, kind)

  return {
    kind,
    stopped: wasRunning,
    result: wasRunning
      ? `The ${kind} script was stopped.`
      : `The ${kind} script was not running, so nothing was stopped.`
  }
}

export const readScriptOutput: AgentToolHandler = async (deps, workspaceId, args) => {
  workspaceOf(workspaceId)
  const kind = kindOf(args)

  // 모델이 더 큰 값을 줘도 무시한다. 상한은 협상 대상이 아니라 컨텍스트 예산의 문제다.
  const asked = typeof args.tailLines === 'number' ? Math.floor(args.tailLines) : DEFAULT_TAIL_LINES
  const tailLines = Math.min(Math.max(asked, 1), MAX_TAIL_LINES)

  const raw = deps.scripts.getOutput(workspaceId, kind)
  const lines = raw ? raw.split('\n') : []
  const kept = tailWithinBytes(lines.slice(-tailLines), MAX_OUTPUT_BYTES)

  let output = kept.join('\n')
  // 마지막 방어선 — 줄 하나가 통째로 상한을 넘으면 위에서 최소 한 줄은 남기므로 여기서 자른다.
  const buf = Buffer.from(output, 'utf8')
  if (buf.length > MAX_OUTPUT_BYTES) output = buf.subarray(-MAX_OUTPUT_BYTES).toString('utf8')

  const truncated = kept.length < lines.length || buf.length > MAX_OUTPUT_BYTES
  const status = statusOf(deps, workspaceId, kind)

  return {
    kind,
    // 상태를 함께 준다 — "로그가 비었다" 와 "아직 시작하지 않았다" 는 모델이 취할 행동이 다르다.
    running: status.state === 'running',
    exitCode: status.exitCode,
    output,
    lines: kept.length,
    totalLines: lines.length,
    ...(truncated ? { truncated: true } : {})
  }
}

/**
 * 끝에서부터 줄 단위로 담되 바이트 상한을 넘지 않게 자른다. 항상 **끝쪽**을 남기는 것이 요점이다 —
 * 빌드 실패든 런타임 예외든 알아야 할 것은 마지막에 찍힌다.
 */
function tailWithinBytes(lines: string[], maxBytes: number): string[] {
  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const size = Buffer.byteLength(lines[i], 'utf8') + 1 // 개행 1 바이트
    // 첫 줄은 상한을 넘더라도 담는다 — 빈 결과를 돌려주면 잘렸다는 사실조차 전할 수 없다.
    if (out.length > 0 && bytes + size > maxBytes) break
    bytes += size
    out.unshift(lines[i])
  }
  return out
}
