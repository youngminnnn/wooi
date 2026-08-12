import { randomUUID } from 'node:crypto'
import { ClaudeSession } from './session'
import { askSideQuestion } from './sideQuestion'
import {
  runCommandOn,
  runCommandShortLived,
  runMcpAction,
  invalidateAfterReload,
  readPermissions
} from './control'
import { listSlashCommands } from './commands'
import { createWooiMcpServer } from './wooiMcp'
import { clampText } from './clamp'
import { log } from '../logger'
import type { HostCommand, HostEvent, SessionConfig } from './protocol'
import type { ChatEvent, ChatItem, PermissionDecision, PermissionRequest } from '@shared/types'

/**
 * agent-host: Claude Agent SDK 쿼리를 실행하는 유틸리티 프로세스의 진입점.
 *
 * 모든 ClaudeSession 인스턴스를 여기서 소유하고, 메인과는 parentPort 메시지로만 통신한다.
 * SDK/스트리밍 경로에서 네이티브 fatal 이 나면 이 프로세스만 죽고, 메인은 그것을 감지해
 * 복구한다(manager.ts). store·트랜스크립트·렌더러 IPC 는 메인이 소유하므로, 여기서 만든
 * 이벤트/항목/세션ID/권한요청은 전부 메시지로 메인에 위임한다.
 */

const port = process.parentPort

function post(msg: HostEvent): void {
  port.postMessage(msg)
}

/** workspaceId → 살아 있는 세션. */
const sessions = new Map<string, ClaudeSession>()
/** 호스트가 발급한 requestId → 권한 결정 resolver(메인의 permissionResponse 로 풀린다). */
const pendingPermissions = new Map<string, (d: PermissionDecision) => void>()
/** 호스트가 발급한 callId → Wooi 도구 호출 settler(메인의 toolResult 로 풀린다). */
const pendingToolCalls = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>()

/**
 * Wooi 도구 1건을 메인에 위임하고 결과를 기다린다.
 *
 * 인프로세스 MCP 서버(wooiMcp.ts)의 모든 도구가 이 함수 하나로 수렴한다 — 호스트는 도구가
 * 무엇을 하는지 알 필요가 없고, 이름과 인자를 그대로 실어 보내기만 한다. 그래서 도구가 늘어도
 * 이 파일과 프로토콜은 그대로다.
 *
 * 타임아웃을 걸지 않는다: 도구는 "즉시 반환" 규약을 지키고(오래 걸리는 일은 핸들만 돌려준 뒤
 * 이벤트 스트림으로 진행 상황을 흘린다), 메인이 죽으면 호스트도 함께 내려가므로 영원히 매달릴
 * 경로가 없다.
 */
export function callMain(workspaceId: string, tool: string, args: unknown): Promise<unknown> {
  const callId = randomUUID()
  return new Promise<unknown>((resolve, reject) => {
    pendingToolCalls.set(callId, { resolve, reject })
    post({ type: 'toolCall', callId, workspaceId, tool, args })
  })
}

function ensure(workspaceId: string, config: SessionConfig): ClaudeSession {
  const existing = sessions.get(workspaceId)
  if (existing) return existing

  const session = new ClaudeSession({
    cwd: config.cwd,
    repoPath: config.repoPath,
    mcpSettings: config.mcpSettings,
    model: config.model,
    effort: config.effort,
    fastMode: config.fastMode,
    permissionMode: config.permissionMode,
    autoCompact: config.autoCompact,
    autoResumeAfterRateLimit: config.autoResumeAfterRateLimit,
    peer: config.peer,
    resumeSessionId: config.resumeSessionId,
    additionalDirs: config.additionalDirs,
    // 워크스페이스마다 자기 것을 만든다 — 도구가 어느 워크스페이스에서 불렸는지는 이 클로저가
    // 유일한 근거다(모델이 인자로 지목할 수 없다는 뜻이기도 하다).
    wooiMcp: createWooiMcpServer(
      (tool, args) => callMain(workspaceId, tool, args),
      config.delegateBackends,
      config.canSwitchToAgentTeam
    ),
    delegateBackends: config.delegateBackends,
    canSwitchToAgentTeam: config.canSwitchToAgentTeam,
    // 위임 시점의 config 가 아니라 세션 생성 시점의 값을 쓴다 — 위임 도구는 세션과 함께 살고,
    // 모델·effort 를 바꾸면 어차피 매니저가 세션을 다시 연다.
    agentDefaults: (backend) => config.agentDefaults[backend] ?? { model: null, effort: null },
    emit: (event: ChatEvent) => post({ type: 'event', workspaceId, event }),
    persist: (item: ChatItem) => post({ type: 'persist', workspaceId, item }),
    requestPermission: (req) =>
      new Promise<PermissionDecision>((resolve) => {
        const requestId = randomUUID()
        pendingPermissions.set(requestId, resolve)
        const request: PermissionRequest = { requestId, workspaceId, ...req }
        post({ type: 'permissionRequest', request })
      }),
    onSessionId: (sessionId: string) => post({ type: 'sessionId', workspaceId, sessionId }),
    onRateLimit: (resetAt?: number) => post({ type: 'rateLimit', workspaceId, resetAt }),
    onPermissionMode: (mode) => post({ type: 'permissionMode', workspaceId, mode }),
    settleIdle: () => post({ type: 'settleIdle', workspaceId })
  })
  sessions.set(workspaceId, session)
  return session
}

function dispose(workspaceId: string): void {
  const session = sessions.get(workspaceId)
  if (session) {
    session.dispose()
    sessions.delete(workspaceId)
  }
}

