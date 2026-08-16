import { ChevronRight, Loader2, Wrench } from 'lucide-react'
import type { ToolCardStyleProps } from './styleProps'

/** Wooi 고유의 도구 로그 외형 — 아이콘·셰브런·카드 면. 대화의 나머지와 같은 언어를 쓴다. */
export function ToolCardWooi({
  name,
  summary,
  activity,
  pending,
  open,
  toggle,
  stat,
  result,
  details,
  children
}: ToolCardStyleProps): React.JSX.Element {
  return (
    <div className="text-sm">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-1.5 text-left text-neutral-400 hover:text-neutral-200"
      >
        {pending ? (
          <Loader2 size={12} className="shrink-0 animate-spin text-[var(--warning-500)]/80" />
        ) : (
          <Wrench size={12} className="shrink-0 text-[var(--warning-500)]/80" />
        )}
        <span className="shrink-0 font-medium text-neutral-300">{name}</span>
        <span className="truncate text-neutral-500">{pending ? activity : summary}</span>
        {stat && (
          <span className="shrink-0 tabular-nums text-xs">
            <span className="text-[var(--diff-add)]">+{stat.added}</span>{' '}
            <span className="text-[var(--diff-del)]">−{stat.removed}</span>
          </span>
        )}
        <ChevronRight
          size={12}
          className={`${open ? 'rotate-90 ' : ''}ml-auto shrink-0 transition`}
        />
      </button>
      {children}
      {result && (
        <div className="ml-4 mt-1 rounded-md border border-[var(--border)] bg-[var(--bg-3)] p-2 text-xs text-neutral-500">
          {result}
        </div>
      )}
      {open && details}
    </div>
  )
}
