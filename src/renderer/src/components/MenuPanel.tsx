import type { HTMLAttributes } from 'react'

export const menuItemCls =
  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-neutral-200 hover:bg-[var(--surface-2)] disabled:opacity-40 disabled:hover:bg-transparent'

/** 헤더 드롭다운이 같은 표면·테두리·항목 밀도를 쓰도록 하는 공통 패널. */
export default function MenuPanel({
  className = '',
  ...props
}: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={`rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] py-1 shadow-xl ${className}`}
      {...props}
    />
  )
}