/** 요청-응답 명령(runCommand·mcpAction·listCommands)을 실행하고 결과/오류를 reqId 로 회신한다. */
async function respond(reqId: string, fn: () => Promise<unknown> | unknown): Promise<void> {
  try {
    const data = await fn()
    post({ type: 'response', reqId, ok: true, data })
  } catch (err) {
    post({
      type: 'response',
      reqId,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

async function handle(msg: HostCommand): Promise<void> {
  switch (msg.type) {
    case 'send':
      ensure(msg.workspaceId, msg.config).send(msg.text, msg.images, { prefix: msg.prefix })
      break

    case 'interrupt':
      await sessions.get(msg.workspaceId)?.interrupt()
      break

    case 'setPermissionMode':
      await sessions.get(msg.workspaceId)?.setPermissionMode(msg.mode)
      break

    case 'dispose':
      dispose(msg.workspaceId)
      break

    case 'disposeAll':
      for (const session of sessions.values()) session.dispose()
      sessions.clear()
      for (const resolve of pendingPermissions.values()) resolve({ behavior: 'deny' })
      pendingPermissions.clear()
      // 세션이 다 사라졌으니 이 도구 호출의 결과를 받을 대화도 없다. 매달린 채 두면 종료가 막힌다.
      for (const { reject } of pendingToolCalls.values()) {
        reject(new Error('The session was closed before the tool finished.'))
      }
      pendingToolCalls.clear()
      break

    case 'permissionResponse': {
      const resolve = pendingPermissions.get(msg.requestId)
      if (resolve) {
        pendingPermissions.delete(msg.requestId)
        resolve(msg.decision)
      }
      break
    }

    case 'toolResult': {
      const pending = pendingToolCalls.get(msg.callId)
      if (pending) {
        pendingToolCalls.delete(msg.callId)
        if (msg.ok) pending.resolve(msg.data)
        else pending.reject(new Error(msg.error))
      }
      break
    }

    case 'runCommand':
      await respond(msg.reqId, async () => {
        // /rewind 는 살아 있는 세션의 체크포인트 목록(라이브 Query 가 아님)을 읽는다.
        if (msg.kind === 'rewind') {
          return {
            kind: 'rewind',
            checkpoints: sessions.get(msg.workspaceId)?.getCheckpoints() ?? []
          }
        }
        // /permissions 는 설정 파일을 읽어 현재 모드와 함께 돌려준다(Query 불필요).
        if (msg.kind === 'permissions') {
          return readPermissions(msg.config)
        }
        const live = sessions.get(msg.workspaceId)?.liveQuery
        const result = live
          ? await runCommandOn(msg.kind, live)
          : await runCommandShortLived(
              msg.kind,
              msg.config.cwd,
              msg.config.repoPath,
              msg.config.mcpSettings
            )
        invalidateAfterReload(msg.kind, msg.config.cwd)
        return result
      })
      break

    case 'rewindAction':
      await respond(msg.reqId, async () => {
        const session = sessions.get(msg.workspaceId)
        if (!session) {
          return {
            canRewind: false,
            error:
              'No live session to rewind. Send a message first, then rewind within the same session.'
          }
        }
        return session.rewind(msg.userMessageId)
      })
      break

    case 'mcpAction':
      await respond(msg.reqId, () => {
        const session = ensure(msg.workspaceId, msg.config)
        return runMcpAction(msg.action, msg.serverName, session.ensureLiveQuery())
      })
      break

    case 'refreshUsage':
      await respond(msg.reqId, async () => {
        // 라이브 Query 를 가진 세션을 호스트가 직접 고른다. 있으면 제어 채널 왕복 한 번으로 끝나
        // 사실상 공짜다 — 그래서 이 경로만으로 도는 주기 폴링은 아무 세션도 안 돌 때 비용이 0 이다.
        for (const session of sessions.values()) {
          const live = session.liveQuery
          if (!live) continue
          const result = await runCommandOn('usage', live)
          return result.kind === 'usage' ? result.usage : null
        }
        // 라이브 세션이 없다. 사용자가 명시적으로 갱신을 눌렀을 때만(fallback 제공) 단명 쿼리를 띄운다.
        if (!msg.fallback) return null
        const result = await runCommandShortLived(
          'usage',
          msg.fallback.cwd,
          msg.fallback.repoPath,
          msg.fallback.mcpSettings
        )
        return result.kind === 'usage' ? result.usage : null
      })
      break

    case 'listCommands':
      await respond(msg.reqId, () => listSlashCommands(msg.cwd, msg.team))
      break

    case 'sideQuestion':
      try {
        await askSideQuestion({
          cwd: msg.cwd,
          resumeSessionId: msg.resumeSessionId,
          model: msg.model,
          effort: msg.effort,
          question: msg.question,
          onDelta: (text) =>
            post({
              type: 'sideQuestion',
              update: {
                workspaceId: msg.workspaceId,
                id: msg.id,
                phase: 'delta',
                text: clampText(text)
              }
            })
        })
        post({
          type: 'sideQuestion',
          update: { workspaceId: msg.workspaceId, id: msg.id, phase: 'done' }
        })
      } catch (err) {
        post({
          type: 'sideQuestion',
          update: {
            workspaceId: msg.workspaceId,
            id: msg.id,
            phase: 'error',
            message: err instanceof Error ? err.message : String(err)
          }
        })
      }
      break
  }
}

port.on('message', (e: { data: HostCommand }) => {
  void handle(e.data).catch((err) => log.error('agent-host command failed', err))
})

log.info('agent-host ready')
