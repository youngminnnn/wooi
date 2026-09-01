import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  CircleAlert,
  ExternalLink,
  Loader2,
  MousePointerClick,
  Trash2,
  RotateCw,
  TriangleAlert,
  X
} from 'lucide-react'
import { PREVIEW_PARTITION } from '@shared/types'
import { isLocalUrl, normalizeInputUrl } from '@shared/devUrl'
import type { PreviewIssue } from '@shared/previewIssues'
import { useStore } from '../store'
import { isPaneWindow } from '../lib/paneWindow'
import type { PreviewWebview, WebviewFailLoadEvent, WebviewNavigateEvent } from '../lib/webview'
import type { Workspace } from '@shared/types'

/**
 * 게스트에게 넘길 webPreferences. main 의 will-attach-webview 가 어차피 같은 값을 강제하지만
 * ([[main/preview]]) 여기에도 적어 둔다 — 태그만 읽는 사람에게도 "이 뷰는 격리돼 있다" 가
 * 보여야 하고, 둘 중 하나가 지워져도 나머지가 남는다.
 */
const GUEST_PREFS = 'contextIsolation=yes,sandbox=yes,nodeIntegration=no,javascript=yes'

/** 사용자가 이동을 끊었을 때(-3 ABORTED) 나는 코드. 실패로 보여 줄 일이 아니다. */
const ERR_ABORTED = -3

/**
 * 게스트를 붙이기 위한 최초 `src`. **반드시 있어야 한다** — Electron 의 webview 구현은 `src` 가
 * 비어 있으면 `createGuest()` 자체를 부르지 않아(web-view-attributes 의 `SrcAttribute.parse`),
 * 게스트가 영영 안 생기고 `loadURL`·`getWebContentsId` 가 "not attached" 로 던진다.
 *
 * 그러면서도 **상수여야 한다**. 게스트가 이동하면 Electron 이 `src` DOM 속성을 현재 주소로
 * 바꿔 놓는데, React 가 렌더할 때마다 자기 prop 값을 다시 써 넣으면 그때마다 페이지가 처음으로
 * 되감긴다. prop 이 늘 같은 값이면 React 는 속성을 건드리지 않는다.
 */
const BOOT_URL = 'about:blank'

/**
 * Preview 탭 — 이 워크트리가 띄운 dev 서버를 앱 안에서 본다.
 *
 * 범용 브라우저가 아니다. 여러 워크스페이스의 dev 서버를 오가며 "지금 이 브랜치의 화면" 을
 * 보는 것이 전부라, 주소 하나·앞뒤·새로고침·캡처만 있다. 탭도 북마크도 없다.
 *
 * 주소는 mount 시 한 번만 `loadURL` 로 밀어 넣고, 이후 이동도 전부 명령형으로 한다. `src`
 * prop 에 매달면 상태 방송(evtState)이 한 번 올 때마다 prop 이 같은 값으로 다시 흘러 들어와
 * 보고 있던 페이지가 처음부터 다시 로드된다 — 폼에 뭘 입력하던 중이었다면 그게 날아간다.
 */
