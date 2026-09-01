import { useEffect, useMemo, useRef, useState } from 'react'
import {
  GitBranch,
  Keyboard,
  LayoutDashboard,
  Search,
  Settings2,
  SlidersHorizontal,
  TerminalSquare
} from 'lucide-react'
import { backgroundTaskCount, useStore } from '../store'
import { useNow } from '../lib/useNow'
import { runningFor } from '../lib/workspaceStatus'
import { StatusDot } from './StatusDot'
import {
  buildActionItems,
  buildCommandItems,
  buildSettingItems,
  flattenSections,
  paletteSections,
  PALETTE_PREFIXES,
  type PaletteContext,
  type PaletteEffect,
  type PaletteItem
} from '../lib/commandPalette'
import {
  activeRateLimitPause,
  orderVisibleWorkspaces,
  wasInterrupted,
  workspaceDisplayName
} from '@shared/types'
import type { Workspace } from '@shared/types'

/**
 * ⌘K 명령 팔레트. **워크스페이스 이동창이었던 것을 "이 앱이 할 수 있는 일" 전체의 입구로 넓혔다.**
 *
 * 넓힌 이유는 밀도다. Wooi 에는 단축키 90여 개와 `/wooi:*` 20개, 설정 8쪽이 있는데 그 목록들이
 * 각자 다른 문 뒤에 있었다 — 단축키는 `?` 도움말에, 커맨드는 입력창 자동완성에, 설정은 설정
 * 모달 안의 또 다른 검색창에. "그 기능이 있었나" 를 확인하려면 어느 문인지부터 알아야 했다.
 * 검색창을 하나 더 만드는 대신 이미 손에 익은 ⌘K 를 넓힌 것은, 검색창이 둘이면 "어느 쪽에서
 * 찾지" 라는 질문이 하나 더 생기기 때문이다.
 *
 * 항목의 재료는 전부 이미 있던 목록이다([[lib/commandPalette]]). 여기서는 그리기만 한다.
 */
