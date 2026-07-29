import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import {
  ChevronRight,
  Wrench,
  Brain,
  AlertTriangle,
  Check,
  Copy,
  Loader2,
  ArrowDown,
  ArrowUp,
  ImageIcon,
  Workflow,
  XCircle,
  MessageSquarePlus,
  Terminal as TerminalIcon,
  Search,
  X,
  Square,
  ListTodo
} from 'lucide-react'
import { useStore } from '../store'
import { formatTime } from '../lib/format'
import { buildTaskCards, taskLabel, type TaskEntry } from '../lib/tasks'
import type { ChatItem } from '@shared/types'

export default function MessageList({
  workspaceId,
  running
}: {
  workspaceId: string
  running: boolean
}): React.JSX.Element {
  const items = useStore((s) => s.transcripts[workspaceId]) ?? EMPTY
  // 스크롤 위치는 저장만 하고 구독하지 않는다(스크롤마다 재렌더 방지). 복원은 마운트 시 1회.
  const setScroll = useStore((s) => s.setScrollPosition)
  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  // 트랜스크립트는 비동기로 로드되므로, 내용이 처음 채워질 때 스크롤 위치를 1회 복원한다.
  const restoredRef = useRef(false)
  const [showJump, setShowJump] = useState(false)

  // 할 일 도구 호출들을 체크리스트 카드로 묶는다. 카드로 대체된 도구 행·결과는 목록 단계에서
  // 걸러 내, 검색과 스크롤도 실제로 보이는 항목만 대상으로 삼게 한다.
  const { visibleItems, resolved, cardByItemId, latestCardItemId } = useMemo(() => {
    const { cardByItemId: cards, hiddenItemIds } = buildTaskCards(items)
    const resolvedIds = new Set<string>()
    for (const it of items) if (it.type === 'tool_result') resolvedIds.add(it.toolId)
    return {
      cardByItemId: cards,
      resolved: resolvedIds,
      // 진행 중 스피너는 마지막 카드에만 붙인다 — 앞선 카드들은 이미 지나간 스냅샷이라,
      // 전부 돌면 어떤 것이 지금 상태인지 알 수 없게 된다.
      latestCardItemId: cards.size ? Array.from(cards.keys())[cards.size - 1] : undefined,
      visibleItems: hiddenItemIds.size ? items.filter((it) => !hiddenItemIds.has(it.id)) : items
    }
  }, [items])

  // ── 대화 내 검색(⌘F) ─────────────────────────────────────────────────────
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return [] as string[]
    return visibleItems
      .filter((it) => {
        // 체크리스트로 대체된 자리는 도구 이름 대신 화면에 실제로 뜬 항목 제목으로 검색한다.
        const card = cardByItemId.get(it.id)
        const text = card ? card.map(taskLabel).join('\n') : itemText(it)
        return text.toLowerCase().includes(q)
      })
      .map((it) => it.id)
  }, [visibleItems, cardByItemId, query])

  // 검색어가 바뀌면 첫 매치부터 다시 훑는다.
  useEffect(() => setActiveIdx(0), [query])

  // ⌘F / Ctrl+F 로 검색바를 연다(입력창 등 다른 곳에 포커스가 있어도 대화 검색을 우선한다).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSearchOpen(true)
        setTimeout(() => searchInputRef.current?.select(), 0)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 검색어 변경으로 matches 가 줄어들면 setActiveIdx(0) 이펙트가 커밋되기 전 프레임에서 activeIdx 가
  // 범위를 벗어날 수 있다 — 카운터/하이라이트/스크롤 모두 클램프한 인덱스를 쓴다.
  const safeIdx = matches.length ? Math.min(activeIdx, matches.length - 1) : 0

  // 활성 매치를 화면 중앙으로 스크롤한다.
  useEffect(() => {
    if (!searchOpen || matches.length === 0) return
    const el = containerRef.current?.querySelector(`[data-item-id="${cssAttr(matches[safeIdx])}"]`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [safeIdx, matches, searchOpen])

  const activeMatchId = searchOpen ? matches[safeIdx] : undefined
  const stepMatch = (dir: 1 | -1): void => {
    if (!matches.length) return
    setActiveIdx((i) => (i + dir + matches.length) % matches.length)
  }
  const closeSearch = (): void => {
    setSearchOpen(false)
    setQuery('')
  }

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    // 내용이 처음 채워지는 순간: 저장된 스크롤 위치가 있으면 복원(없으면 아래로).
    if (!restoredRef.current && items.length > 0) {
      restoredRef.current = true
      const saved = useStore.getState().scrollPositions[workspaceId]
      if (typeof saved === 'number') {
        el.scrollTop = saved
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200
        atBottomRef.current = atBottom
        setShowJump(!atBottom)
        return
      }
    }

    // 그 외에는 사용자가 하단 근처일 때만 새 내용을 따라 내려간다.
    if (atBottomRef.current) bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [items, workspaceId])

  const onScroll = (): void => {
    const el = containerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200
    atBottomRef.current = atBottom
    setShowJump(!atBottom)
    setScroll(workspaceId, el.scrollTop)
  }

  const jumpToBottom = (): void => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }

  if (items.length === 0) {
    return (
      <div ref={containerRef} className="flex-1 overflow-y-auto grid place-items-center px-8">
        <div className="flex flex-col items-center text-center max-w-sm">
          <div className="mb-3 grid h-12 w-12 place-items-center rounded-xl bg-[var(--surface)] border border-[var(--border-2)]">
            <MessageSquarePlus size={20} className="text-neutral-400" />
          </div>
          <p className="text-base text-neutral-300">Start an agent session</p>
          <p className="mt-1 text-sm text-neutral-500 leading-relaxed">
            Send your first message — nothing runs until you do. Type{' '}
            <kbd className="rounded bg-[var(--surface-2)] px-1 py-0.5 text-xs text-neutral-300">
              /
            </kbd>{' '}
            for commands or{' '}
            <kbd className="rounded bg-[var(--surface-2)] px-1 py-0.5 text-xs text-neutral-300">
              !
            </kbd>{' '}
            to run a terminal command.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex-1 min-h-0">
      {searchOpen && (
        <div className="absolute top-2 right-4 z-20 flex items-center gap-1 rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-2 py-1 shadow-xl">
          <Search size={13} className="text-neutral-500 shrink-0" />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeSearch()
              else if (e.key === 'Enter') stepMatch(e.shiftKey ? -1 : 1)
            }}
            placeholder="Search conversation"
            aria-label="Search conversation"
            className="w-52 bg-transparent text-sm text-neutral-100 placeholder:text-neutral-600 outline-none"
          />
          <span className="text-xs tabular-nums text-neutral-500 shrink-0 px-1">
            {matches.length ? `${safeIdx + 1}/${matches.length}` : '0/0'}
          </span>
          <button
            onClick={() => stepMatch(-1)}
            disabled={!matches.length}
            aria-label="Previous match"
            className="grid h-6 w-6 place-items-center rounded text-neutral-400 hover:text-neutral-100 disabled:opacity-30"
          >
            <ArrowUp size={13} />
          </button>
          <button
            onClick={() => stepMatch(1)}
            disabled={!matches.length}
            aria-label="Next match"
            className="grid h-6 w-6 place-items-center rounded text-neutral-400 hover:text-neutral-100 disabled:opacity-30"
          >
            <ArrowDown size={13} />
          </button>
          <button
            onClick={closeSearch}
            aria-label="Close search"
            className="grid h-6 w-6 place-items-center rounded text-neutral-400 hover:text-neutral-100"
          >
            <X size={13} />
          </button>
        </div>
      )}
      <div ref={containerRef} onScroll={onScroll} className="h-full overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-5 space-y-3">
          {visibleItems.map((item) => (
            <div
              key={item.id}
              data-item-id={item.id}
              className={
                item.id === activeMatchId
                  ? 'rounded-xl ring-2 ring-[var(--accent-500)]/70 ring-offset-2 ring-offset-[var(--bg)]'
                  : undefined
              }
            >
              <Item
                item={item}
                running={running}
                resolved={resolved}
                workspaceId={workspaceId}
                cardByItemId={cardByItemId}
                latestCardItemId={latestCardItemId}
              />
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
      {showJump && (
        <button
          onClick={jumpToBottom}
          title="Jump to latest"
          className="absolute bottom-3 right-4 h-8 w-8 grid place-items-center rounded-full bg-[var(--surface-2)] border border-[var(--border-3)] text-neutral-300 hover:text-neutral-100 shadow-lg"
        >
          <ArrowDown size={15} />
        </button>
      )}
    </div>
  )
}

function Item({
  item,
  running,
  resolved,
  workspaceId,
  cardByItemId,
  latestCardItemId
}: {
  item: ChatItem
  running: boolean
  resolved: Set<string>
  workspaceId: string
  /** 이 자리에 할 일 체크리스트를 붙일 항목이면 그 시점의 목록 스냅샷. */
  cardByItemId: Map<string, TaskEntry[]>
  /** 지금이 라이브 상태인 마지막 체크리스트의 항목 id(진행 중 스피너 판별용). */
  latestCardItemId?: string
}): React.JSX.Element | null {
  const time = formatTime(item.ts)

  // 할 일 도구 호출 구간은 원래의 도구 행 대신 체크리스트 카드 한 장으로 대체한다.
  const card = cardByItemId.get(item.id)
  if (card) return <TaskChecklist tasks={card} live={running && item.id === latestCardItemId} />

  switch (item.type) {
    case 'user':
      return (
        <div className="flex justify-end" title={time}>
          <div className="max-w-[85%] bg-[var(--surface-4)] text-neutral-100 rounded-2xl rounded-br-md px-3.5 py-2 text-base">
            {item.attachments && item.attachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-1.5">
                {item.attachments.map((a, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/20 text-xs text-neutral-300"
                  >
                    <ImageIcon size={11} className="text-neutral-400" />
                    {a.name}
                  </span>
                ))}
              </div>
            )}
            {item.text && <div className="whitespace-pre-wrap">{item.text}</div>}
          </div>
        </div>
      )
    case 'assistant':
      return (
        <div className="group/msg relative md text-base text-neutral-200" title={time}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={{ a: ExternalLinkRenderer, pre: PreWithCopy }}
          >
            {item.text || (item.streaming ? '…' : '')}
          </ReactMarkdown>
          {item.text && !item.streaming && (
            <div className="absolute -top-1 right-0 opacity-0 group-hover/msg:opacity-100 transition">
              <CopyButton text={item.text} />
            </div>
          )}
        </div>
      )
    case 'thinking':
      return <Thinking text={item.text} />
    case 'tool_use':
      return (
        <ToolUse
          name={item.name}
          input={item.input}
          pending={running && !resolved.has(item.toolId)}
        />
      )
    case 'tool_result':
      return <ToolResult text={item.text} isError={item.isError} />
    case 'result':
      return <ResultFooter item={item} />
    case 'error':
      return (
        <div className="flex items-center gap-2 text-sm text-[var(--danger-400)] bg-[var(--danger-500)]/10 border border-[var(--danger-500)]/20 rounded-lg px-3 py-2">
          <AlertTriangle size={14} className="shrink-0" />
          <span className="whitespace-pre-wrap">{item.text}</span>
        </div>
      )
    case 'system':
      return <div className="text-xs text-neutral-500 text-center py-1">{item.text}</div>
    case 'bash':
      return (
        <BashBlock
          command={item.command}
          output={item.output}
          exitCode={item.exitCode}
          running={item.running}
          onStop={() => void window.api.terminal.killInline(workspaceId, item.id)}
        />
      )
    case 'task':
      return <TaskCard item={item} />
    default:
      return null
  }
}

