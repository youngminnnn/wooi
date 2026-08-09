import { useEffect, useMemo, useRef, useState } from 'react'
import { Archive, GitBranch, Loader2, Search } from 'lucide-react'
import { useStore } from '../store'
import { workspaceDisplayName } from '@shared/types'
import type { ChatItem, TranscriptHit, TranscriptSearchResult } from '@shared/types'

/** 마지막 입력 뒤 이만큼 조용해야 실제로 훑는다 — 워크스페이스가 수십 개면 한 타에 한 번은 비싸다. */
const DEBOUNCE_MS = 220
/** 이보다 짧은 질의는 훑지 않는다(한 글자는 거의 모든 대화에 걸려 결과가 무의미해진다). */
const MIN_QUERY = 2

/** 결과 목록 한 줄. 워크스페이스 머리글과 매치 행이 같은 배열에 섞여 있다. */
type Row =
  | {
      kind: 'header'
      key: string
      workspaceId: string
      repoName: string
      label: string
      branch: string | null
      archived: boolean
    }
  | { kind: 'hit'; key: string; hit: TranscriptHit }

/**
 * ⇧⌘K 대화 검색 — 워크스페이스를 가로질러 대화 내용을 찾는다.
 *
 * ⌘K 퀵 스위처와 일부러 나눠 뒀다. 퀵 스위처는 이름만 보고 즉답하는 전환기라 손에 붙어 있어야
 * 하는데, 디스크를 훑는 비동기 검색을 같은 자리에 섞으면 그 즉답성이 깨진다. 목록·키보드
 * 조작은 [[QuickSwitcher]] 와 같은 결로 맞춰 두 팔레트가 다르게 느껴지지 않게 했다.
 *
 * 훑는 일은 전부 main 에서 끝난다 — 여기로 오는 것은 매치 스니펫뿐이다.
 */
