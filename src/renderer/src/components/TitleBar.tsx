import { useEffect, useRef, useState } from 'react'
import { Settings, Loader2, ShieldQuestion, BellDot, Square } from 'lucide-react'
import { useStore } from '../store'
import { summarizePermission } from '../lib/permission'
import type { PermissionRequest } from '@shared/types'
import Logo from './Logo'

export default function TitleBar({
  onOpenSettings
}: {
  onOpenSettings: () => void
}): React.JSX.Element {
  return (
    <div className="drag h-11 shrink-0 flex items-center justify-between bg-[var(--bg)] border-b border-[var(--border)] pl-20 pr-3">
      <div className="flex items-center gap-2 text-base font-semibold tracking-tight text-neutral-200">
        <Logo size={18} />
        Ditto
        <span className="text-neutral-600 font-normal">· AI coding agent orchestrator</span>
      </div>
      <div className="flex items-center gap-2">
        <AttentionCluster />
        <button
          data-tour="settings"
          onClick={onOpenSettings}
          className="no-drag h-7 w-7 grid place-items-center rounded-md text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-200"
          title="Settings"
        >
          <Settings size={16} />
        </button>
      </div>
    </div>
  )
}

/**
 * 타이틀바 우측의 전역 주의(attention) 표시.
 * 워크스페이스 선택 여부와 무관하게 항상 보여, 빈 화면(Overview)에서도
 * 실행 현황 확인·일괄 정지·권한 처리·미확인 점프를 한곳에서 할 수 있게 한다.
 */
function AttentionCluster(): React.JSX.Element | null {
  const app = useStore((s) => s.app)
  const unread = useStore((s) => s.unread)
  const permissions = useStore((s) => s.permissions)
  const selectedId = useStore((s) => s.selectedWorkspaceId)
  const nextUnreadId = useStore((s) => s.nextUnreadId)
  const selectWorkspace = useStore((s) => s.selectWorkspace)
  const stopAll = useStore((s) => s.stopAll)
  const confirm = useStore((s) => s.confirm)
  const [queueOpen, setQueueOpen] = useState(false)

  if (!app) return null

  const live = new Set(app.workspaces.filter((w) => !w.archived).map((w) => w.id))
  const runningCount = app.workspaces.filter((w) => !w.archived && w.status === 'running').length
  const pendingRequests = permissions.filter((p) => live.has(p.workspaceId))
  const pendingCount = new Set(pendingRequests.map((p) => p.workspaceId)).size
  const unreadCount = Object.keys(unread).filter(
    (id) => unread[id] && live.has(id) && id !== selectedId
  ).length

  if (runningCount === 0 && pendingCount === 0 && unreadCount === 0) return null

  const onStopAll = async (): Promise<void> => {
    const ok = await confirm({
      title: `Stop all ${runningCount} running session${runningCount > 1 ? 's' : ''}?`,
      body: 'Interrupts the current turn in every running workspace. Queued messages are not removed.',
      confirmLabel: 'Stop all',
      danger: true
    })
    if (ok) void stopAll()
  }

  return (
    <div className="no-drag flex items-center gap-1.5 mr-1">
      {runningCount > 0 && (
        <>
          <span
            className="flex items-center gap-1 h-7 px-2 rounded-md text-xs text-[var(--info-300)]/90 bg-[var(--info-500)]/10 border border-[var(--info-500)]/20"
            title={`${runningCount} session${runningCount > 1 ? 's' : ''} running`}
          >
            <Loader2 size={12} className="animate-spin" />
            {runningCount}
          </span>
          <button
            onClick={onStopAll}
            className="flex items-center gap-1 h-7 px-2 rounded-md text-xs text-[var(--danger-300)] bg-[var(--danger-500)]/10 border border-[var(--danger-500)]/20 hover:bg-[var(--danger-500)]/20"
            title="Stop the current turn in every running session"
          >
            <Square size={11} fill="currentColor" />
            Stop all
          </button>
        </>
      )}

      {pendingCount > 0 && (
        <div className="relative">
          <button
            onClick={() => setQueueOpen((v) => !v)}
            className="flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-[var(--warning-500)]/90 text-black text-xs font-medium hover:bg-[var(--warning-400)]"
            title="Sessions waiting for your permission"
          >
            <ShieldQuestion size={13} />
            Needs input ({pendingCount})
          </button>
          {queueOpen && (
            <PermissionQueue requests={pendingRequests} onClose={() => setQueueOpen(false)} />
          )}
        </div>
      )}

      {unreadCount > 0 && (
        <button
          onClick={() => {
            const id = nextUnreadId()
            if (id) void selectWorkspace(id)
          }}
          className="flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-[var(--info-600)]/90 text-white text-xs font-medium hover:bg-[var(--info-500)]"
          title="Jump to the next session with a completed response"
        >
          <BellDot size={13} />
          Unread ({unreadCount})
        </button>
      )}
    </div>
  )
}

