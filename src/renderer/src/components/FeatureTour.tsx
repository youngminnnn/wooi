import { useEffect, useLayoutEffect, useState } from 'react'
import { X } from 'lucide-react'
import { primaryBtn, ghostBtn } from './Modal'
import { anchorStyle, measureAnchor, type AnchorBox, type Placement } from '../lib/anchor'

/**
 * 실제 UI 요소를 스포트라이트(하이라이트)하며 진행하는 기능 투어. Settings → About 의
 * "Take a tour"에서만 연다 — 예전엔 최초 실행 온보딩의 한 단계이기도 했지만, 리포도
 * 워크스페이스도 없는 상태에서 기능을 일괄 소개하는 게 와닿지 않아 뺐다(`OnboardingModal`).
 *
 * 항상 실제 앱 위에서 돌기 때문에(예시 화면을 따로 두지 않는다) 8단계 전부를 그대로 보여줄 수
 * 있다 — PR 리뷰 단계도 예외 없이 포함된다.
 *
 * 각 단계는 `data-tour="<key>"` 마커가 붙은 실제 DOM 요소를 대상으로 한다.
 * 대상이 화면에 없으면(예: 워크스페이스 미선택 상태의 채팅/작업 패널) 중앙 카드로 자연스럽게 대체된다.
 */

type Step = {
  /** data-tour 마커 키. 없으면(또는 대상이 DOM 에 없으면) 중앙 카드로 표시. */
  target?: string
  title: string
  body: React.ReactNode
  placement?: Placement
  shortcuts?: { keys: string; label: string }[]
}

const STEPS: Step[] = [
  {
    title: 'Welcome to Wooi',
    body: (
      <>
        Wooi runs multiple AI coding agents at once — each in its own isolated git worktree. This
        quick tour points out where everything lives. Use <b className="text-neutral-200">Next</b>{' '}
        (or the arrow keys) to move through it.
      </>
    )
  },
  {
    target: 'repos',
    placement: 'right',
    title: 'Add a repository',
    body: (
      <>
        Start here — add a git repository with the <b className="text-neutral-200">+</b> button.
        Every workspace you create later branches off one of these repos.
      </>
    )
  },
  // 리포별 설정은 예전엔 앞 단계의 마지막 한 문장으로만 스쳐 지나갔고, 그나마 가리키던
  // "settings icon" 은 데모 화면에 그려져 있지도 않았다. 진입점이 사이드바 톱니 하나뿐인
  // 기능이므로 독립 단계로 올려 그 아이콘을 직접 스포트라이트한다.
  {
    target: 'repo-settings',
    placement: 'right',
    title: 'Configure each repo once',
    body: (
      <>
        The gear on a repo row opens settings that apply to every workspace of that repo:
        <ul className="mt-1.5 list-disc pl-5 space-y-0.5 text-neutral-400">
          <li>
            <b className="text-neutral-200">Setup</b> — runs once after each workspace is created
            (e.g. <span className="font-mono">npm install</span>)
          </li>
          <li>
            <b className="text-neutral-200">Dev</b> — start/stop a dev server, each workspace on its
            own <span className="font-mono">$PORT</span>
          </li>
          <li>
            <b className="text-neutral-200">Carry</b> — git-ignored files (
            <span className="font-mono">.env</span>,{' '}
            <span className="font-mono">CLAUDE.local.md</span> …) to copy into new worktrees
          </li>
        </ul>
        New worktrees contain only git-tracked files, so anything ignored is missing unless you list
        it here — which is why agents can otherwise behave differently than in your main checkout.
      </>
    )
  },
  {
    target: 'workspaces',
    placement: 'right',
    title: 'Workspaces = isolated worktrees',
    body: (
      <>
        Every task runs in its own workspace — a dedicated branch and git worktree, so parallel
        agents never step on each other. Their status shows live in this list.
      </>
    ),
    shortcuts: [
      { keys: '⌘1–9', label: 'Jump to a workspace' },
      { keys: '⌘↑ / ⌘↓', label: 'Previous / next' }
    ]
  },
  {
    target: 'chat',
    placement: 'right',
    title: 'Chat with your agent',
    body: (
      <>
        Talk to your agent here — streamed replies, tool calls, and thinking show inline. Choose how
        much the agent can do on its own with permission modes.
      </>
    ),
    shortcuts: [{ keys: '⇧⇥', label: 'Cycle permission mode' }]
  },
  {
    target: 'work-panel',
    placement: 'left',
    title: 'Inspect changes in the work panel',
    body: (
      <>
        Your files, the diff of what changed, CI-style checks, and an interactive terminal — all
        scoped to the current workspace. Open a pull request and pull base updates from here too.
        Set whether it starts open by default in <b className="text-neutral-200">Settings</b> — your
        last <b className="text-neutral-200">⌘J</b> toggle is then remembered from there.
      </>
    ),
    shortcuts: [{ keys: '⌘J', label: 'Toggle the work panel' }]
  },
  {
    target: 'review-pr',
    placement: 'bottom',
    title: 'Review a pull request',
    body: (
      <>
        Point Wooi at any pull request and an agent reviews it the way you ask. Its suggestions land
        on the exact diff lines, you edit them, and post the ones you want — then approve or request
        changes without leaving the app.
      </>
    )
  },
  {
    target: 'settings',
    placement: 'bottom',
    title: 'Settings & integrations',
    body: (
      <>
        Open Settings to configure it your way:
        <ul className="mt-1.5 list-disc pl-5 space-y-0.5 text-neutral-400">
          <li>AI provider &amp; GitHub sign-in</li>
          <li>Theme, model &amp; reasoning effort</li>
          <li>Default permission mode &amp; auto-compact</li>
          <li>Work-panel default, sound, manual workspace setup</li>
        </ul>
      </>
    )
  }
]

