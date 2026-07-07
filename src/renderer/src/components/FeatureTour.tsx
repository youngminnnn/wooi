import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { primaryBtn, ghostBtn } from './Modal'
import TourDemo from './TourDemo'

/**
 * 실제 UI 요소를 스포트라이트(하이라이트)하며 진행하는 기능 투어.
 * 최초 실행 온보딩의 마지막 단계이자 설정의 "Take a tour"에서 재사용한다.
 *
 * 각 단계는 `data-tour="<key>"` 마커가 붙은 실제 DOM 요소를 대상으로 한다.
 * 대상이 화면에 없으면(예: 워크스페이스 미선택 상태의 채팅/작업 패널) 중앙 카드로 자연스럽게 대체된다.
 */

type Placement = 'right' | 'left' | 'bottom'

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
    title: 'Welcome to Ditto',
    body: (
      <>
        Ditto runs multiple AI coding agents at once — each in its own isolated git worktree. This
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
        Each repo can define setup / dev / archive scripts from its settings icon.
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
      { keys: '⌘[ / ⌘]', label: 'Previous / next' }
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

type Box = { top: number; left: number; width: number; height: number }

function tooltipStyle(rect: Box, placement: Placement): React.CSSProperties {
  const gap = 16
  const vw = window.innerWidth
  const vh = window.innerHeight
  let top: number
  let left: number
  if (placement === 'left') {
    left = rect.left - gap - CARD_W
    top = rect.top
  } else if (placement === 'bottom') {
    left = rect.left
    top = rect.top + rect.height + gap
  } else {
    // right (default)
    left = rect.left + rect.width + gap
    top = rect.top
  }
  // 뷰포트 밖으로 넘어가지 않게 대략적으로 보정한다(카드 높이는 넉넉히 300px 가정).
  left = Math.max(12, Math.min(left, vw - CARD_W - 12))
  top = Math.max(12, Math.min(top, vh - 300))
  return { position: 'fixed', top, left, width: CARD_W }
}

export default function FeatureTour({
  onDone,
  firstRun = false
}: {
  onDone: () => void
  /** 최초 실행(true): 하단 Skip 으로만 종료, Escape 무시. 재실행(false): ✕/Escape 로 닫기. */
  firstRun?: boolean
}): React.JSX.Element {
  const [index, setIndex] = useState(0)
  const [rect, setRect] = useState<Box | null>(null)
  // 최초 실행에서는 예시(데모) 화면을 배경으로 깔고, 그 안의 마커를 대상으로 삼는다
  // (실제 앱에도 같은 data-tour 가 있으므로 데모 subtree 로 조회 범위를 한정한다).
  const demoRef = useRef<HTMLDivElement>(null)
  const step = STEPS[index]
  const last = index === STEPS.length - 1

  // 현재 단계의 대상 요소 위치를 측정한다(단계 변경·창 크기 변화에 반응).
  useLayoutEffect(() => {
    const measure = (): void => {
      const scope: ParentNode | null = firstRun ? demoRef.current : document
      if (!step.target || !scope) {
        setRect(null)
        return
      }
      const el = scope.querySelector(`[data-tour="${step.target}"]`)
      if (!el) {
        setRect(null)
        return
      }
      const r = el.getBoundingClientRect()
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [index, step.target, firstRun])

  const next = (): void => {
    if (last) onDone()
    else setIndex((i) => i + 1)
  }
  const back = (): void => setIndex((i) => Math.max(0, i - 1))

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowRight') next()
      else if (e.key === 'ArrowLeft') back()
      else if (e.key === 'Escape' && !firstRun) onDone()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, last, firstRun])

  const Icon = <X size={15} />

  const card = (floating: boolean): React.JSX.Element => (
    <div
      className={
        'no-drag bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden' +
        (floating ? '' : ' w-[420px] max-w-[92vw]')
      }
      style={floating && rect ? tooltipStyle(rect, step.placement ?? 'right') : undefined}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="relative px-5 pt-5 pb-3">
        {!firstRun && (
          <button
            onClick={onDone}
            className="absolute top-3 right-3 h-7 w-7 grid place-items-center rounded-md text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100"
            aria-label="Close"
          >
            {Icon}
          </button>
        )}
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

      <div className="px-5 py-3 border-t border-[var(--border)] flex items-center justify-between">
        <div>
          {firstRun && !last && (
            <button className="text-sm text-neutral-500 hover:text-neutral-300" onClick={onDone}>
              Skip
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {index > 0 && (
            <button className={ghostBtn} onClick={back}>
              Back
            </button>
          )}
          <button className={primaryBtn} onClick={next}>
            {last ? (firstRun ? 'Start using Ditto' : 'Done') : 'Next'}
          </button>
        </div>
      </div>
    </div>
  )

  return (
    <div className="fixed inset-0 z-50">
      {/* 최초 실행: 실제 워크스페이스가 없으므로 예시 화면을 배경으로 깔고 그 위를 스포트라이트한다. */}
      {firstRun && (
        <div ref={demoRef} className="absolute inset-0">
          <TourDemo />
        </div>
      )}
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
          className="absolute inset-0 grid place-items-center bg-black/62"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {card(false)}
        </div>
      )}
    </div>
  )
}
