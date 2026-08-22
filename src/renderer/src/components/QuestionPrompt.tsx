import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, MessagesSquare } from 'lucide-react'
import { useStore } from '../store'
import { SELECTABLE, unlessSelecting } from '../lib/selection'
import type { PermissionRequest } from '@shared/types'

interface QuestionOption {
  label: string
  description: string
  preview?: string
}

interface Question {
  question: string
  header: string
  options: QuestionOption[]
  multiSelect?: boolean
}

// 사용자가 직접 입력한 "Other" 항목을 selected 배열 안에서 표시하는 sentinel.
// Other 는 모델이 준 옵션이 아니라 자동 제공되는 자유 입력이므로, 실제 옵션 라벨과
// 한 배열에 섞여도 충돌하지 않도록, 실제 라벨로는 나올 수 없는 토큰 값을 쓴다.
const OTHER = '__wooi_other__'

/** 질문 인덱스별 선택 라벨 목록. 옵션 라벨 또는 OTHER sentinel 이 들어간다. */
type Selection = Record<number, string[]>

/** 한 질문 안에서 커서가 놓일 수 있는 위치. o 가 options.length 면 Other 입력칸이다. */
interface Cursor {
  q: number
  o: number
}

const applyToggle = (prev: Selection, qi: number, value: string, multi: boolean): Selection => {
  const cur = prev[qi] ?? []
  if (!multi) return { ...prev, [qi]: [value] }
  return { ...prev, [qi]: cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value] }
}

/**
 * AskUserQuestion 도구의 질문을 표시하고 사용자의 선택을 수집한다.
 *
 * AskUserQuestion 은 행위 승인이 아니라 사용자에게 답을 요청하는 도구이므로 Allow/Deny
 * 프롬프트(PermissionPrompt) 대신 옵션 선택 UI 를 띄운다. 수집한 답은 도구가 기대하는
 * answers 맵(질문 텍스트 → 선택 라벨, 복수 선택은 쉼표 구분)으로 만들어 updatedInput 에
 * 실어 되돌려준다. 빈 답으로 넘기면 모델이 "사용자가 답하지 않았다" 며 진행하기 때문이다.
 *
 * 질문이 많아 세로로 길어지면 위쪽 대화 내역을 가리므로, 내용이 높이 상한(컨테이너의
 * max-h-[40vh])을 넘을 때만 아코디언(질문 하나만 펼침)으로 접는다. 짧을 때는 전과
 * 동일하게 전부 펼쳐 한눈에 보이도록 둔다.
 *
 * 답을 고르고 제출하는 흐름은 마우스 없이 끝낼 수 있다(대화 중 자주 뜨는 UI 라서).
 *   ↑/↓   커서 이동(질문 경계를 넘어 다음/이전 질문으로 이어진다)
 *   1–9    현재 질문의 n 번째 옵션 선택
 *   Space  커서에 놓인 옵션 토글
 *   ⏎      (단일 선택은 커서 옵션을 고른 뒤) 다음 미답 질문으로, 전부 답했으면 제출
 *   ⌘⏎     즉시 제출
 *   Esc    취소
 */
