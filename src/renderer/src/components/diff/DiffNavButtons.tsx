import { ChevronDown, ChevronUp } from 'lucide-react'
import { useDiffNav } from './diffNav'

/**
 * diff 헤더의 이전/다음 변경 버튼.
 *
 * 개수 컨텍스트를 읽는 **유일한** 소비자다 — 파일을 펼쳐 덩어리 수가 바뀌면 이 두 버튼만
 * 다시 그려지고 diff 본문은 그대로 있는다([[diffNav]] 의 컨텍스트 분리 참고).
 */
export default function DiffNavButtons(): React.JSX.Element {
  const { count, goPrev, goNext } = useDiffNav()
  // 접혀 있거나 너무 커서 그리지 않은 파일에는 뛸 자리가 없다. 없는 곳으로 보내지 않는다.
  const disabled = count === 0
  const suffix = disabled ? '' : ` — ${count} change${count > 1 ? 's' : ''} in view`

  const cls =
    'grid h-6 w-6 place-items-center rounded text-neutral-500 hover:bg-[var(--surface-2)] hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-neutral-500'

  return (
    <span className="inline-flex items-center">
      <button
        onClick={goPrev}
        disabled={disabled}
        title={`Previous change (⇧F7)${suffix}`}
        aria-label="Previous change"
        className={cls}
      >
        <ChevronUp size={13} />
      </button>
      <button
        onClick={goNext}
        disabled={disabled}
        title={`Next change (F7)${suffix}`}
        aria-label="Next change"
        className={cls}
      >
        <ChevronDown size={13} />
      </button>
    </span>
  )
}
