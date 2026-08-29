import { useEffect } from 'react'
import { ArrowLeftToLine } from 'lucide-react'
import type { PaneKind } from '@shared/types'
import { useStore } from './store'
import { applyTheme } from './lib/theme'
import Overview from './components/Overview'
import WorkArea from './components/WorkArea'
import ScriptPanel from './components/ScriptPanel'
import GithubConnectModal from './components/GithubConnectModal'
import ErrorBoundary from './components/ErrorBoundary'
import Toaster from './components/Toaster'
import ConfirmDialog from './components/ConfirmDialog'
import Logo from './components/Logo'

const TITLE: Record<PaneKind, string> = {
  work: 'Work panel',
  scripts: 'Project scripts',
  overview: 'Overview'
}

/**
 * 별도 창으로 떼어 낸 패널의 루트.
 *
 * 같은 렌더러 번들이지만 App 대신 이걸 그린다(창의 역할은 URL 쿼리로 온다 — [[paneWindow]]).
 * 사이드바·대화·모달을 뺀 패널 하나만 담고, 보여 줄 워크스페이스는 메인 창의 선택을 따라간다.
 * 창을 닫으면 패널은 메인 창의 제자리로 돌아간다.
 */
export default function PaneApp({
  kind,
  initialWorkspaceId
}: {
  kind: PaneKind
  initialWorkspaceId: string | null
}): React.JSX.Element {
  const ready = useStore((s) => s.ready)
  const initPane = useStore((s) => s.initPane)
  const app = useStore((s) => s.app)
  const workspaceId = useStore((s) => s.selectedWorkspaceId)

  useEffect(() => {
    void initPane(initialWorkspaceId)
  }, [initPane, initialWorkspaceId])

  // 테마는 메인 창과 같은 설정을 따른다(첫 페인트 전 캐시 적용은 main.tsx 의 bootstrapTheme).
  const theme = app?.settings.theme
  useEffect(() => {
    if (theme) applyTheme(theme)
  }, [theme])

  const workspace = app?.workspaces.find((w) => w.id === workspaceId && !w.archived) ?? null
  // 현황판은 워크스페이스에 매이지 않는다 — 전체를 보는 창이라 제목에 세션 이름을 붙이지 않고,
  // 메인 창이 어디에 있든(개요 화면이든 세션 안이든) 항상 그릴 수 있다.
  const global = kind === 'overview'
  const name = global ? null : workspace?.displayName?.trim() || workspace?.name || null

  return (
    <div className="h-full flex flex-col bg-[var(--bg)]">
      <div className="drag h-10 shrink-0 flex items-center gap-2 pl-20 pr-2 border-b border-[var(--border)]">
        <span className="text-sm font-medium text-neutral-300">{TITLE[kind]}</span>
        {name && (
          <>
            <span className="text-neutral-600">·</span>
            <span className="text-sm text-neutral-500 truncate">{name}</span>
          </>
        )}
        <div className="flex-1" />
        <button
          onClick={() => void window.api.pane.close(kind)}
          className="no-drag flex items-center gap-1.5 h-7 px-2 rounded-md text-xs text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100"
          title="Move this panel back into the main window"
        >
          <ArrowLeftToLine size={13} />
          {global ? 'Close this window' : 'Return to main window'}
        </button>
      </div>

      <div className="flex-1 min-h-0">
        {!ready ? (
          <div className="h-full grid place-items-center text-neutral-500">
            <div className="flex flex-col items-center gap-3">
              <Logo size={32} />
              <span className="text-sm">Loading…</span>
            </div>
          </div>
        ) : global ? (
          <ErrorBoundary label={TITLE[kind]}>
            <Overview />
          </ErrorBoundary>
        ) : !workspace ? (
          // 메인 창이 워크스페이스를 벗어났거나(개요 화면·리뷰) 이 워크스페이스가 사라진 경우.
          <div className="h-full grid place-items-center px-8 text-center text-sm text-neutral-500">
            Select a workspace in the main window and this panel will follow it.
          </div>
        ) : (
          <ErrorBoundary label={TITLE[kind]}>
            {kind === 'work' ? (
              <WorkArea key={workspace.id} workspace={workspace} />
            ) : (
              // 분리한 창에서는 패널이 창 전체를 채운다(닫기는 창의 "Return to main window").
              <ScriptPanel key={workspace.id} workspaceId={workspace.id} fill />
            )}
          </ErrorBoundary>
        )}
      </div>

      {/* 파일 브라우저의 토스트·확인 대화상자와 Check 탭의 gh 연결 모달은 이 창에서도 필요하다. */}
      <GithubConnectModalIfNeeded />
      <Toaster />
      <ConfirmDialog />
    </div>
  )
}

function GithubConnectModalIfNeeded(): React.JSX.Element | null {
  const open = useStore((s) => s.githubGate !== null)
  return open ? <GithubConnectModal /> : null
}