export default function QuestionPrompt({
  request
}: {
  request: PermissionRequest
}): React.JSX.Element {
  const dismiss = useStore((s) => s.dismissPermission)
  const listRef = useRef<HTMLDivElement>(null)

  const questions = useMemo<Question[]>(() => {
    const q = (request.input as { questions?: unknown }).questions
    return Array.isArray(q) ? (q as Question[]) : []
  }, [request])

  // 질문 인덱스별 선택된 옵션 라벨 목록(+ OTHER sentinel)과 Other 자유 입력 텍스트.
  const [selected, setSelected] = useState<Selection>({})
  const [otherText, setOtherText] = useState<Record<number, string>>({})

  // 내용이 상한을 넘어 접기 모드가 필요한지, 그리고 접힌 상태에서 펼쳐진 질문 인덱스.
  const [collapsed, setCollapsed] = useState(false)
  const [expanded, setExpanded] = useState(0)

  // 키보드 커서. 마우스/Tab 으로 옮긴 포커스와 어긋나지 않도록 각 행의 onFocus 에서도 갱신한다.
  const [cursor, setCursor] = useState<Cursor>({ q: 0, o: 0 })
  const rowRefs = useRef<Record<string, HTMLElement | null>>({})
  const rowKey = (qi: number, oi: number): string => `${qi}:${oi}`

  // 첫 렌더에서는 전부 펼친 상태로 그린 뒤, 스크롤 컨테이너가 상한(clientHeight)을 넘겨
  // 넘치면(scrollHeight) 접기 모드로 전환한다. 접힌 뒤에는 내용이 줄어 다시 안 넘치지만
  // requestId 기준으로 한 번만 측정하므로 되돌아가며 깜빡이지 않는다. paint 전에 동기
  // 실행되는 useLayoutEffect 라 전체 펼침 상태가 화면에 번쩍이지 않는다.
  useLayoutEffect(() => {
    const el = listRef.current
    if (el && el.scrollHeight > el.clientHeight + 4) setCollapsed(true)
  }, [request.requestId])

  // 커서가 가리키는 행에 실제 DOM 포커스를 준다(마운트 직후 첫 옵션 포커스도 이 이펙트가 한다).
  // 접기 모드에서 다른 질문으로 넘어갈 때는 setExpanded 와 같은 배치로 커서가 바뀌므로,
  // 이 이펙트가 도는 시점에는 대상 행이 이미 렌더되어 ref 가 채워져 있다.
  useEffect(() => {
    const el = rowRefs.current[rowKey(cursor.q, cursor.o)]
    el?.focus()
    el?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const toggle = (qi: number, value: string, multi: boolean): void => {
    setSelected((prev) => applyToggle(prev, qi, value, multi))
  }

  const setOther = (qi: number, text: string, multi: boolean): void => {
    setOtherText((prev) => ({ ...prev, [qi]: text }))
    // 자유 입력을 시작하면 Other 를 선택 상태로(단일 선택은 다른 선택을 대체), 비우면 해제한다.
    setSelected((prev) => {
      const cur = prev[qi] ?? []
      const has = cur.includes(OTHER)
      if (text && !has) return { ...prev, [qi]: multi ? [...cur, OTHER] : [OTHER] }
      if (!text && has) return { ...prev, [qi]: cur.filter((v) => v !== OTHER) }
      return prev
    })
  }

  // 한 질문의 최종 답 문자열: 선택 라벨(Other 는 입력 텍스트)을 쉼표로 잇는다.
  // 키 핸들러는 방금 만든 다음 상태로 "다 답했는지" 를 즉시 판단해야 해서(setState 는 비동기)
  // 선택 맵을 인자로 받는 형태로 두고, 렌더용 헬퍼는 현재 상태를 넘겨 쓴다.
  const answerFrom = (sel: Selection, qi: number): string =>
    (sel[qi] ?? [])
      .map((v) => (v === OTHER ? (otherText[qi] ?? '').trim() : v))
      .filter(Boolean)
      .join(', ')

  const answerFor = (qi: number): string => answerFrom(selected, qi)

  const isAnswered = (sel: Selection, qi: number): boolean => answerFrom(sel, qi).length > 0
  const allAnsweredIn = (sel: Selection): boolean =>
    questions.length > 0 && questions.every((_, qi) => isAnswered(sel, qi))

  const allAnswered = allAnsweredIn(selected)

  const submitWith = (sel: Selection): void => {
    if (!allAnsweredIn(sel)) return

    const answers: Record<string, string> = {}
    questions.forEach((q, qi) => {
      answers[q.question] = answerFrom(sel, qi)
    })

    void window.api.permission.respond(request.requestId, {
      behavior: 'allow',
      updatedInput: { ...(request.input as Record<string, unknown>), answers }
    })
    dismiss(request.requestId)
  }

  const submit = (): void => submitWith(selected)

  const cancel = (): void => {
    void window.api.permission.respond(request.requestId, { behavior: 'deny' })
    dismiss(request.requestId)
  }

  // 접기 모드가 아니면 전부 펼침, 접기 모드면 expanded 인 질문만 펼침.
  const isOpen = (qi: number): boolean => !collapsed || expanded === qi

  const focusRow = (qi: number, oi: number): void => {
    setCursor((prev) => (prev.q === qi && prev.o === oi ? prev : { q: qi, o: oi }))
    if (collapsed) setExpanded(qi)
  }

  /** 한 질문의 행 수 = 옵션 수 + Other 입력칸 1. */
  const rowCount = (qi: number): number => (questions[qi]?.options.length ?? 0) + 1

  const moveCursor = (delta: 1 | -1): void => {
    let { q, o } = cursor
    o += delta
    if (o < 0) {
      if (q === 0) return
      q -= 1
      o = rowCount(q) - 1
    } else if (o >= rowCount(q)) {
      if (q >= questions.length - 1) return
      q += 1
      o = 0
    }
    focusRow(q, o)
  }

  /** cursor.q 다음부터 한 바퀴 돌며 아직 답 안 한 질문을 찾는다. */
  const nextUnanswered = (sel: Selection): number | null => {
    for (let i = 1; i <= questions.length; i++) {
      const qi = (cursor.q + i) % questions.length
      if (!isAnswered(sel, qi)) return qi
    }
    return null
  }

  const onEnter = (): void => {
    const q = questions[cursor.q]
    if (!q) return
    const multi = Boolean(q.multiSelect)
    const opt = q.options[cursor.o]

    // 단일 선택은 ⏎ 로 바로 고르고, 복수 선택은 Space 로 고르는 게 원칙이지만
    // 아직 아무것도 안 고른 질문에서는 ⏎ 도 선택으로 받아 준다(빈 답으로 넘어가지 않도록).
    let sel = selected
    if (opt && (!multi || !isAnswered(sel, cursor.q))) {
      sel = applyToggle(sel, cursor.q, opt.label, multi)
      setSelected(sel)
    }

    if (allAnsweredIn(sel)) {
      submitWith(sel)
      return
    }
    const nq = nextUnanswered(sel)
    if (nq !== null) focusRow(nq, 0)
  }

  // 대화 중 자주 뜨는 UI 라 마우스 없이 끝낼 수 있게 키보드를 지원한다. 핸들러가 커서/선택
  // 상태를 읽으므로 매 렌더 최신 함수를 ref 에 담고, window 리스너는 마운트 때 한 번만 건다.
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {})
  useEffect(() => {
    keyHandlerRef.current = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        cancel()
        return
      }
      // 프롬프트 바깥에 포커스가 있으면(작성 중인 메시지 입력창, Cancel/Submit 버튼 등)
      // 그쪽 기본 동작을 뺏지 않는다. Esc 만 예외로 어디서든 취소를 받는다.
      const target = e.target as HTMLElement | null
      const inList = !!target && !!listRef.current?.contains(target)
      const editable =
        !!target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (!inList && (editable || target?.tagName === 'BUTTON')) return

      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        submit()
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return

      // Other 자유 입력 중에는 글자·공백을 그대로 받아야 하므로 이동·확정 키만 가로챈다.
      const typing = editable

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        moveCursor(e.key === 'ArrowDown' ? 1 : -1)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        onEnter()
        return
      }
      if (typing) return

      if (e.key === ' ') {
        // 옵션 버튼의 기본 동작(Space=click)과 겹치지 않게 preventDefault 로 막고 직접 토글한다.
        e.preventDefault()
        const q = questions[cursor.q]
        const opt = q?.options[cursor.o]
        if (opt) toggle(cursor.q, opt.label, Boolean(q.multiSelect))
        return
      }
      if (e.key >= '1' && e.key <= '9') {
        const q = questions[cursor.q]
        const oi = Number(e.key) - 1
        const opt = q?.options[oi]
        if (!opt) return
        e.preventDefault()
        toggle(cursor.q, opt.label, Boolean(q.multiSelect))
        focusRow(cursor.q, oi)
      }
    }
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => keyHandlerRef.current(e)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="shrink-0 mx-4 mb-2 flex max-h-[40vh] flex-col rounded-lg border border-[var(--brand-500)]/30 bg-[var(--brand-500)]/10 px-3.5 py-3">
      <div className="flex min-h-0 flex-1 gap-2.5">
        <MessagesSquare size={16} className="text-[var(--brand-400)] mt-0.5 shrink-0 self-start" />
        <div ref={listRef} className="min-w-0 flex-1 overflow-y-auto">
          {questions.map((q, qi) => {
            const multi = Boolean(q.multiSelect)
            const cur = selected[qi] ?? []
            const open = isOpen(qi)
            const answer = answerFor(qi)
            return (
              <div key={qi} className={qi > 0 ? 'mt-3.5' : ''}>
                {collapsed ? (
                  // 접기 모드: 짧은 header 칩을 눌러 펼친다. 접힌 질문은 선택한 답 요약을,
                  // 아직 답 안 한 질문은 '답변 필요' 표시를 보여준다.
                  <button
                    onClick={unlessSelecting(() => focusRow(qi, 0))}
                    className={`flex w-full items-center gap-2 rounded-md px-0.5 py-0.5 text-left focus:outline-none focus:ring-2 focus:ring-[var(--brand-300)]/50 ${SELECTABLE}`}
                  >
                    <ChevronRight
                      size={14}
                      className={`shrink-0 text-[var(--brand-400)] transition-transform ${open ? 'rotate-90' : ''}`}
                    />
                    <span className="shrink-0 text-sm font-medium text-neutral-100">
                      {q.header || q.question}
                    </span>
                    {!open &&
                      (answer ? (
                        <span className="min-w-0 truncate text-xs text-neutral-400">{answer}</span>
                      ) : (
                        <span className="shrink-0 text-xs text-[var(--brand-300)]/70">
                          Needs an answer
                        </span>
                      ))}
                  </button>
                ) : (
                  <div className="text-sm text-neutral-100 font-medium">{q.question}</div>
                )}

                {open && (
                  <>
                    {/* 접기 모드에서는 header 칩만으로 부족하므로 펼칠 때 전체 질문문을 보여준다. */}
                    {collapsed && (
                      <div className="ml-[22px] mt-1 text-sm font-medium text-neutral-100">
                        {q.question}
                      </div>
                    )}
                    {multi && (
                      <div
                        className={`text-xs text-[var(--brand-300)]/70 mt-0.5 ${collapsed ? 'ml-[22px]' : ''}`}
                      >
                        Select all that apply
                      </div>
                    )}
                    <div className={`mt-1.5 flex flex-col gap-1 ${collapsed ? 'ml-[22px]' : ''}`}>
                      {q.options.map((opt, oi) => {
                        const on = cur.includes(opt.label)
                        return (
                          <button
                            key={oi}
                            ref={(el) => {
                              rowRefs.current[rowKey(qi, oi)] = el
                            }}
                            onFocus={() => focusRow(qi, oi)}
                            onClick={unlessSelecting(() => toggle(qi, opt.label, multi))}
                            className={`${SELECTABLE} text-left rounded-md border px-2.5 py-1.5 transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--brand-300)]/50 ${
                              on
                                ? 'border-[var(--brand-400)]/60 bg-[var(--brand-500)]/15'
                                : 'border-neutral-700/60 hover:bg-[var(--surface-2)]'
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <span
                                className={`inline-block h-3 w-3 shrink-0 border ${
                                  multi ? 'rounded-[3px]' : 'rounded-full'
                                } ${on ? 'bg-[var(--brand-400)] border-[var(--brand-400)]' : 'border-neutral-500'}`}
                              />
                              <span className="text-sm text-neutral-100">{opt.label}</span>
                              {/* 숫자 키로 바로 고를 수 있음을 알려 주는 힌트(9 번까지). */}
                              {oi < 9 && (
                                <span className="ml-auto shrink-0 text-[10px] text-neutral-500 tabular-nums">
                                  {oi + 1}
                                </span>
                              )}
                            </div>
                            {opt.description && (
                              <div className="text-xs text-neutral-400 mt-0.5 ml-5">
                                {opt.description}
                              </div>
                            )}
                          </button>
                        )
                      })}

                      {/* 자동 제공되는 Other 자유 입력. */}
                      <input
                        type="text"
                        ref={(el) => {
                          rowRefs.current[rowKey(qi, q.options.length)] = el
                        }}
                        onFocus={() => focusRow(qi, q.options.length)}
                        value={otherText[qi] ?? ''}
                        onChange={(e) => setOther(qi, e.target.value, multi)}
                        placeholder="Other…"
                        className={`text-sm rounded-md border bg-transparent px-2.5 py-1.5 text-neutral-100 placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-[var(--brand-300)]/50 ${
                          cur.includes(OTHER)
                            ? 'border-[var(--brand-400)]/60 bg-[var(--brand-500)]/10'
                            : 'border-neutral-700/60'
                        }`}
                      />
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div className="mt-3 flex shrink-0 items-center justify-end gap-1.5">
        <span className="mr-auto hidden truncate text-[11px] text-neutral-500 sm:block">
          ↑↓ move · Space select · ⏎ next · ⌘⏎ submit · Esc cancel
        </span>
        <button
          onClick={cancel}
          className="text-sm px-2.5 py-1 rounded-md text-neutral-300 hover:bg-[var(--surface-2)]"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={!allAnswered}
          className="text-sm px-2.5 py-1 rounded-md bg-[var(--brand-500)]/90 text-black font-medium hover:bg-[var(--brand-400)] disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-[var(--brand-300)]/60"
        >
          Submit
        </button>
      </div>
    </div>
  )
}
