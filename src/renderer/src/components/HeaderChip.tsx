import type { ButtonHTMLAttributes } from 'react'

type HeaderChipVariant = 'default' | 'square' | 'joined-left' | 'joined-right'

const neutralTone =
  'bg-[var(--surface)] border-[var(--border)] text-neutral-300 hover:border-[var(--border-strong)]'

const variantClass: Record<HeaderChipVariant, string> = {
  default: 'rounded-md border px-2 inline-flex items-center gap-1.5',
  square: 'w-7 rounded-md border grid place-items-center',
  'joined-left': 'rounded-l-md border px-2 inline-flex items-center gap-1.5',
  'joined-right': 'w-7 rounded-r-md border-y border-r grid place-items-center'
}

/** 헤더의 라벨형 컨트롤. 아이콘 전용 HeaderButton 과 같은 높이·모서리 규칙을 공유한다. */
export default function HeaderChip({
  variant = 'default',
  toneClass = neutralTone,
  className = '',
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: HeaderChipVariant
  /** 상태 배지처럼 중립색이 아닌 경우에는 Tailwind 가 스캔할 수 있는 완전한 클래스 문자열을 넘긴다. */
  toneClass?: string
}): React.JSX.Element {
  return (
    <button
      type={type}
      className={`h-7 text-xs disabled:opacity-60 ${variantClass[variant]} ${toneClass} ${className}`}
      {...props}
    />
  )
}