/**
 * 할 일 목록 한 스냅샷을 체크리스트 카드로 그린다(Claude Code CLI 와 같은 경험).
 *
 * 상태 기호는 CLI 와 같은 체계를 쓴다 — 완료 ✔, 진행 중 ◼(채운 사각형), 대기 ◻(빈 사각형).
 * 완료 항목은 지우지 않고 취소선 + 흐린 색으로 남겨 전체 계획의 흐름이 보이게 하고, 진행 중
 * 항목은 현재진행형 라벨(activeForm)로 강조한다. 마지막(=현재) 카드이고 세션이 돌고 있으면
 * 진행 중 항목에 스피너가 돈다.
 */
function TaskChecklist({
  tasks,
  live
}: {
  tasks: TaskEntry[]
  live: boolean
}): React.JSX.Element | null {
  // 항목이 모두 지워진 구간은 빈 카드를 남기지 않는다.
  if (tasks.length === 0) return null

  const done = tasks.filter((t) => t.status === 'completed').length
  const allDone = done === tasks.length

  return (
    <div className="rounded-lg border border-[var(--border-3)] bg-[var(--surface-2)] px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <ListTodo size={13} className="text-[var(--accent-400)] shrink-0" />
        <span className="font-medium text-neutral-200">Tasks</span>
        <span
          className={
            'ml-auto shrink-0 text-xs tabular-nums ' +
            (allDone ? 'text-[var(--success-400)]' : 'text-neutral-500')
          }
        >
          {done}/{tasks.length}
        </span>
      </div>

      <ul className="mt-1.5 space-y-1">
        {tasks.map((task, i) => {
          const completed = task.status === 'completed'
          const active = task.status === 'in_progress'
          return (
            // 이미 확정된 스냅샷이라 재정렬이 없다. 번호가 아직 없는 항목도 있어 인덱스를 섞어 쓴다.
            <li key={`${task.id}:${i}`} className="flex items-start gap-2">
              <span className="mt-[3px] shrink-0">
                {completed ? (
                  <Check size={12} className="text-[var(--success-400)]" />
                ) : active ? (
                  live ? (
                    <Loader2 size={12} className="text-[var(--accent-400)] animate-spin" />
                  ) : (
                    <Square size={12} fill="currentColor" className="text-[var(--accent-400)]" />
                  )
                ) : (
                  <Square size={12} className="text-neutral-600" />
                )}
              </span>
              <span
                className={
                  'min-w-0 whitespace-pre-wrap ' +
                  (completed
                    ? 'text-neutral-500 line-through decoration-neutral-600'
                    : active
                      ? 'text-neutral-100 font-medium'
                      : 'text-neutral-400')
                }
              >
                {taskLabel(task)}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * 입력창의 `!명령`(Claude Code CLI bash 모드) 1회 실행 결과를 대화 흐름 안에 인라인으로
 * 보여 준다 — 우측 터미널 패널과 분리된, 명령 + 출력이 함께 쌓이는 모노스페이스 블록.
 * 실행 중에는 스피너, 끝나면 성공(✓)/실패(✕, 종료 코드)를 표시한다.
 */
function BashBlock({
  command,
  output,
  exitCode,
  running,
  onStop
}: {
  command: string
  output: string
  exitCode: number | null
  running: boolean
  onStop: () => void
}): React.JSX.Element {
  const failed = !running && exitCode != null && exitCode !== 0
  return (
    <div className="group/bash rounded-lg border border-[var(--border)] bg-[var(--bg-3)] overflow-hidden font-mono text-xs">
      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-[var(--border)] bg-[var(--surface)]">
        <TerminalIcon size={12} className="text-neutral-500 shrink-0" />
        <span className="text-[var(--success-400)] shrink-0">$</span>
        <span className="text-neutral-200 truncate" title={command}>
          {command}
        </span>
        <span className="ml-auto shrink-0">
          {running ? (
            <button
              onClick={onStop}
              title="중단"
              className="grid h-4 w-4 place-items-center text-neutral-500 hover:text-[var(--danger-400)]"
            >
              {/* 평상시 스피너, 마우스를 올리면 중단(정지) 버튼으로 바뀐다. */}
              <Loader2 size={12} className="animate-spin group-hover/bash:hidden" />
              <Square size={11} fill="currentColor" className="hidden group-hover/bash:block" />
            </button>
          ) : failed ? (
            <span className="flex items-center gap-1 text-[var(--danger-400)]">
              <XCircle size={12} />
              {exitCode}
            </span>
          ) : (
            <Check size={12} className="text-[var(--success-400)]" />
          )}
        </span>
      </div>
      {output && (
        <pre className="px-2.5 py-2 overflow-x-auto whitespace-pre-wrap text-neutral-400 max-h-96 overflow-y-auto">
          {output}
        </pre>
      )}
    </div>
  )
}

/**
 * 동적 워크플로우(대규모 서브에이전트 조율) 1회 실행의 진행 카드.
 * task_started → progress → notification 흐름으로 라이브 갱신되며, 진행 중에는 현재 단계와
 * 누적 토큰/도구 호출을, 종료 시에는 상태와 최종 요약을 보여 준다.
 */
function TaskCard({ item }: { item: Extract<ChatItem, { type: 'task' }> }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const running = item.status === 'running' || item.status === 'paused'
  const failed = item.status === 'failed' || item.status === 'stopped'

  const stats: string[] = []
  if (typeof item.totalTokens === 'number')
    stats.push(`${formatTokenCount(item.totalTokens)} tokens`)
  if (typeof item.toolUses === 'number')
    stats.push(`${item.toolUses} tool ${item.toolUses === 1 ? 'use' : 'uses'}`)
  if (typeof item.durationMs === 'number') stats.push(`${(item.durationMs / 1000).toFixed(1)}s`)

  return (
    <div className="rounded-lg border border-[var(--border-3)] bg-[var(--surface-2)] px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        {running ? (
          <Loader2 size={13} className="text-[var(--accent-400)] shrink-0 animate-spin" />
        ) : failed ? (
          <XCircle size={13} className="text-[var(--danger-400)] shrink-0" />
        ) : (
          <Check size={13} className="text-[var(--success-400)] shrink-0" />
        )}
        <Workflow size={13} className="text-[var(--accent-400)]/80 shrink-0" />
        <span className="font-medium text-neutral-200">Workflow</span>
        <span className="text-neutral-400 truncate">{item.name}</span>
        <span
          className={
            'ml-auto shrink-0 text-xs uppercase tracking-wide ' +
            (running
              ? 'text-[var(--accent-400)]'
              : failed
                ? 'text-[var(--danger-400)]'
                : 'text-[var(--success-400)]')
          }
        >
          {item.status}
        </span>
      </div>

      <div className="mt-1 pl-[21px] text-neutral-400 truncate">{item.description}</div>

      {stats.length > 0 && (
        <div className="mt-1 pl-[21px] text-xs text-neutral-500">{stats.join(' · ')}</div>
      )}

      {item.summary && (
        <div className="mt-1.5 pl-[21px]">
          <button
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-300"
          >
            <ChevronRight size={11} className={open ? 'rotate-90 transition' : 'transition'} />
            {open ? 'Hide summary' : 'Show summary'}
          </button>
          {open && (
            <div className="mt-1 text-xs text-neutral-400 whitespace-pre-wrap border-l border-[var(--border)] pl-2">
              {item.summary}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** 토큰 수를 1.2k / 45k / 1.0M 처럼 짧게 표기한다. */
function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

function Thinking({ text }: { text: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="text-sm">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-neutral-500 hover:text-neutral-300"
      >
        <Brain size={12} />
        <span>Thinking</span>
        <ChevronRight size={12} className={open ? 'rotate-90 transition' : 'transition'} />
      </button>
      {open && (
        <div className="mt-1 pl-4 border-l border-[var(--border)] text-neutral-500 whitespace-pre-wrap italic">
          {text}
        </div>
      )}
    </div>
  )
}

function ToolUse({
  name,
  input,
  pending
}: {
  name: string
  input: unknown
  pending: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const summary = summarizeToolInput(name, input)
  return (
    <div className="text-sm">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-neutral-400 hover:text-neutral-200 w-full text-left"
      >
        {pending ? (
          <Loader2 size={12} className="text-[var(--warning-500)]/80 shrink-0 animate-spin" />
        ) : (
          <Wrench size={12} className="text-[var(--warning-500)]/80 shrink-0" />
        )}
        <span className="font-medium text-neutral-300">{name}</span>
        {summary && <span className="text-neutral-500 truncate">{summary}</span>}
        <ChevronRight
          size={12}
          className={(open ? 'rotate-90 ' : '') + 'ml-auto shrink-0 transition'}
        />
      </button>
      {open && (
        <pre className="mt-1 ml-4 text-xs bg-[var(--surface)] border border-[var(--border)] rounded-md p-2 overflow-x-auto text-neutral-400">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
    </div>
  )
}

function ToolResult({ text, isError }: { text: string; isError: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const lines = text.split('\n')
  const preview = lines.slice(0, 3).join('\n')
  const truncated = lines.length > 3 || text.length > 240

  return (
    <div className="ml-4 text-xs">
      <pre
        className={
          'whitespace-pre-wrap rounded-md p-2 overflow-x-auto border ' +
          (isError
            ? 'bg-[var(--danger-500)]/5 border-[var(--danger-500)]/20 text-[var(--danger-300)]/90'
            : 'bg-[var(--bg-3)] border-[var(--border)] text-neutral-500')
        }
      >
        {open || !truncated ? text : preview + (truncated ? '\n…' : '')}
      </pre>
      {truncated && (
        <button
          onClick={() => setOpen((v) => !v)}
          className="mt-0.5 text-xs text-neutral-600 hover:text-neutral-400"
        >
          {open ? 'Collapse' : `Show more (${lines.length} lines)`}
        </button>
      )}
    </div>
  )
}

function ResultFooter({
  item
}: {
  item: Extract<ChatItem, { type: 'result' }>
}): React.JSX.Element {
  const text =
    item.subtype === 'success'
      ? `${item.numTurns} turns · ${(item.durationMs / 1000).toFixed(1)}s`
      : `${item.subtype} · ${item.numTurns} turns`
  return (
    <div
      className={
        'text-xs text-center py-1 ' +
        (item.isError ? 'text-[var(--danger-400)]/80' : 'text-neutral-600')
      }
    >
      {text}
    </div>
  )
}

/** 클립보드 복사 버튼(체크 표시로 피드백). */
function CopyButton({ text, className }: { text: string; className?: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }
  return (
    <button
      onClick={copy}
      title="Copy"
      className={
        'h-6 w-6 grid place-items-center rounded-md bg-[var(--surface-2)]/80 text-neutral-400 hover:text-neutral-100 ' +
        (className ?? '')
      }
    >
      {copied ? <Check size={12} className="text-[var(--success-400)]" /> : <Copy size={12} />}
    </button>
  )
}

/** 코드 블록에 복사 버튼을 얹는다. */
function PreWithCopy({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="group/code relative">
      <div className="absolute top-1.5 right-1.5 opacity-0 group-hover/code:opacity-100 transition">
        <CopyButton text={extractText(children)} />
      </div>
      <pre>{children}</pre>
    </div>
  )
}

/** React 노드 트리에서 텍스트만 모은다(코드 복사용). */
function extractText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (typeof node === 'object' && 'props' in node) {
    return extractText((node as { props: { children?: React.ReactNode } }).props.children)
  }
  return ''
}

/** 채팅 메시지 안의 링크는 항상 사용자의 기본 브라우저로 연다(앱 내 이동 방지). */
function ExternalLinkRenderer({
  href,
  children
}: {
  href?: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault()
        if (href) void window.api.openExternal(href)
      }}
    >
      {children}
    </a>
  )
}

function summarizeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>
  if (name === 'Bash' && typeof obj.command === 'string') return obj.command
  if (typeof obj.file_path === 'string') return obj.file_path
  if (typeof obj.path === 'string') return obj.path
  if (typeof obj.pattern === 'string') return obj.pattern
  if (typeof obj.url === 'string') return obj.url
  if (typeof obj.description === 'string') return obj.description
  return ''
}

const EMPTY: ChatItem[] = []

/** 대화 검색 대상 텍스트를 항목 종류별로 뽑아낸다. */
function itemText(it: ChatItem): string {
  switch (it.type) {
    case 'user':
    case 'assistant':
    case 'thinking':
    case 'system':
    case 'error':
    case 'tool_result':
      return it.text
    case 'bash':
      return `${it.command}\n${it.output}`
    case 'tool_use':
      return it.name
    case 'task':
      return `${it.name} ${it.description} ${it.summary ?? ''}`
    default:
      return ''
  }
}

/** 속성 선택자 값에 들어갈 수 있는 따옴표·역슬래시를 이스케이프한다. */
function cssAttr(value: string): string {
  return value.replace(/["\\]/g, '\\$&')
}
