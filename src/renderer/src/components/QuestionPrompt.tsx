import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, MessagesSquare } from 'lucide-react'
import { useStore } from '../store'
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
const OTHER = '__ditto_other__'

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
 */
export default function QuestionPrompt({
  request
}: {
  request: PermissionRequest
}): React.JSX.Element {
  const dismiss = useStore((s) => s.dismissPermission)
  const firstRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const questions = useMemo<Question[]>(() => {
    const q = (request.input as { questions?: unknown }).questions
    return Array.isArray(q) ? (q as Question[]) : []
  }, [request])

  // 질문 인덱스별 선택된 옵션 라벨 목록(+ OTHER sentinel)과 Other 자유 입력 텍스트.
  const [selected, setSelected] = useState<Record<number, string[]>>({})
  const [otherText, setOtherText] = useState<Record<number, string>>({})

  // 내용이 상한을 넘어 접기 모드가 필요한지, 그리고 접힌 상태에서 펼쳐진 질문 인덱스.
  const [collapsed, setCollapsed] = useState(false)
  const [expanded, setExpanded] = useState(0)

  // 첫 렌더에서는 전부 펼친 상태로 그린 뒤, 스크롤 컨테이너가 상한(clientHeight)을 넘겨
  // 넘치면(scrollHeight) 접기 모드로 전환한다. 접힌 뒤에는 내용이 줄어 다시 안 넘치지만
  // requestId 기준으로 한 번만 측정하므로 되돌아가며 깜빡이지 않는다. paint 전에 동기
  // 실행되는 useLayoutEffect 라 전체 펼침 상태가 화면에 번쩍이지 않는다.
  useLayoutEffect(() => {
    const el = listRef.current
    if (el && el.scrollHeight > el.clientHeight + 4) setCollapsed(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.requestId])

  // 첫 옵션에 포커스하고 Esc=취소를 바인딩한다. ChatView 가 requestId 를 key 로 주어
  // 질문이 바뀌면 컴포넌트가 새로 마운트되므로 입력 상태는 자동으로 초기화된다.
  useEffect(() => {
    firstRef.current?.focus()

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        cancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.requestId])

  const toggle = (qi: number, value: string, multi: boolean): void => {
    setSelected((prev) => {
      const cur = prev[qi] ?? []
      if (multi) {
        const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]
        return { ...prev, [qi]: next }
      }
      return { ...prev, [qi]: [value] }
    })
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
  const answerFor = (qi: number): string =>
    (selected[qi] ?? [])
      .map((v) => (v === OTHER ? (otherText[qi] ?? '').trim() : v))
      .filter(Boolean)
      .join(', ')

  const allAnswered = questions.length > 0 && questions.every((_, qi) => answerFor(qi).length > 0)

  const submit = (): void => {
    if (!allAnswered) return

    const answers: Record<string, string> = {}
    questions.forEach((q, qi) => {
      answers[q.question] = answerFor(qi)
    })

    void window.api.permission.respond(request.requestId, {
      behavior: 'allow',
      updatedInput: { ...(request.input as Record<string, unknown>), answers }
    })
    dismiss(request.requestId)
  }

  const cancel = (): void => {
    void window.api.permission.respond(request.requestId, { behavior: 'deny' })
    dismiss(request.requestId)
  }

  // 접기 모드가 아니면 전부 펼침, 접기 모드면 expanded 인 질문만 펼침.
  const isOpen = (qi: number): boolean => !collapsed || expanded === qi

  return (
    <div className="shrink-0 mx-4 mb-2 flex max-h-[40vh] flex-col rounded-lg border border-[var(--brand-500)]/30 bg-[var(--brand-500)]/10 px-3.5 py-3">
      <div className="flex min-h-0 flex-1 items-start gap-2.5">
        <MessagesSquare size={16} className="text-[var(--brand-400)] mt-0.5 shrink-0" />
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
                    onClick={() => setExpanded(qi)}
                    className="flex w-full items-center gap-2 rounded-md px-0.5 py-0.5 text-left focus:outline-none focus:ring-2 focus:ring-[var(--brand-300)]/50"
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
                          답변 필요
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
                            ref={qi === 0 && oi === 0 ? firstRef : undefined}
                            onClick={() => toggle(qi, opt.label, multi)}
                            className={`text-left rounded-md border px-2.5 py-1.5 transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--brand-300)]/50 ${
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
