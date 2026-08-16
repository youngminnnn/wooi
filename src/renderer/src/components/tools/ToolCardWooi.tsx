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
        {/* 이름도 줄어들 수 있어야 한다 — MCP 도구는 이름부터 길어서
            ("developerknowledge search documents (plugin_firebase_firebase)") 줄지 못하게 잡아 두면
            행이 대화 폭을 넘고, 대화 전체에 가로 스크롤이 생긴다. 요약은 basis 0 으로 남은 자리만
            차지하므로 이름이 짧을 때의 모습(셰브런은 오른쪽 끝)은 그대로다. */}
        <span className="min-w-0 truncate font-medium text-neutral-300">{name}</span>
        <span className="min-w-0 flex-1 truncate text-neutral-500">
          {pending ? activity : summary}
        </span>
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