export default function QuickSwitcher({
  onClose,
  context,
  onRun
}: {
  onClose: () => void
  /** 동작이 지금 가능한지 판정하는 데 쓰는 앱 상태. App 이 만든다. */
  context: PaletteContext
  /** 고른 항목을 실행한다. 전역 단축키와 **같은** 몸통을 부른다. */
  onRun: (effect: PaletteEffect) => void
}): React.JSX.Element {
  const app = useStore((s) => s.app)!
  const prStatus = useStore((s) => s.prStatus)
  const selectedId = useStore((s) => s.selectedWorkspaceId)
  const permissions = useStore((s) => s.permissions)
  const compacting = useStore((s) => s.compacting)
  const runningAgents = useStore((s) => s.runningAgents)
  const runningSince = useStore((s) => s.runningSince)

  const [query, setQuery] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  // 제한 표시가 아직 유효한지 판단하는 기준 시각. 팔레트는 잠깐 떠 있다 사라지므로 흐를 필요는
  // 없지만, 렌더 중에 Date.now() 를 부르지 않으려면 훅으로 받아야 한다.
  const now = useNow(60_000)

  // 워크스페이스 행은 StatusDot 을 그려야 해서 원본이 필요하다. 인덱스(순수 함수)를 shared 타입에
  // 묶지 않으려고, 항목과 나란히 key → workspace 표를 같이 만들어 둔다.
  const { items, workspaceByKey } = useMemo<{
    items: PaletteItem[]
    workspaceByKey: Map<string, Workspace>
  }>(() => {
    const ordered = orderVisibleWorkspaces(app.repos, app.workspaces)
    const repoName = new Map(app.repos.map((r) => [r.id, r.name]))
    const map = new Map<string, Workspace>()

    const rows: PaletteItem[] = ordered.map((ws, i) => {
      const label = workspaceDisplayName(ws, prStatus[ws.id]?.title)
      const repo = repoName.get(ws.repoId) ?? ''
      const key = `ws:${ws.id}`
      map.set(key, ws)
      return {
        key,
        kind: 'workspace' as const,
        label,
        prefix: repo,
        detail: ws.branch ?? undefined,
        // 사이드바와 같은 ⌘1–9 번호(상위 9개에만 부여).
        keys: i < 9 ? [`⌘${i + 1}`] : undefined,
        haystack: `${repo} ${label} ${ws.branch} ${ws.prNumber ?? ''}`.toLowerCase(),
        effect: { type: 'select-workspace' as const, workspaceId: ws.id }
      }
    })

    // Overview 도 같은 팔레트에서 닿게 해 둔다(활성 워크스페이스가 있을 때만 의미가 있다).
    if (rows.length > 0) {
      rows.unshift({
        key: '__overview',
        kind: 'workspace',
        label: 'Overview',
        haystack: 'overview all sessions',
        effect: { type: 'select-workspace', workspaceId: null }
      })
    }

    // 리포 설정은 그동안 사이드바 톱니 하나로만 닿을 수 있었다 — 단축키도, 메뉴도 없었다.
    for (const repo of app.repos) {
      rows.push({
        key: `repo:${repo.id}`,
        kind: 'workspace',
        label: `Repo settings — ${repo.name}`,
        haystack:
          `repo settings ${repo.name} setup dev archive script carry env claude.local.md`.toLowerCase(),
        effect: { type: 'repo-settings', repoId: repo.id }
      })
    }

    return {
      items: [
        ...rows,
        ...buildActionItems(context),
        ...buildCommandItems(context),
        ...buildSettingItems()
      ],
      workspaceByKey: map
    }
  }, [app.repos, app.workspaces, prStatus, context])

  const sections = useMemo(() => paletteSections(items, query), [items, query])
  const flat = useMemo(() => flattenSections(sections), [sections])

  // 처음 열릴 때는 '현재 워크스페이스'를 가리킨다 → ⌘K + Enter 가 실수로 다른 곳으로 튀지
  // 않는다(마운트 시 1회만 계산). 질의가 바뀌면 아래 onChange 에서 맨 위로 되돌린다.
  const [cursor, setCursor] = useState(() => {
    const at = items.findIndex(
      (e) => e.effect?.type === 'select-workspace' && e.effect.workspaceId === selectedId
    )
    return at > 0 ? at : 0
  })

  // 커서가 목록 밖으로 나가지 않게 고정(필터가 좁아진 경우).
  const active = flat.length ? Math.min(cursor, flat.length - 1) : 0

  // 커서 행이 항상 보이게 스크롤한다.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const commit = (item: PaletteItem | undefined): void => {
    // 비활성 행은 왜 안 되는지 이미 옆에 적혀 있다. 여기서 토스트를 하나 더 띄우지 않는다.
    if (!item?.effect || item.disabledReason) return
    onClose()
    onRun(item.effect)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    // 한글 IME 로 조합 중인 Enter 는 "글자를 확정한다" 는 뜻이지 "이걸 실행한다" 가 아니다.
    if (e.nativeEvent.isComposing) return
    // ⌘K 로 닫기. 키 판별은 e.code 로 한다 — 한글 IME 에서 e.key 가 'k' 가 아닐 수 있다.
    if (e.key === 'Escape' || ((e.metaKey || e.ctrlKey) && e.code === 'KeyK')) {
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault()
      if (flat.length) setCursor((c) => (Math.min(c, flat.length - 1) + 1) % flat.length)
      return
    }
    if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault()
      if (flat.length)
        setCursor((c) => (Math.min(c, flat.length - 1) - 1 + flat.length) % flat.length)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      commit(flat[active])
    }
  }

  const iconFor = (item: PaletteItem): React.JSX.Element => {
    const ws = workspaceByKey.get(item.key)
    if (ws) {
      return (
        <StatusDot
          status={ws.status}
          awaitingPermission={permissions.some((p) => p.workspaceId === ws.id)}
          interrupted={wasInterrupted(ws)}
          compacting={compacting[ws.id] ?? false}
          {...runningFor(ws, runningSince[ws.id], now)}
          pendingRateLimitResume={ws.pendingRateLimitResume}
          awaitingStackedWork={ws.awaitingStackedWork}
          rateLimited={activeRateLimitPause(ws.rateLimited, now)}
          backgroundTasks={backgroundTaskCount(runningAgents[ws.id])}
          pr={prStatus[ws.id]}
        />
      )
    }
    const cls = 'text-neutral-500 shrink-0'
    if (item.effect?.type === 'repo-settings') return <Settings2 size={13} className={cls} />
    if (item.kind === 'setting') return <SlidersHorizontal size={13} className={cls} />
    if (item.kind === 'command') return <TerminalSquare size={13} className={cls} />
    if (item.kind === 'action') return <Keyboard size={13} className={cls} />
    return <LayoutDashboard size={13} className={cls} />
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
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
            placeholder="Search workspaces, actions, commands and settings…"
            aria-label="Search workspaces, actions, commands and settings"
            className="flex-1 bg-transparent text-base text-neutral-100 placeholder:text-neutral-600 outline-none"
          />
        </div>

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-1">
          {flat.length === 0 && (
            <p className="px-4 py-6 text-sm text-neutral-500 text-center">No matching result.</p>
          )}
          {sections.map((section, si) => {
            // 커서는 평평한 목록 위에서 움직인다 — 이 섹션의 첫 행이 그 목록의 몇 번째인지.
            // 섹션은 넷을 넘지 않으므로 앞을 다시 세도 값이 싸다.
            const offset = sections.slice(0, si).reduce((n, sec) => n + sec.items.length, 0)
            return (
              <div key={section.kind}>
                <div className="px-3 pt-2 pb-1 text-xs font-medium uppercase tracking-wide text-neutral-600">
                  {section.title}
                </div>
                {section.items.map((item, k) => {
                  const i = offset + k
                  const isCursor = i === active
                  const disabled = !!item.disabledReason
                  const isCurrent =
                    item.effect?.type === 'select-workspace' &&
                    item.effect.workspaceId === selectedId &&
                    item.key !== '__overview'
                  return (
                    <div
                      key={item.key}
                      data-idx={i}
                      role="button"
                      aria-disabled={disabled}
                      tabIndex={-1}
                      onMouseMove={() => setCursor(i)}
                      onClick={() => commit(item)}
                      className={
                        'mx-1 px-2 py-1.5 rounded-md flex items-center gap-2.5 ' +
                        (disabled ? 'cursor-default ' : 'cursor-pointer ') +
                        (isCursor ? 'bg-[var(--surface-3)]' : '')
                      }
                    >
                      <span className={disabled ? 'opacity-40' : undefined}>{iconFor(item)}</span>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-1.5 min-w-0">
                          {item.prefix && (
                            <span className="text-xs text-neutral-500 shrink-0">{item.prefix}</span>
                          )}
                          <span
                            className={
                              'truncate text-sm ' +
                              (disabled
                                ? 'text-neutral-600'
                                : isCursor
                                  ? 'text-neutral-100'
                                  : 'text-neutral-300')
                            }
                          >
                            {item.label}
                          </span>
                        </div>
                        {/* 왜 지금 안 되는지를 숨기지 않고 그 자리에 적는다 — 목록에서 빼 버리면
                          사용자는 그 기능이 없는 앱을 보게 된다. */}
                        {disabled ? (
                          <div className="text-xs text-neutral-600 truncate">
                            {item.disabledReason}
                          </div>
                        ) : (
                          item.detail && (
                            <div className="flex items-center gap-1 text-xs text-neutral-500 truncate">
                              {item.kind === 'workspace' && (
                                <GitBranch size={10} className="shrink-0" />
                              )}
                              <span className="truncate">{item.detail}</span>
                            </div>
                          )
                        )}
                      </div>

                      {isCurrent && (
                        <span className="text-xs text-neutral-500 shrink-0">current</span>
                      )}
                      {item.keys && (
                        <span className="flex items-center gap-1 shrink-0">
                          {item.keys.map((k, j) =>
                            k === '–' || k === '/' ? (
                              <span key={j} className="text-xs text-neutral-700">
                                {k}
                              </span>
                            ) : (
                              <kbd
                                key={j}
                                className="text-xs leading-none font-medium text-neutral-600 tabular-nums"
                              >
                                {k}
                              </kbd>
                            )
                          )}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>

        <div className="shrink-0 flex items-center gap-3 px-3 py-2 border-t border-[var(--border)] text-xs text-neutral-500">
          <span>↑↓ navigate</span>
          <span>⏎ run</span>
          <span>esc close</span>
          {/* 접두사는 알면 빠르고 몰라도 손해가 없다 — 그냥 쳐도 네 종류를 다 훑는다. */}
          <span className="ml-auto text-neutral-600">
            {PALETTE_PREFIXES.map((p) => `${p.prefix} ${p.kind}`).join('   ')}
          </span>
        </div>
      </div>
    </div>
  )
}
