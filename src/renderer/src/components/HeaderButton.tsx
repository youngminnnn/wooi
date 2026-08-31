/**
 * 워크스페이스 헤더의 아이콘 버튼. 커스텀 호버 툴팁(설명 + 단축키)을 함께 제공한다.
 * native title 은 지연이 있고 스타일이 없어 대체한다.
 */
export default function HeaderButton({
  children,
  onClick,
  title,
  shortcut,
  active,
  danger,
  indicator,
  hasPopup,
  expanded,
  suppressTooltip,
  disabled,
  dataTour
}: {
  children: React.ReactNode
  onClick: () => void
  title: string
  /** 호버 툴팁에 함께 보여줄 키보드 단축키(예: '⇧⌘E'). */
  shortcut?: string
  active?: boolean
  danger?: boolean
  /** 우상단에 실행 중 표시 점을 띄운다(예: dev 스크립트 실행 중). */
  indicator?: boolean
  /** 드롭다운을 여는 버튼이면 true(aria-haspopup="menu"). */
  hasPopup?: boolean
  /** 드롭다운 열림 상태(aria-expanded). */
  expanded?: boolean
  /** 드롭다운이 열려 있을 때처럼 툴팁이 방해가 되는 경우 숨긴다. */
  suppressTooltip?: boolean
  disabled?: boolean
  /** 점진적 힌트(`lib/hints.ts`)가 이 버튼을 가리킬 때 쓰는 `data-tour` 마커. */
  dataTour?: string
}): React.JSX.Element {
  return (
    <div data-tour={dataTour} className="no-drag group relative inline-flex">
      <button
        onClick={onClick}
        disabled={disabled}
        aria-label={title}
        aria-haspopup={hasPopup ? 'menu' : undefined}
        aria-expanded={hasPopup ? Boolean(expanded) : undefined}
        className={
          'h-7 w-7 grid place-items-center rounded-md active:scale-90 disabled:cursor-not-allowed disabled:opacity-45 disabled:active:scale-100 ' +
          (danger
            ? 'text-neutral-400 hover:bg-[var(--danger-500)]/15 hover:text-[var(--danger-400)]'
            : active
              ? 'bg-[var(--surface-2)] text-neutral-100'
              : 'text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100')
        }
      >
        {children}
      </button>
      {/* 실행 중 표시: 패널을 닫아도 dev 스크립트가 돌고 있음을 알 수 있게 우상단에 점을 띄운다. */}
      {indicator && (
        <span className="pointer-events-none absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[var(--info-400)] ring-2 ring-[var(--bg)]" />
      )}
      {/* 커스텀 호버 툴팁: 한 줄 설명 + 단축키. */}
      {!suppressTooltip && (
        <div className="pointer-events-none absolute right-0 top-full z-50 mt-1.5 hidden items-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-xs text-neutral-200 shadow-lg group-hover:flex">
          <span>{title}</span>
          {shortcut && (
            <kbd className="rounded bg-[var(--surface-4)] px-1 py-0.5 text-[10px] leading-none font-medium tabular-nums text-neutral-300">
              {shortcut}
            </kbd>
          )}
        </div>
      )}
    </div>
  )
}
