import { Check } from 'lucide-react'

/**
 * 파일 1건의 "봤음" 체크. 파일 목록과 diff 헤더가 같은 것을 쓴다 — 두 자리의 모양·문구가
 * 갈리면 같은 상태를 가리키는 표시로 읽히지 않는다.
 *
 * 안 본 파일에서는 빈 네모만 남긴다(늘 체크 아이콘을 보이면 이미 본 것처럼 읽힌다).
 */
export default function ReviewViewedToggle({
  viewed,
  path,
  onToggle,
  size = 'sm'
}: {
  viewed: boolean
  path: string
  onToggle: () => void
  /** 목록의 좁은 행은 sm, diff 헤더는 md. */
  size?: 'sm' | 'md'
}): React.JSX.Element {
  const box = size === 'md' ? 'h-[18px] w-[18px]' : 'h-4 w-4'
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={viewed}
      aria-label={viewed ? `Unmark ${path} as viewed` : `Mark ${path} as viewed`}
      title={viewed ? 'Viewed — click to unmark' : 'Mark as viewed'}
      onClick={(e) => {
        // 목록 행과 diff 헤더 모두 누르면 다른 일이 일어나는 자리다(스크롤 이동·접기).
        e.stopPropagation()
        onToggle()
      }}
      className={
        `grid shrink-0 place-items-center rounded border transition-colors active:scale-90 ${box} ` +
        (viewed
          ? 'border-[var(--success-500)]/50 bg-[var(--success-500)]/20 text-[var(--success-300)]'
          : 'border-[var(--border-2)] text-transparent hover:border-neutral-500 hover:text-neutral-500')
      }
    >
      <Check size={size === 'md' ? 13 : 11} strokeWidth={3} />
    </button>
  )
}