/**
 * "Needs input" 버튼 아래로 펼쳐지는 권한 대기 큐.
 * 여러 세션이 동시에 권한을 기다릴 때, 세션을 일일이 열지 않고 한곳에서
 * 허용/거부하거나 해당 세션으로 점프할 수 있다.
 */
function PermissionQueue({
  requests,
  onClose
}: {
  requests: PermissionRequest[]
  onClose: () => void
}): React.JSX.Element {
  const app = useStore((s) => s.app)
  const dismissPermission = useStore((s) => s.dismissPermission)
  const selectWorkspace = useStore((s) => s.selectWorkspace)
  const prStatus = useStore((s) => s.prStatus)
  const ref = useRef<HTMLDivElement>(null)

  // 바깥 클릭·Esc 로 닫는다.
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const wsName = (id: string): string => {
    const ws = app?.workspaces.find((w) => w.id === id)
    return prStatus[id]?.title || ws?.name || 'workspace'
  }

  const respond = (req: PermissionRequest, behavior: 'allow' | 'deny'): void => {
    // AskUserQuestion 은 답을 골라야 하는 도구라 큐에서 바로 처리하지 않고 세션으로 보낸다.
    if (req.toolName === 'AskUserQuestion') {
      void selectWorkspace(req.workspaceId)
      onClose()
      return
    }
    void window.api.permission.respond(
      req.requestId,
      behavior === 'allow' ? { behavior: 'allow', rememberForSession: false } : { behavior: 'deny' }
    )
    dismissPermission(req.requestId)
  }

  const denyAll = (): void => {
    for (const req of requests) {
      if (req.toolName === 'AskUserQuestion') continue
      void window.api.permission.respond(req.requestId, { behavior: 'deny' })
      dismissPermission(req.requestId)
    }
    onClose()
  }

  return (
    <div
      ref={ref}
      className="absolute top-full right-0 mt-1.5 w-[22rem] max-h-[70vh] overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--bg-3)] shadow-2xl z-30"
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--surface-2)] sticky top-0 bg-[var(--bg-3)]">
        <ShieldQuestion size={13} className="text-[var(--warning-400)] shrink-0" />
        <span className="text-xs font-medium text-[var(--warning-200)]">
          Permission queue ({requests.length})
        </span>
        {requests.length > 1 && (
          <button
            onClick={denyAll}
            className="ml-auto text-xs px-2 py-0.5 rounded text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-200"
            title="Deny every request in the queue"
          >
            Deny all
          </button>
        )}
      </div>
      <div className="py-1">
        {requests.map((req) => {
          const isQuestion = req.toolName === 'AskUserQuestion'
          const summary = summarizePermission(req)
          return (
            <div key={req.requestId} className="px-3 py-2 hover:bg-[var(--surface)]">
              <button
                onClick={() => {
                  void selectWorkspace(req.workspaceId)
                  onClose()
                }}
                className="block w-full text-left"
                title="Open this session"
              >
                <div className="flex items-center gap-1.5 text-sm text-neutral-200 truncate">
                  <span className="truncate font-medium">{wsName(req.workspaceId)}</span>
                  <span className="text-neutral-600 shrink-0">·</span>
                  <span className="text-neutral-400 shrink-0">
                    {req.displayName ?? req.toolName}
                  </span>
                </div>
                {summary && (
                  <div className="mt-0.5 text-xs text-neutral-500 truncate">{summary}</div>
                )}
              </button>
              <div className="mt-1.5 flex items-center gap-1.5">
                {isQuestion ? (
                  <button
                    onClick={() => {
                      void selectWorkspace(req.workspaceId)
                      onClose()
                    }}
                    className="text-xs px-2 py-1 rounded-md bg-[var(--warning-500)]/90 text-black font-medium hover:bg-[var(--warning-400)]"
                  >
                    Answer in session
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => respond(req, 'deny')}
                      className="text-xs px-2 py-1 rounded-md text-neutral-300 hover:bg-[var(--surface-2)]"
                    >
                      Deny
                    </button>
                    <button
                      onClick={() => respond(req, 'allow')}
                      className="text-xs px-2.5 py-1 rounded-md bg-[var(--warning-500)]/90 text-black font-medium hover:bg-[var(--warning-400)]"
                    >
                      Allow
                    </button>
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
