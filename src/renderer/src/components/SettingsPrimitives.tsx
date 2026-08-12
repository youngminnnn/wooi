/**
 * 설정 화면의 공용 레이아웃 조각.
 *
 * SettingsModal 안에 두면 페이지를 별도 파일로 뺄 때마다 모달 ↔ 페이지 순환 import 가 생기므로,
 * 어느 쪽도 의존하지 않는 이 파일에 모아 둔다.
 */

export function PageFrame({
  title,
  description,
  children
}: {
  title: string
  description: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="mx-auto max-w-2xl">
      <h2 className="text-xl font-semibold text-neutral-100">{title}</h2>
      <p className="mt-1 mb-6 text-sm text-neutral-500">{description}</p>
      <div className="space-y-6">{children}</div>
    </div>
  )
}

export function SettingGroup({
  title,
  action,
  children
}: {
  title: string
  /** 그룹 헤더 오른쪽에 붙는 동작(예: "Add server"). */
  action?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="overflow-hidden rounded-xl border border-[var(--border)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--bg-2)]/45 px-4 py-2.5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">{title}</h3>
        {action}
      </div>
      <div className="divide-y divide-[var(--border)]">{children}</div>
    </section>
  )
}

export function SettingRow({
  title,
  description,
  children
}: {
  title: string
  description?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3.5">
      <div className="min-w-0">
        <div className="text-sm font-medium text-neutral-200">{title}</div>
        {description && (
          <p className="mt-0.5 text-xs leading-relaxed text-neutral-600">{description}</p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function Switch({
  checked,
  onChange,
  label,
  disabled
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 rounded-full transition-colors disabled:opacity-40 ${checked ? 'bg-[var(--info-600)]' : 'bg-[var(--border-2)]'}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : 'translate-x-0'}`}
      />
    </button>
  )
}