export default function TranscriptSearch({ onClose }: { onClose: () => void }): React.JSX.Element {
  const app = useStore((s) => s.app)!
  const prStatus = useStore((s) => s.prStatus)
  const jumpTo = useStore((s) => s.jumpToTranscriptItem)

  const [query, setQuery] = useState('')
  const [result, setResult] = useState<TranscriptSearchResult | null>(null)
  const [searching, setSearching] = useState(false)
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  /** 늦게 도착한 옛 응답이 새 질의의 결과를 덮어쓰지 않게 하는 순번. */
  const seq = useRef(0)

  const trimmed = query.trim()

  useEffect(() => {
    if (trimmed.length < MIN_QUERY) {
      seq.current++
      setResult(null)
      setSearching(false)
      return
    }
    setSearching(true)
    const mine = ++seq.current
    const timer = setTimeout(() => {
      void window.api.chat.search(trimmed).then((res) => {
        if (seq.current !== mine) return
        setResult(res)
        setSearching(false)
        setCursor(0)
      })
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [trimmed])

  // 결과를 워크스페이스별로 묶는다. main 이 이미 워크스페이스 단위로 모아 최근 순으로
  // 정렬해 보내므로, 여기서는 경계마다 머리글만 끼워 넣으면 된다.
  const rows = useMemo<Row[]>(() => {
    if (!result) return []
    const byId = new Map(app.workspaces.map((w) => [w.id, w]))
    const repoName = new Map(app.repos.map((r) => [r.id, r.name]))
    const out: Row[] = []
    let current: string | null = null
    for (const hit of result.hits) {
      if (hit.workspaceId !== current) {
        current = hit.workspaceId
        const ws = byId.get(hit.workspaceId)
        out.push({
          kind: 'header',
          key: `h:${hit.workspaceId}`,
          workspaceId: hit.workspaceId,
          repoName: ws ? (repoName.get(ws.repoId) ?? '') : '',
          label: ws ? workspaceDisplayName(ws, prStatus[ws.id]?.title) : hit.workspaceId,
          branch: ws?.branch ?? null,
          archived: !!ws?.archived
        })
      }
      out.push({ kind: 'hit', key: `${hit.workspaceId}:${hit.itemId}`, hit })
    }
    return out
  }, [result, app.workspaces, app.repos, prStatus])

  // 커서는 매치 행 위에서만 움직인다 — 머리글은 고를 수 있는 대상이 아니다.
  const hitRows = useMemo(() => rows.filter((r) => r.kind === 'hit'), [rows])
  const active = hitRows.length ? Math.min(cursor, hitRows.length - 1) : 0

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const commit = (row: Row | undefined): void => {
    if (!row || row.kind !== 'hit') return
    void jumpTo(row.hit.workspaceId, row.hit.itemId)
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault()
      if (hitRows.length) setCursor((c) => (Math.min(c, hitRows.length - 1) + 1) % hitRows.length)
      return
    }
    if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault()
      if (hitRows.length)
        setCursor((c) => (Math.min(c, hitRows.length - 1) - 1 + hitRows.length) % hitRows.length)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      commit(hitRows[active])
    }
  }

  let hitIndex = -1

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[10vh]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search conversations"
        className="no-drag w-[min(680px,94vw)] bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl flex flex-col overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="shrink-0 flex items-center gap-2 px-3 h-12 border-b border-[var(--border)]">
          {searching ? (
            <Loader2 size={15} className="text-neutral-500 shrink-0 animate-spin" />
          ) : (
            <Search size={15} className="text-neutral-500 shrink-0" />
          )}
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search every conversation…"
            aria-label="Search conversations across workspaces"
            className="flex-1 bg-transparent text-base text-neutral-100 placeholder:text-neutral-600 outline-none"
          />
        </div>

        <div ref={listRef} className="max-h-[58vh] overflow-y-auto py-1">
          {trimmed.length < MIN_QUERY ? (
            <p className="px-4 py-6 text-sm text-neutral-500 text-center">
              Type at least {MIN_QUERY} characters to search across all workspaces.
            </p>
          ) : result && rows.length === 0 && !searching ? (
            <p className="px-4 py-6 text-sm text-neutral-500 text-center">
              No conversation mentions “{trimmed}”.
            </p>
          ) : (
            rows.map((row) => {
              if (row.kind === 'header') {
                return (
                  <div
                    key={row.key}
                    className="flex items-center gap-1.5 px-3 pt-2.5 pb-1 text-xs text-neutral-500"
                  >
                    {row.repoName && <span className="shrink-0">{row.repoName}</span>}
                    <span className="truncate text-neutral-300">{row.label}</span>
                    {row.archived && (
                      <span className="inline-flex items-center gap-0.5 shrink-0 text-neutral-600">
                        <Archive size={10} />
                        archived
                      </span>
                    )}
                    {row.branch && (
                      <span className="inline-flex min-w-0 items-center gap-1 text-neutral-600">
                        <GitBranch size={10} className="shrink-0" />
                        <span className="truncate">{row.branch}</span>
                      </span>
                    )}
                  </div>
                )
              }
              hitIndex++
              const idx = hitIndex
              const isCursor = idx === active
              return (
                <div
                  key={row.key}
                  data-idx={idx}
                  role="button"
                  tabIndex={-1}
                  onMouseMove={() => setCursor(idx)}
                  onClick={() => commit(row)}
                  className={
                    'mx-1 px-2 py-1.5 rounded-md flex items-start gap-2 cursor-pointer ' +
                    (isCursor ? 'bg-[var(--surface-3)]' : '')
                  }
                >
                  <span className="shrink-0 w-14 pt-px text-xs text-neutral-600 truncate">
                    {kindLabel(row.hit.kind)}
                  </span>
                  <span
                    className={
                      'min-w-0 flex-1 text-sm truncate ' +
                      (isCursor ? 'text-neutral-200' : 'text-neutral-400')
                    }
                  >
                    <Snippet hit={row.hit} />
                  </span>
                </div>
              )
            })
          )}
        </div>

        <div className="shrink-0 flex items-center gap-3 px-3 py-2 border-t border-[var(--border)] text-xs text-neutral-500">
          <span className="shrink-0">↑↓ navigate</span>
          <span className="shrink-0">⏎ open</span>
          <span className="shrink-0">esc close</span>
          {/* 잘린 결과를 조용히 넘기지 않는다 — 못 본 것이 있다는 사실 자체가 정보다. */}
          {result?.truncated && (
            <span className="ml-auto min-w-0 text-right text-[var(--warning-300)]">
              Showing the first {result.hits.length} matches
              {result.skipped > 0 && ` — ${result.skipped} more workspaces not searched`}. Narrow
              the search to see the rest.
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

/** 매치 구간만 강조한 스니펫. 위치는 main 이 스니펫 기준으로 계산해 보낸다. */
function Snippet({ hit }: { hit: TranscriptHit }): React.JSX.Element {
  const { snippet, matchStart, matchLength } = hit
  const before = snippet.slice(0, matchStart)
  const match = snippet.slice(matchStart, matchStart + matchLength)
  const after = snippet.slice(matchStart + matchLength)
  return (
    <>
      {before}
      <mark className="bg-[var(--accent-500)]/25 text-neutral-100 rounded-sm">{match}</mark>
      {after}
    </>
  )
}

/** 항목 종류를 결과 행 앞에 붙일 짧은 라벨로. */
function kindLabel(kind: ChatItem['type']): string {
  switch (kind) {
    case 'user':
      return 'you'
    case 'assistant':
      return 'agent'
    case 'thinking':
      return 'thinking'
    case 'tool_use':
      return 'tool'
    case 'tool_result':
      return 'output'
    case 'bash':
      return 'command'
    case 'task':
      return 'workflow'
    case 'handoff':
      return 'handoff'
    default:
      return kind
  }
}
