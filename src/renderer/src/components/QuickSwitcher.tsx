import { useEffect, useMemo, useRef, useState } from 'react'
import { GitBranch, LayoutDashboard, Search } from 'lucide-react'
import { useStore } from '../store'
import { StatusDot } from './Sidebar'
import { orderVisibleWorkspaces, workspaceDisplayName } from '@shared/types'
import type { Workspace } from '@shared/types'

/**
 * 퀵 스위처 한 행. workspace 가 null 이면 Overview 행이다.
 * shortcut 은 사이드바와 동일한 ⌘1–9 번호(상위 9개에만 부여).
 */
type Entry = {
  id: string | null
  label: string
  repoName: string
  branch: string | null
  workspace: Workspace | null
  shortcut?: number
  /** 검색 대상 문자열(소문자). 레포명·표시 이름·브랜치를 모두 포함한다. */
  haystack: string
}

/**
 * 질의가 대상의 부분 수열(subsequence)로 등장하는지. "fxlgn" → "fix-login" 처럼
 * 띄엄띄엄 쳐도 걸리게 해서, 긴 브랜치명을 몇 글자로 좁힐 수 있게 한다.
 */
function fuzzyMatch(haystack: string, query: string): boolean {
  let i = 0
  for (const ch of haystack) {
    if (ch === query[i]) i++
    if (i === query.length) return true
  }
  return query.length === 0
}

/**
 * ⌘K 퀵 스위처. ⌘1–9 는 상위 9개까지만 닿으므로, 워크스페이스가 그보다 많아지면
 * 이 팔레트가 기본 이동 수단이 된다(레포명·표시 이름·브랜치 fuzzy 검색 → ↑↓ → Enter).
 * 목록 순서는 사이드바와 완전히 같다(orderVisibleWorkspaces) — 번호 배지도 그대로 노출한다.
 */
export default function QuickSwitcher({ onClose }: { onClose: () => void }): React.JSX.Element {
  const app = useStore((s) => s.app)!
  const prStatus = useStore((s) => s.prStatus)
  const selectedId = useStore((s) => s.selectedWorkspaceId)
  const select = useStore((s) => s.selectWorkspace)
  const permissions = useStore((s) => s.permissions)
  const compacting = useStore((s) => s.compacting)

  const [query, setQuery] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  const entries = useMemo<Entry[]>(() => {
    const ordered = orderVisibleWorkspaces(app.repos, app.workspaces)
    const repoName = new Map(app.repos.map((r) => [r.id, r.name]))
    const rows: Entry[] = ordered.map((ws, i) => {
      const label = workspaceDisplayName(ws, prStatus[ws.id]?.title)
      const repo = repoName.get(ws.repoId) ?? ''
      return {
        id: ws.id,
        label,
        repoName: repo,
        branch: ws.branch,
        workspace: ws,
        shortcut: i < 9 ? i + 1 : undefined,
        haystack: `${repo} ${label} ${ws.branch}`.toLowerCase()
      }
    })
    // Overview 도 같은 팔레트에서 닿게 해 둔다(활성 워크스페이스가 있을 때만 의미가 있다).
    if (rows.length > 0) {
      rows.unshift({
        id: null,
        label: 'Overview',
        repoName: '',
        branch: null,
        workspace: null,
        haystack: 'overview all sessions'
      })
    }
    return rows
  }, [app.repos, app.workspaces, prStatus])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/\s+/g, '')
    if (!q) return entries
    // 순위 재정렬은 하지 않는다 — 사이드바와 같은 위→아래 순서를 유지해야 번호 배지와
    // 눈으로 익힌 위치 감각이 어긋나지 않는다.
    return entries.filter((e) => fuzzyMatch(e.haystack.replace(/\s+/g, ''), q))
  }, [entries, query])

  // 처음 열릴 때는 '현재 워크스페이스'를 가리킨다 → ⌘K + Enter 가 실수로 다른 곳으로 튀지
  // 않는다(마운트 시 1회만 계산). 질의가 바뀌면 아래 onChange 에서 맨 위로 되돌린다.
  const [cursor, setCursor] = useState(() => {
    const at = entries.findIndex((e) => e.id === selectedId)
    return at > 0 ? at : 0
  })

  // 커서가 목록 밖으로 나가지 않게 고정(필터가 좁아진 경우).
  const active = filtered.length ? Math.min(cursor, filtered.length - 1) : 0

  // 커서 행이 항상 보이게 스크롤한다.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const commit = (entry: Entry | undefined): void => {
    if (!entry) return
    void select(entry.id)
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) {
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault()
      if (filtered.length)
        setCursor((c) => (Math.min(c, filtered.length - 1) + 1) % filtered.length)
      return
    }
    if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault()
      if (filtered.length)
        setCursor((c) => (Math.min(c, filtered.length - 1) - 1 + filtered.length) % filtered.length)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      commit(filtered[active])
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Switch workspace"
        className="no-drag w-[min(560px,92vw)] bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl flex flex-col overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="shrink-0 flex items-center gap-2 px-3 h-12 border-b border-[var(--border)]">
          <Search size={15} className="text-neutral-500 shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setCursor(0)
            }}
            placeholder="Search workspaces by name, branch, or repo…"
            aria-label="Search workspaces"
            className="flex-1 bg-transparent text-base text-neutral-100 placeholder:text-neutral-600 outline-none"
          />
        </div>

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-1">
          {filtered.length === 0 && (
            <p className="px-4 py-6 text-sm text-neutral-500 text-center">No matching workspace.</p>
          )}
          {filtered.map((entry, i) => {
            const ws = entry.workspace
            const isCursor = i === active
            return (
              <div
                key={entry.id ?? '__overview'}
                data-idx={i}
                role="button"
                tabIndex={-1}
                onMouseMove={() => setCursor(i)}
                onClick={() => commit(entry)}
                className={
                  'mx-1 px-2 py-1.5 rounded-md flex items-center gap-2.5 cursor-pointer ' +
                  (isCursor ? 'bg-[var(--surface-3)]' : '')
                }
              >
                {ws ? (
                  <StatusDot
                    status={ws.status}
                    awaitingPermission={permissions.some((p) => p.workspaceId === ws.id)}
                    compacting={compacting[ws.id] ?? false}
                    stale={false}
                    runningMs={0}
                    pr={prStatus[ws.id]}
                  />
                ) : (
                  <LayoutDashboard size={13} className="text-neutral-500 shrink-0" />
                )}

                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-1.5 min-w-0">
                    {entry.repoName && (
                      <span className="text-xs text-neutral-500 shrink-0">{entry.repoName}</span>
                    )}
                    <span
                      className={
                        'truncate text-sm ' + (isCursor ? 'text-neutral-100' : 'text-neutral-300')
                      }
                    >
                      {entry.label}
                    </span>
                  </div>
                  {entry.branch && (
                    <div className="flex items-center gap-1 text-xs text-neutral-500 truncate">
                      <GitBranch size={10} className="shrink-0" />
                      <span className="truncate">{entry.branch}</span>
                    </div>
                  )}
                </div>

                {entry.id === selectedId && (
                  <span className="text-xs text-neutral-500 shrink-0">current</span>
                )}
                {entry.shortcut !== undefined && (
                  <kbd className="text-xs leading-none font-medium text-neutral-600 tabular-nums shrink-0">
                    ⌘{entry.shortcut}
                  </kbd>
                )}
              </div>
            )
          })}
        </div>

        <div className="shrink-0 flex items-center gap-3 px-3 py-2 border-t border-[var(--border)] text-xs text-neutral-500">
          <span>↑↓ navigate</span>
          <span>⏎ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  )
}
