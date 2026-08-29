import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import type { WorkspaceCompareBase } from '@shared/types'

/**
 * `vs <base>` 라벨을 눌러 **무엇과 견줄지**만 고르게 한다.
 *
 * ⚠️ 이 메뉴는 diff 표시만 바꾼다. PR 대상도 rebase 대상도 그대로다 — Wooi 는 스택 PR 이 중심
 * 기능이라 그 오해가 특히 비싸므로, 경계를 주석이 아니라 **메뉴 안 문구로** 말한다. 배선상으로도
 * 이 값은 `IPC.gitDiff` 한 곳에서만 읽힌다([[compareBase]], compareBase.boundary.test).
 *
 * 선택지는 둘뿐이다 — 이 워크스페이스의 base(스택 부모)와 리포의 기본 브랜치. 기본값은 앞의 것,
 * 즉 지금까지의 자동 판정 그대로다.
 */
export default function CompareBasePicker({
  label,
  value,
  parentBranch,
  defaultBranch,
  onChange
}: {
  /** 도구줄에 그대로 보여 줄 문구(`vs origin/main`). 실제로 견주고 있는 ref 다. */
  label: string
  value: WorkspaceCompareBase
  /** 이 워크스페이스의 진짜 base. 스택 위라면 부모 브랜치다. */
  parentBranch: string
  defaultBranch: string
  onChange: (next: WorkspaceCompareBase) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement | null>(null)

  // 바깥을 누르거나 Esc 로 닫는다. 열려 있을 때만 듣는다.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const choose = (next: WorkspaceCompareBase): void => {
    setOpen(false)
    onChange(next)
  }

  return (
    <div ref={root} className="relative min-w-0">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Change what this diff is compared against"
        title="Change what this diff is compared against (does not change the pull request or rebase target)"
        className="flex min-w-0 items-center gap-1 rounded px-1 -mx-1 text-xs text-neutral-500 hover:bg-[var(--surface)] hover:text-neutral-300"
      >
        <span className="truncate">{label}</span>
        <ChevronDown size={10} className="shrink-0" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-30 mt-1 w-64 rounded-lg border border-[var(--border)] bg-[var(--bg-3)] p-1 shadow-lg"
        >
          <Option
            branch={parentBranch}
            hint="This workspace’s base"
            selected={value === 'stack-parent'}
            onSelect={() => choose('stack-parent')}
          />
          <Option
            branch={defaultBranch}
            hint="Repository default branch"
            selected={value === 'default-branch'}
            onSelect={() => choose('default-branch')}
          />
          <p className="border-t border-[var(--border)] px-2 py-1.5 text-[10px] leading-snug text-neutral-500">
            Changes what this diff is measured against. Your pull request base and rebase target
            stay on <span className="font-mono text-neutral-400">{parentBranch}</span>.
          </p>
        </div>
      )}
    </div>
  )
}

function Option({
  branch,
  hint,
  selected,
  onSelect
}: {
  branch: string
  hint: string
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <button
      role="menuitemradio"
      aria-checked={selected}
      onClick={onSelect}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-[var(--surface)]"
    >
      <Check
        size={11}
        className={`shrink-0 ${selected ? 'text-[var(--info-400)]' : 'opacity-0'}`}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-xs text-neutral-200">{branch}</span>
        <span className="block text-[10px] text-neutral-500">{hint}</span>
      </span>
    </button>
  )
}