export default function PreviewPanel({
  workspace,
  navTarget,
  active
}: {
  workspace: Workspace
  /** WorkPanel 이 넘기는 이동 명령("Open in Preview"). seq 가 바뀔 때만 이동한다. */
  navTarget: { url: string; seq: number } | null
  /** 지금 이 탭이 보이는지. 감춰져 있는 동안에는 캡처하지 않는다. */
  active: boolean
}): React.JSX.Element {
  const viewRef = useRef<PreviewWebview | null>(null)
  const pushToast = useStore((s) => s.pushToast)

  // 게스트가 붙기 전에는 loadURL 이 던진다. dom-ready 를 본 뒤에만 명령을 보낸다.
  const [ready, setReady] = useState(false)
  // 화면에 보이는 주소(게스트가 실제로 있는 곳). 편집 중에는 draft 가 이걸 가린다.
  const [url, setUrl] = useState(workspace.previewUrl ?? '')
  const [draft, setDraft] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [nav, setNav] = useState({ back: false, forward: false })
  const [capturing, setCapturing] = useState(false)
  // 요소 픽커가 켜져 있는 동안(사용자가 게스트에서 요소를 고르는 중).
  const [picking, setPicking] = useState(false)
  // 콘솔·네트워크 문제. 개수만 방송되므로(폭주 방지) 목록은 패널을 열 때 당겨 온다.
  const [issueCount, setIssueCount] = useState({ errors: 0, warnings: 0 })
  const [issues, setIssues] = useState<PreviewIssue[] | null>(null)

  /** 첫 로드 주소. mount 이후 prop 이 바뀌어도 다시 로드하지 않도록 처음 값을 고정한다. */
  const initialUrl = useRef(navTarget?.url ?? workspace.previewUrl ?? '')
  /** 이미 처리한 이동 명령의 seq. 같은 명령을 두 번 따라가지 않는다. */
  const handledSeq = useRef<number | null>(null)

  /** 주소를 워크스페이스에 적어 둔다 — 다음에 이 탭을 열면 여기서 시작한다. */
  const remember = (next: string): void => {
    if (!next || next === 'about:blank') return
    void window.api.preview.setUrl(workspace.id, next)
  }

  /** 게스트를 이 주소로 보낸다(붙기 전이면 dom-ready 가 대신 처리한다). */
  const navigate = (next: string): void => {
    setUrl(next)
    setDraft(null)
    setFailure(null)
    initialUrl.current = next
    const view = viewRef.current
    if (view && ready) void view.loadURL(next).catch(() => setFailure('Could not load that URL.'))
  }

  // 게스트 이벤트 구독. webview 의 이벤트는 React 합성 이벤트가 아니라 DOM 커스텀 이벤트라
  // addEventListener 로 받는다.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return

    const syncNav = (): void => {
      // 게스트가 사라지는 중이면 이 호출들이 던진다 — 상태 갱신 하나 때문에 패널이 죽지 않게 감싼다.
      try {
        setNav({ back: view.canGoBack(), forward: view.canGoForward() })
      } catch {
        setNav({ back: false, forward: false })
      }
    }

    const onDomReady = (): void => {
      setReady(true)
      syncNav()
      // 실제 페이지가 로드되기 **전**(about:blank 단계)에 등록해야 첫 콘솔 줄부터 잡힌다.
      try {
        void window.api.preview.watchIssues(workspace.id, view.getWebContentsId())
      } catch {
        /* 게스트가 이미 사라졌다. */
      }
    }
    const onStart = (): void => {
      setLoading(true)
      setFailure(null)
    }
    const onStop = (): void => {
      setLoading(false)
      syncNav()
    }
    const onNavigate = (e: Event): void => {
      const next = (e as WebviewNavigateEvent).url
      // 부팅용 about:blank 는 사용자가 간 곳이 아니다 — 주소창에 비치지도, 기억되지도 않게 한다.
      if (!next || next === BOOT_URL) return
      setUrl(next)
      setDraft(null)
      syncNav()
      remember(next)
    }
    const onFail = (e: Event): void => {
      const { errorCode, errorDescription, isMainFrame } = e as WebviewFailLoadEvent
      // 서브리소스 실패(이미지 404 등)로 화면 전체를 에러로 덮지 않는다.
      if (!isMainFrame || errorCode === ERR_ABORTED) return
      setLoading(false)
      setFailure(errorDescription || `Load failed (${errorCode})`)
    }

    view.addEventListener('dom-ready', onDomReady)
    view.addEventListener('did-start-loading', onStart)
    view.addEventListener('did-stop-loading', onStop)
    view.addEventListener('did-navigate', onNavigate)
    view.addEventListener('did-navigate-in-page', onNavigate)
    view.addEventListener('did-fail-load', onFail)
    return () => {
      view.removeEventListener('dom-ready', onDomReady)
      view.removeEventListener('did-start-loading', onStart)
      view.removeEventListener('did-stop-loading', onStop)
      view.removeEventListener('did-navigate', onNavigate)
      view.removeEventListener('did-navigate-in-page', onNavigate)
      view.removeEventListener('did-fail-load', onFail)
    }
    // 구독은 mount 당 한 번. workspace 가 바뀌면 WorkPanel 이 key 로 통째로 새로 만든다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 게스트가 붙는 순간 첫 주소를 밀어 넣는다(`src` 를 쓰지 않는 이유는 컴포넌트 주석 참고).
  useEffect(() => {
    const view = viewRef.current
    if (!ready || !view || !initialUrl.current) return
    // 첫 로드는 한 번뿐이다 — 이후 이동은 navigate() 가 직접 한다(그래서 deps 는 ready 뿐이다).
    void view.loadURL(initialUrl.current).catch(() => setFailure('Could not load that URL.'))
  }, [ready])

  // "Open in Preview" 로 들어온 이동 명령.
  useEffect(() => {
    if (!navTarget || handledSeq.current === navTarget.seq) return
    handledSeq.current = navTarget.seq
    navigate(navTarget.url)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navTarget, ready])

  // 개수 방송 구독. 목록은 사용자가 패널을 열 때만 당겨 온다(방송에 목록을 싣지 않는 이유는
  // [[main/previewIssues]] 참고 — 폭주하는 dev 로그가 IPC 홍수가 된다).
  useEffect(() => {
    return window.api.preview.onIssues((e) => {
      if (e.workspaceId !== workspace.id) return
      setIssueCount({ errors: e.errors, warnings: e.warnings })
      // 목록을 펼쳐 둔 채라면 새로 들어온 것까지 보이게 갱신한다.
      setIssues((prev) => {
        if (prev === null) return prev
        void window.api.preview.listIssues(workspace.id).then(setIssues)
        return prev
      })
    })
  }, [workspace.id])

  // 패널이 사라지면 수집도 멈춘다 — 안 그러면 죽은 게스트의 리스너가 main 에 남는다.
  const unwatchRef = useRef<() => void>(() => {})
  unwatchRef.current = () => {
    const view = viewRef.current
    if (!view) return
    try {
      void window.api.preview.unwatchIssues(view.getWebContentsId())
    } catch {
      /* 게스트가 이미 사라졌다 — main 의 destroyed 처리가 알아서 치운다. */
    }
  }
  useEffect(() => () => unwatchRef.current(), [])

  const toggleIssues = (): void => {
    if (issues !== null) return setIssues(null)
    void window.api.preview.listIssues(workspace.id).then(setIssues)
  }

  /** 모아 둔 문제를 컴포저로 보낸다. */
  const sendIssues = async (list: PreviewIssue[]): Promise<void> => {
    if (!list.length) return
    const { error } = await window.api.preview.sendIssues(
      workspace.id,
      list.map((i) => i.id)
    )
    if (error) {
      pushToast('error', error)
      return
    }
    setIssues(null)
    pushToast(
      'success',
      isPaneWindow
        ? `${list.length} issue(s) added to the composer in the main window.`
        : `${list.length} issue(s) added to the composer.`
    )
  }

  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    const next = normalizeInputUrl(draft ?? url)
    if (!next) {
      pushToast('error', 'That does not look like a URL.')
      return
    }
    navigate(next)
    remember(next)
  }

  /**
   * 요소 픽커를 켠다. main 이 CDP 로 게스트에 붙어 사용자가 고를 때까지 기다리므로([[main/previewPicker]])
   * 이 호출은 고르거나 취소할 때까지 돌아오지 않는다 — 그동안 화면에 안내줄을 띄운다.
   */
  const pick = async (): Promise<void> => {
    const view = viewRef.current
    if (!view || !ready || picking) return
    setPicking(true)
    try {
      const { error } = await window.api.preview.pickElement(workspace.id, view.getWebContentsId())
      // 취소는 사용자가 한 일이라 에러로 떠들지 않는다.
      if (error && error !== 'cancelled') pushToast('error', error)
      else if (!error)
        pushToast(
          'success',
          isPaneWindow
            ? 'Element added to the composer in the main window.'
            : 'Element added to the composer.'
        )
    } finally {
      setPicking(false)
    }
  }

  const cancelPick = (): void => {
    const view = viewRef.current
    if (view && picking) void window.api.preview.cancelPick(view.getWebContentsId())
  }

  // 픽커를 켠 채 패널이 사라지면(탭·워크스페이스 전환, 창 닫기) main 쪽 CDP 세션이 매달린다.
  // 최신 상태를 ref 로 들고 있다가 언마운트 때 한 번 정리한다.
  const cancelRef = useRef(cancelPick)
  cancelRef.current = cancelPick
  useEffect(() => () => cancelRef.current(), [])

  // 픽커 중 Esc 로 취소. 게스트가 포커스를 쥐고 있으면 이 창의 keydown 이 오지 않을 수 있어
  // 안내줄의 Cancel 버튼도 함께 둔다.
  useEffect(() => {
    if (!picking) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') cancelRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [picking])

  /** 지금 화면을 찍어 컴포저에 첨부한다. 이미지는 main 을 거쳐 컴포저가 있는 창으로 간다. */
  const capture = async (): Promise<void> => {
    const view = viewRef.current
    if (!view || !ready || capturing) return
    setCapturing(true)
    try {
      const { error } = await window.api.preview.capture(workspace.id, view.getWebContentsId())
      if (error) pushToast('error', error)
      else if (isPaneWindow)
        // 이 창에는 컴포저가 없다 — 어디로 갔는지 말해 주지 않으면 아무 일도 안 한 것처럼 보인다.
        pushToast('success', 'Screenshot attached to the composer in the main window.')
      else pushToast('success', 'Screenshot attached to the composer.')
    } finally {
      setCapturing(false)
    }
  }

  const shown = draft ?? url
  const external = url !== '' && !isLocalUrl(url)

  return (
    <div className="h-full flex flex-col min-h-0 bg-[var(--bg)]">
      <div className="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-[var(--border)]">
        <NavButton
          label="Back"
          disabled={!nav.back}
          onClick={() => viewRef.current?.goBack()}
          icon={ArrowLeft}
        />
        <NavButton
          label="Forward"
          disabled={!nav.forward}
          onClick={() => viewRef.current?.goForward()}
          icon={ArrowRight}
        />
        <NavButton
          label={loading ? 'Stop' : 'Reload'}
          disabled={!ready || !url}
          onClick={() => (loading ? viewRef.current?.stop() : viewRef.current?.reload())}
          icon={loading ? X : RotateCw}
        />

        <form onSubmit={submit} className="flex-1 min-w-0 mx-1">
          <input
            value={shown}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => setDraft(null)}
            spellCheck={false}
            placeholder="localhost:3000"
            aria-label="Preview address"
            className="w-full h-6 px-2 rounded-md bg-[var(--surface-2)] text-xs font-mono text-neutral-200 placeholder:text-neutral-600 outline-none focus:ring-1 focus:ring-[var(--focus-ring)]"
          />
        </form>

        {external && (
          <span
            title="This is not a localhost address — Preview is meant for this workspace’s dev server."
            className="shrink-0 grid place-items-center h-6 w-6 text-[var(--warning-400)]"
          >
            <TriangleAlert size={12} />
          </span>
        )}

        {issueCount.errors + issueCount.warnings > 0 && (
          <button
            type="button"
            onClick={toggleIssues}
            aria-pressed={issues !== null}
            title="Console and network errors from this page"
            className={
              'shrink-0 flex items-center gap-1 h-6 px-1.5 rounded-md text-xs tabular-nums ' +
              (issues !== null
                ? 'bg-[var(--surface-3)] text-neutral-100'
                : 'text-neutral-400 hover:bg-[var(--surface-2)]')
            }
          >
            <CircleAlert
              size={12}
              className={
                issueCount.errors ? 'text-[var(--danger-400)]' : 'text-[var(--warning-400)]'
              }
            />
            {issueCount.errors > 0 && <span>{issueCount.errors}</span>}
            {issueCount.warnings > 0 && (
              <span className="text-[var(--warning-400)]">{issueCount.warnings}</span>
            )}
          </button>
        )}

        <NavButton
          label="Pick an element and describe it to the agent"
          disabled={!ready || !url || !active || picking}
          onClick={() => void pick()}
          icon={MousePointerClick}
          activeState={picking}
        />
        <NavButton
          label="Attach a screenshot to the composer"
          disabled={!ready || !url || !active || capturing || picking}
          onClick={() => void capture()}
          icon={capturing ? Loader2 : Camera}
          spin={capturing}
        />
        <NavButton
          label="Open in your browser"
          disabled={!url}
          onClick={() => void window.api.openExternal(url)}
          icon={ExternalLink}
        />
      </div>

      {picking && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-[var(--border)] bg-[var(--info-500)]/10">
          <MousePointerClick size={12} className="shrink-0 text-[var(--info-400)]" />
          <span className="min-w-0 flex-1 text-xs text-neutral-300">
            Click an element in the preview to describe it to the agent.
          </span>
          <button
            onClick={cancelPick}
            className="shrink-0 text-xs px-2 py-0.5 rounded-md bg-[var(--surface-2)] text-neutral-300 hover:bg-[var(--surface-3)]"
          >
            Cancel
          </button>
        </div>
      )}

      {issues !== null && (
        <IssueList
          issues={issues}
          onSend={() => void sendIssues(issues)}
          onClear={() => {
            void window.api.preview.clearIssues(workspace.id)
            setIssues(null)
          }}
          onClose={() => setIssues(null)}
        />
      )}

      <div className="relative flex-1 min-h-0 bg-white">
        {/* 게스트는 항상 붙여 둔다 — 빈 화면일 때 안내를 그 위에 덮는다. 여기서 언마운트하면
            dev 서버를 다시 붙일 때마다 페이지가 처음부터 로드된다. */}
        <webview
          ref={(el) => {
            viewRef.current = el
          }}
          src={BOOT_URL}
          partition={PREVIEW_PARTITION}
          webpreferences={GUEST_PREFS}
          className="absolute inset-0"
          style={{ width: '100%', height: '100%' }}
        />
        {!url && <EmptyState />}
        {failure && <FailureState message={failure} onRetry={() => viewRef.current?.reload()} />}
      </div>
    </div>
  )
}