const CARD_W = 340
const PAD = 6

export default function FeatureTour({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [index, setIndex] = useState(0)
  const [rect, setRect] = useState<AnchorBox | null>(null)
  const step = STEPS[index]
  const last = index === STEPS.length - 1

  // 현재 단계의 대상 요소 위치를 측정한다(단계 변경·창 크기 변화에 반응).
  useLayoutEffect(() => {
    const measure = (): void => {
      setRect(step.target ? measureAnchor(step.target) : null)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [index, step.target])

  const next = (): void => {
    if (last) onDone()
    else setIndex((i) => i + 1)
  }
  const back = (): void => setIndex((i) => Math.max(0, i - 1))

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowRight') next()
      else if (e.key === 'ArrowLeft') back()
      else if (e.key === 'Escape') onDone()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, last])

  const Icon = <X size={15} />

  const card = (floating: boolean): React.JSX.Element => (
    <div
      className={
        'no-drag bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden' +
        (floating ? '' : ' w-[420px] max-w-[92vw]')
      }
      style={floating && rect ? anchorStyle(rect, step.placement ?? 'right', CARD_W) : undefined}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="relative px-5 pt-5 pb-3">
        <button
          onClick={onDone}
          className="absolute top-3 right-3 h-7 w-7 grid place-items-center rounded-md text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100"
          aria-label="Close"
        >
          {Icon}
        </button>
        <div className="text-xs font-medium text-[var(--info-400)] mb-1.5">
          {index + 1} / {STEPS.length}
        </div>
        <h2 className="text-base font-semibold text-neutral-100">{step.title}</h2>
        <div className="mt-1.5 text-sm text-neutral-400 leading-relaxed">{step.body}</div>

        {step.shortcuts && (
          <div className="mt-3 flex flex-col gap-1.5">
            {step.shortcuts.map((s) => (
              <div key={s.keys} className="flex items-center gap-2 text-xs text-neutral-500">
                <kbd className="px-1.5 py-0.5 rounded-md bg-[var(--bg-2)] border border-[var(--border)] text-neutral-300 font-medium">
                  {s.keys}
                </kbd>
                <span>{s.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 진행 점 */}
      <div className="flex justify-center gap-1.5 pb-2">
        {STEPS.map((_, i) => (
          <button
            key={i}
            onClick={() => setIndex(i)}
            aria-label={`Go to step ${i + 1}`}
            className={
              'h-1.5 rounded-full transition-all ' +
              (i === index
                ? 'w-5 bg-[var(--info-500)]'
                : 'w-1.5 bg-[var(--border-2)] hover:bg-[var(--border-strong)]')
            }
          />
        ))}
      </div>

      <div className="px-5 py-3 border-t border-[var(--border)] flex items-center justify-end">
        <div className="flex items-center gap-2">
          {index > 0 && (
            <button className={ghostBtn} onClick={back}>
              Back
            </button>
          )}
          <button className={primaryBtn} onClick={next}>
            {last ? 'Done' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  )

  return (
    <div className="fixed inset-0 z-50">
      {rect ? (
        <>
          {/* 클릭 차단막(투어 진행 중 뒤 화면 조작 방지). 대상 구멍은 box-shadow 로 시각적으로만 판다. */}
          <div className="absolute inset-0" onMouseDown={(e) => e.stopPropagation()} />
          <div
            className="pointer-events-none absolute rounded-lg ring-2 ring-[var(--info-500)] transition-all duration-200"
            style={{
              top: rect.top - PAD,
              left: rect.left - PAD,
              width: rect.width + PAD * 2,
              height: rect.height + PAD * 2,
              boxShadow: '0 0 0 9999px rgba(0,0,0,0.62)'
            }}
          />
          {card(true)}
        </>
      ) : (
        <div
          className="absolute inset-0 grid place-items-center bg-black/50"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {card(false)}
        </div>
      )}
    </div>
  )
}
