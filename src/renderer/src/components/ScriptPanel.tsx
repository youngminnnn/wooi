import { useEffect, useState } from 'react'
import {
  Play,
  Square,
  X,
  ExternalLink,
  AlertTriangle,
  Check,
  Settings2,
  SquareArrowOutUpRight
} from 'lucide-react'
import { useStore, scriptKey } from '../store'
import { openRepoSettings } from '../lib/repoSettings'
import type { ScriptKind } from '@shared/types'

export default function ScriptPanel({
  workspaceId,
  onClose,
  fill
}: {
  workspaceId: string
  /** 인라인 패널에서만 준다 — 별도 창으로 분리했을 때는 창을 닫는 것이 곧 닫기다. */
  onClose?: () => void
  /** 별도 창에서 창 전체를 채울 때. 인라인일 때는 대화 아래 고정 높이로 붙는다. */
  fill?: boolean
}): React.JSX.Element {
  const app = useStore((s) => s.app)!
  const ws = app.workspaces.find((w) => w.id === workspaceId)!
  const repo = app.repos.find((r) => r.id === ws.repoId)!
  const output = useStore((s) => s.scriptOutput)
  const statuses = useStore((s) => s.scriptStatus[workspaceId]) ?? []
  const refreshStatus = useStore((s) => s.refreshScriptStatus)
  const seedOutput = useStore((s) => s.seedScriptOutput)
  const detachPane = useStore((s) => s.detachPane)
  const [tab, setTab] = useState<ScriptKind>('dev')

  const command = tab === 'setup' ? repo.setupScript : repo.devScript
  const status = statuses.find((s) => s.kind === tab)
  const running = status?.state === 'running'
  // setup 은 생성 직후 자동 실행되는 일회성 초기화 스크립트다. 성공한 걸 다시 돌리면 재설치·재시드처럼
  // 무의미하거나 파괴적일 수 있으므로, 실패했을 때만 재실행을 허용한다. 결과는 workspace 에 영속되어
  // (ws.setupState) 앱을 재시작해도 유지된다 — 라이브 프로세스 상태가 아니라 이 값으로 판별한다.
  const setupSucceeded = tab === 'setup' && ws.setupState === 'success'
  const setupFailed = tab === 'setup' && ws.setupState === 'failed'
  const out = output[scriptKey(workspaceId, tab)] ?? ''
  // 이 workspace 에 배정된 dev 포트. 스크립트에는 $PORT/$WOOI_DEV_PORT 로 주입된다.
  const port = ws.devPort
  // 포트 충돌(다른 프로세스가 이미 점유)을 출력에서 감지해 사용자에게 알린다 — 병렬 dev 서버에서
  // 흔하며, 그냥 두면 로그에 묻혀 "왜 안 뜨지" 로 이어진다.
  const portInUse = /EADDRINUSE|address already in use|port .* is already in use/i.test(out)

  // 이 창(또는 패널)이 뜨기 전에 이미 흘러간 로그를 main 의 꼬리 버퍼에서 한 번 채운다.
  // 그러지 않으면 돌고 있는 dev 서버를 열어 놓고도 "No output yet." 만 보인다.
  useEffect(() => {
    void seedOutput(workspaceId, tab)
  }, [seedOutput, workspaceId, tab])

  // Esc 로도 패널을 닫는다. 패널 안에 포커스가 없어도(출력 스크롤·다른 곳 클릭) 먹히도록 window
  // 레벨에서 받되, Esc 를 이미 쓰고 있는 UI 가 떠 있으면 양보한다 — 그쪽이 닫히면서 뒤의 패널까지
  // 같이 사라지면 "왜 두 개가 닫히지" 가 된다.
  useEffect(() => {
    if (!onClose) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const s = useStore.getState()
      // 확인 대화상자 / 권한·질문 프롬프트(둘 다 permissions 에 쌓인다)가 우선.
      if (s.confirmState || s.permissions.some((p) => p.workspaceId === workspaceId)) return
      // 모달(QuickSwitcher 포함)·팝오버 메뉴가 열려 있으면 그쪽이 Esc 의 주인이다.
      if (document.querySelector('[role="dialog"], [role="menu"]')) return
      // 대화 검색창·이름 편집처럼 Esc 로 자기 UI 를 물리는 input 도 양보한다. 메시지 입력창
      // (textarea)은 메뉴가 없을 때 Esc 를 쓰지 않으므로 그대로 닫는다.
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.isContentEditable)) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, workspaceId])

  const run = (): void => {
    void window.api.script.run(workspaceId, tab).then(() => refreshStatus(workspaceId))
  }
  const stop = (): void => {
    void window.api.script.stop(workspaceId, tab).then(() => refreshStatus(workspaceId))
  }

  return (
    <div
      className={
        fill
          ? 'h-full bg-[var(--bg-2)] flex flex-col min-h-0'
          : 'shrink-0 h-64 border-t border-[var(--border)] bg-[var(--bg-2)] flex flex-col'
      }
    >
      <div className="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-[var(--border)]">
        {(['dev', 'setup'] as ScriptKind[]).map((kind) => {
          const active = tab === kind
          const isRunning = statuses.find((s) => s.kind === kind)?.state === 'running'
          return (
            <button
              key={kind}
              onClick={() => setTab(kind)}
              className={
                'flex items-center gap-1.5 text-sm px-2.5 py-1 rounded-md ' +
                (active
                  ? 'bg-[var(--surface-2)] text-neutral-100'
                  : 'text-neutral-400 hover:text-neutral-200')
              }
            >
              {kind === 'dev' ? 'Dev' : 'Setup'}
              {isRunning && <span className="h-1.5 w-1.5 rounded-full bg-[var(--info-400)]" />}
            </button>
          )
        })}

        <div className="flex-1" />

        {!command.trim() ? (
          // 패널을 열었는데 명령이 없다는 건 "이 기능을 쓰려던 참"이라는 뜻이다. 예전에는
          // 설정의 위치만 알려 주는 클릭 불가 회색 문구여서, 사용자가 스스로 사이드바 톱니를
          // 찾아내야 했다 — 그 자리를 그대로 진입점으로 만든다.
          <button
            onClick={() => openRepoSettings(repo.id)}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded-md text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100"
            title={`Set the ${tab} command for “${repo.name}”`}
          >
            <Settings2 size={11} />
            Set a {tab} command
          </button>
        ) : running ? (
          <button
            onClick={stop}
            className="flex items-center gap-1 text-sm px-2 py-1 rounded-md text-[var(--danger-400)] hover:bg-[var(--danger-500)]/15"
          >
            <Square size={12} fill="currentColor" /> Stop
          </button>
        ) : setupSucceeded ? (
          <span className="flex items-center gap-1 text-xs text-[var(--success-400)]">
            <Check size={12} /> Setup complete
          </span>
        ) : (
          <button
            onClick={run}
            className="flex items-center gap-1 text-sm px-2 py-1 rounded-md text-[var(--success-400)] hover:bg-[var(--success-500)]/15"
          >
            <Play size={12} fill="currentColor" /> {setupFailed ? 'Retry' : 'Run'}
          </button>
        )}

        {onClose && (
          <>
            {/* 듀얼 모니터에서 로그를 옆 화면에 띄워 두기 위한 분리 버튼. */}
            <button
              onClick={() => detachPane('scripts')}
              aria-label="Open scripts panel in a separate window"
              title="Open in a separate window"
              className="h-6 w-6 grid place-items-center rounded-md text-neutral-500 hover:bg-[var(--surface-2)] hover:text-neutral-200"
            >
              <SquareArrowOutUpRight size={13} />
            </button>
            <button
              onClick={onClose}
              aria-label="Close scripts panel"
              className="h-6 w-6 grid place-items-center rounded-md text-neutral-500 hover:bg-[var(--surface-2)] hover:text-neutral-200"
            >
              <X size={14} />
            </button>
          </>
        )}
      </div>

      {command.trim() && (
        <div className="px-3 pt-1.5 flex items-center gap-2 text-xs text-neutral-600 font-mono">
          <span className="truncate">$ {command}</span>
          {tab === 'dev' && port != null && (
            <span className="ml-auto shrink-0 flex items-center gap-2 not-italic">
              <span
                className="text-neutral-500"
                title="Unique port for this workspace, injected as $PORT / $WOOI_DEV_PORT"
              >
                PORT={port}
              </span>
              <button
                onClick={() => void window.api.openExternal(`http://localhost:${port}`)}
                className="flex items-center gap-1 text-neutral-400 hover:text-neutral-200"
                title={`Open http://localhost:${port}`}
              >
                <ExternalLink size={11} />
                open
              </button>
            </span>
          )}
        </div>
      )}

      {tab === 'dev' && portInUse && (
        <div className="mx-3 mt-1.5 flex items-start gap-1.5 rounded-md border border-[var(--warning-500)]/30 bg-[var(--warning-500)]/10 px-2.5 py-1.5 text-xs text-[var(--warning-200)]">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[var(--warning-400)]" />
          <span>
            Port already in use. Make your dev command bind to{' '}
            <span className="font-mono">$PORT</span>
            {port != null ? ` (${port})` : ''} so parallel dev processes don&rsquo;t collide — e.g.{' '}
            <span className="font-mono">vite --port $PORT</span> or{' '}
            <span className="font-mono">PORT=$PORT npm start</span>.
          </span>
        </div>
      )}
      {command.trim() ? (
        <pre className="flex-1 overflow-auto px-3 py-2 text-xs font-mono text-neutral-400 whitespace-pre-wrap">
          {out || 'No output yet.'}
        </pre>
      ) : (
        // 빈 패널은 그 자체로 설명 기회다 — 이 탭이 무엇을 하는 건지 모르면 위의 버튼을 누를
        // 이유도 없다. 리포별로 설정된다는 사실을 여기서 한 줄로 못박는다.
        <div className="flex-1 overflow-auto px-3 py-2 text-xs text-neutral-500 leading-relaxed">
          {tab === 'dev' ? (
            <>
              A <b className="text-neutral-400">dev command</b> is set once per repository and runs
              in this workspace&rsquo;s worktree, with a unique{' '}
              <span className="font-mono text-neutral-400">$PORT</span> so parallel dev servers
              don&rsquo;t collide. Start and stop it here or with{' '}
              <kbd className="font-medium text-neutral-400">⇧⌘D</kbd>.
            </>
          ) : (
            <>
              A <b className="text-neutral-400">setup command</b> is set once per repository and
              runs automatically right after each new workspace is created — e.g.{' '}
              <span className="font-mono text-neutral-400">npm install</span>.
            </>
          )}
        </div>
      )}
    </div>
  )
}