function NavButton({
  label,
  disabled,
  onClick,
  icon: Icon,
  spin,
  activeState
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  icon: React.ComponentType<{ size?: number; className?: string }>
  spin?: boolean
  /** 켜져 있는 모드(요소 픽커)임을 눌린 상태로 보여 준다. */
  activeState?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={activeState}
      disabled={disabled}
      onClick={onClick}
      className={
        'shrink-0 h-6 w-6 grid place-items-center rounded-md disabled:hover:bg-transparent ' +
        (activeState
          ? 'bg-[var(--info-600)] text-white disabled:text-white'
          : 'text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100 disabled:text-neutral-700')
      }
    >
      <Icon size={13} className={spin ? 'animate-spin' : undefined} />
    </button>
  )
}

/**
 * 모아 둔 콘솔·네트워크 문제 목록.
 *
 * 자동으로 에이전트에게 보내지 않는 것이 요점이다 — dev 서버는 멀쩡히 도는 중에도 경고를 쏟아
 * 내는데, 그게 매번 턴을 소비하면 대화가 잡음으로 덮인다. 무엇을 보낼지는 사람이 정한다.
 */
function IssueList({
  issues,
  onSend,
  onClear,
  onClose
}: {
  issues: PreviewIssue[]
  onSend: () => void
  onClear: () => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="shrink-0 max-h-56 flex flex-col border-b border-[var(--border)] bg-[var(--bg-2)]">
      <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-[var(--border)]">
        <span className="text-xs text-neutral-400">
          {issues.length} issue{issues.length === 1 ? '' : 's'} from this page
        </span>
        <div className="flex-1" />
        <button
          onClick={onSend}
          disabled={!issues.length}
          className="text-xs px-2 py-0.5 rounded-md bg-[var(--info-600)] text-white hover:bg-[var(--info-500)] disabled:bg-[var(--border)] disabled:text-neutral-600"
        >
          Send to agent
        </button>
        <button
          onClick={onClear}
          title="Clear collected issues"
          className="h-6 w-6 grid place-items-center rounded-md text-neutral-500 hover:bg-[var(--surface-2)] hover:text-neutral-200"
        >
          <Trash2 size={12} />
        </button>
        <button
          onClick={onClose}
          title="Hide"
          className="h-6 w-6 grid place-items-center rounded-md text-neutral-500 hover:bg-[var(--surface-2)] hover:text-neutral-200"
        >
          <X size={13} />
        </button>
      </div>
      <div className="flex-1 overflow-auto">
        {issues.length === 0 ? (
          <div className="px-3 py-3 text-xs text-neutral-500">No issues collected.</div>
        ) : (
          issues.map((issue) => (
            <div
              key={issue.id}
              className="flex items-start gap-2 px-3 py-1.5 border-b border-[var(--border)]/40 last:border-0"
            >
              <span
                className={
                  'shrink-0 mt-0.5 text-2xs font-mono uppercase ' +
                  (issue.level === 'error'
                    ? 'text-[var(--danger-400)]'
                    : 'text-[var(--warning-400)]')
                }
              >
                {issue.level === 'error' ? 'err' : 'warn'}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-mono text-neutral-300 break-words">{issue.text}</div>
                {issue.source && (
                  <div className="text-xs font-mono text-neutral-600 truncate">{issue.source}</div>
                )}
              </div>
              {issue.count > 1 && (
                <span className="shrink-0 text-xs tabular-nums text-neutral-500">
                  ×{issue.count}
                </span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function EmptyState(): React.JSX.Element {
  return (
    <div className="absolute inset-0 grid place-items-center bg-[var(--bg)] px-8 text-center">
      <div className="max-w-sm space-y-2">
        <p className="text-sm text-neutral-300">Nothing to preview yet.</p>
        <p className="text-xs leading-relaxed text-neutral-500">
          Start this workspace’s dev server from the Scripts panel and use “Open in Preview”, or
          type a port (like <span className="font-mono text-neutral-400">3000</span>) in the address
          bar above.
        </p>
      </div>
    </div>
  )
}

function FailureState({
  message,
  onRetry
}: {
  message: string
  onRetry: () => void
}): React.JSX.Element {
  return (
    <div className="absolute inset-0 grid place-items-center bg-[var(--bg)] px-8 text-center">
      <div className="max-w-sm space-y-3">
        <p className="text-sm text-neutral-300">Could not load that page.</p>
        <p className="text-xs font-mono text-[var(--danger-400)] break-words">{message}</p>
        <p className="text-xs text-neutral-500">
          The dev server may still be starting up, or it may have stopped.
        </p>
        <button
          onClick={onRetry}
          className="text-xs px-2.5 py-1 rounded-md bg-[var(--surface-2)] text-neutral-200 hover:bg-[var(--surface-3)]"
        >
          Try again
        </button>
      </div>
    </div>
  )
}
