import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ClipboardCheck } from 'lucide-react'
import { useStore } from '../store'
import { SELECTABLE, unlessSelecting } from '../lib/selection'
import { planOptions } from '@shared/types'
import type { PermissionOption, PermissionRequest } from '@shared/types'

/**
 * ExitPlanMode 승인 프롬프트 — "이 계획대로 진행할까?" 의 갈림길.
 *
 * 일반 도구 승인(Allow/Deny)과 달리 승인 뒤 **어떤 권한 모드로 코딩을 시작할지**까지 함께
 * 고른다. 계획 본문이 길어 판단 재료가 되므로 요약 한 줄이 아니라 마크다운 전문을 보여 준다.
 *
 *   1–3        선택지 즉시 실행
 *   ↑/↓ + ⏎    커서 이동 후 실행
 *   Esc        계획 계속(거부)
 */
export default function PlanPrompt({ request }: { request: PermissionRequest }): React.JSX.Element {
  const dismiss = useStore((s) => s.dismissPermission)
  const options = useMemo<PermissionOption[]>(
    // 폴백은 실제로 쓰이지 않는다 — 세션이 항상 options 를 실어 보낸다(claude/session.ts).
    () => (request.options?.length ? request.options : planOptions(true)),
    [request.options]
  )
  const plan = typeof request.input.plan === 'string' ? request.input.plan : ''
  const [cursor, setCursor] = useState(0)
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([])

  const respond = (option: PermissionOption): void => {
    void window.api.permission.respond(
      request.requestId,
      option.behavior === 'allow'
        ? { behavior: 'allow', optionId: option.id }
        : { behavior: 'deny', optionId: option.id }
    )
    dismiss(request.requestId)
  }

  // 커서가 가리키는 버튼에 실제 포커스를 준다(마운트 직후 첫 선택지 포커스도 이 이펙트가 한다).
  useEffect(() => {
    rowRefs.current[cursor]?.focus()
  }, [cursor])

  // 핸들러가 최신 cursor/options 를 봐야 하므로 매 렌더 ref 를 갱신하고 리스너는 한 번만 건다.
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keyRef.current = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === 'Escape') {
      e.preventDefault()
      // Esc 는 "계획 계속" — 승인 프롬프트의 Esc=거부 규칙과 같은 방향이다.
      const deny = options.find((o) => o.behavior === 'deny')
      if (deny) respond(deny)
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => {
        const next = c + (e.key === 'ArrowDown' ? 1 : -1)
        return Math.min(options.length - 1, Math.max(0, next))
      })
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const option = options[cursor]
      if (option) respond(option)
      return
    }
    if (e.key >= '1' && e.key <= '9') {
      const option = options[Number(e.key) - 1]
      if (!option) return
      e.preventDefault()
      respond(option)
    }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => keyRef.current(e)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="shrink-0 mx-4 mb-2 flex max-h-[55vh] flex-col rounded-xl border border-[var(--brand-500)]/30 bg-[var(--brand-500)]/10 px-3.5 py-3 shadow-lg">
      <div className="flex min-h-0 flex-1 gap-2.5">
        <ClipboardCheck size={16} className="text-[var(--brand-400)] mt-0.5 shrink-0 self-start" />
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="text-sm text-neutral-100">{request.title ?? 'Ready to code?'}</div>
          {plan && (
            <div className="md mt-1.5 text-sm text-neutral-300">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{plan}</ReactMarkdown>
            </div>
          )}
        </div>
      </div>

      <div className="mt-2.5 flex shrink-0 flex-col gap-1">
        {options.map((option, i) => (
          <button
            key={option.id}
            ref={(el) => {
              rowRefs.current[i] = el
            }}
            onFocus={() => setCursor(i)}
            onClick={unlessSelecting(() => respond(option))}
            className={
              `${SELECTABLE} rounded-md border px-2.5 py-1.5 text-left transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--brand-300)]/50 ` +
              (cursor === i
                ? 'border-[var(--brand-400)]/60 bg-[var(--brand-500)]/15'
                : 'border-neutral-700/60 hover:bg-[var(--surface-2)]')
            }
          >
            <div className="flex items-center gap-2">
              <span className="text-sm text-neutral-100">{option.label}</span>
              {i < 9 && (
                <span className="ml-auto shrink-0 text-2xs text-neutral-500 tabular-nums">
                  {i + 1}
                </span>
              )}
            </div>
            {option.description && (
              <div className="mt-0.5 text-xs text-neutral-400">{option.description}</div>
            )}
          </button>
        ))}
      </div>
      <div className="mt-1.5 hidden shrink-0 text-xs text-neutral-500 sm:block">
        1–{options.length} choose · ↑↓ move · ⏎ select · Esc keep planning
      </div>
    </div>
  )
}
