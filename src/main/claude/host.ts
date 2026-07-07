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

function ensure(workspaceId: string, config: SessionConfig): ClaudeSession {
  const existing = sessions.get(workspaceId)
  if (existing) return existing

  const session = new ClaudeSession({
    cwd: config.cwd,
    repoPath: config.repoPath,
    model: config.model,
    effort: config.effort,
    permissionMode: config.permissionMode,
    autoCompact: config.autoCompact,
    resumeSessionId: config.resumeSessionId,
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
      ensure(msg.workspaceId, msg.config).send(msg.text, msg.images)
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
      break

    case 'permissionResponse': {
      const resolve = pendingPermissions.get(msg.requestId)
      if (resolve) {
        pendingPermissions.delete(msg.requestId)
        resolve(msg.decision)
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
          : await runCommandShortLived(msg.kind, msg.config.cwd, msg.config.repoPath)
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

    case 'listCommands':
      await respond(msg.reqId, () => listSlashCommands(msg.cwd))
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
