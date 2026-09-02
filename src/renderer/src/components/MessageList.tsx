import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronRight,
  Brain,
  Check,
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
  ListTodo,
  Layers,
  MessagesSquare,
  GitMergeConflict
} from 'lucide-react'
import { useStore } from '../store'
import { DiffLine } from './DiffView'
import { AgentMessage, ErrorRow, UserMessage } from './ChatPrimitives'
import { ToolCard } from './tools/ToolCard'
import { ToolGroupCard } from './tools/ToolGroupCard'
import { formatTime } from '../lib/format'
import { buildTaskCards, taskLabel, type TaskEntry } from '../lib/tasks'
import { buildToolGroups, type ToolGroup } from '@shared/toolGroups'
import { useTranscriptJump } from '../lib/transcriptJump'
import { compactHistoryWindow } from '../lib/compactHistory'
import { useAvailableBackends } from '../lib/backends'
import { AgentBackendMark } from './BrandIcons'
import { AGENT_BACKEND_LABELS, canSwitchAgentBackend } from '@shared/types'
import type { ChatItem } from '@shared/types'
import { BASH_FOLD, foldBashOutput } from '@shared/bashDisplay'
import { SELECTABLE, unlessSelecting } from '../lib/selection'
import SelectionCopyBubble from './SelectionCopyBubble'
import { useChatFontScale } from '../lib/chatFontScale'
import { restoredScrollTop, TRANSCRIPT_TOP_THRESHOLD_PX } from '../lib/transcriptPagination'
import { DENSITY_SHORTCUT } from '@shared/toolDisplay'
import {
  DEFAULT_TRANSCRIPT_DENSITY,
  expandsToolOutput,
  showsEntry,
  showsInlineDiff,
  transcriptEntryKind,
  type TranscriptDensity
} from '../lib/transcriptDensity'
import { usePaneFocused } from '../lib/paneFocus'

/**
 * Wooi 가 rebase 충돌 해결을 맡기며 넣은 사용자 턴을 한 줄로 접어 보여 준다.
 *
 * 이 전문은 충돌 파일 목록과 금지 사항까지 담아 길다. 대화에 남기는 것 자체는 일부러 그렇게
 * 한 것이지만(토큰을 쓴 이유가 기록에 있어야 한다), 펼쳐 둔 채로는 앞뒤 대화를 밀어낸다.
 * 그래서 감추지 않고 접는다 — 한 줄에 무엇을 왜 시켰는지 두고, 전문은 눌러서 펼친다.
 */
function ConflictResolveMessage({
  item,
  title
}: {
  item: Extract<ChatItem, { type: 'user' }>
  title: string
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const origin = item.origin
  if (!origin || origin.kind !== 'conflictResolve')
    return <UserMessage text={item.text} title={title} />

  return (
    <div className="flex justify-end my-2" title={title}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="max-w-[min(42rem,88%)] rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-left text-xs text-neutral-400 hover:border-[var(--border-strong)] hover:text-neutral-300"
      >
        <span className="flex items-center gap-1.5">
          <GitMergeConflict size={12} className="shrink-0 text-neutral-500" />
          <span>Resolve rebase conflict on</span>
          <span className="truncate font-mono text-neutral-300">{origin.branch}</span>
          <span className="shrink-0 text-neutral-500">
            · {origin.fileCount} file{origin.fileCount === 1 ? '' : 's'}
          </span>
          {/* 자동으로 시작된 턴이라는 사실은 접힌 상태에서도 읽혀야 한다 — 사용자가 누르지 않은
              턴이 왜 돌았는지 묻게 만드는 것이 바로 이 경우다. */}
          {origin.auto && (
            <span className="shrink-0 rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-2xs text-neutral-500">
              auto
            </span>
          )}
          <ChevronRight
            size={12}
            className={`ml-auto shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
        </span>
        {expanded && (
          <span className="mt-2 block whitespace-pre-wrap break-words border-t border-[var(--border)] pt-2 text-sm leading-relaxed text-neutral-300">
            {item.text}
          </span>
        )}
      </button>
    </div>
  )
}

/**
 * CI auto-fix 로 Wooi 가 넣은 턴. ConflictResolveMessage 와 같은 이유로 접어서 보여 준다 —
 * 실패 로그까지 실려 프롬프트가 길고, 펼쳐 둔 채로는 대화를 밀어낸다.
 */
function CiFixMessage({
  item,
  title
}: {
  item: Extract<ChatItem, { type: 'user' }>
  title: string
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const origin = item.origin
  if (!origin || origin.kind !== 'ciFix') return <UserMessage text={item.text} title={title} />

  return (
    <div className="flex justify-end my-2" title={title}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="max-w-[min(42rem,88%)] rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-left text-xs text-neutral-400 hover:border-[var(--border-strong)] hover:text-neutral-300"
      >
        <span className="flex items-center gap-1.5">
          <XCircle size={12} className="shrink-0 text-neutral-500" />
          <span className="shrink-0">Fix failing checks</span>
          <span className="truncate font-mono text-neutral-300">
            {origin.failedChecks.join(', ')}
          </span>
          {/* 자동으로 시작된 턴이라는 사실과, 몇 번째이고 어디서 멈추는지는 접힌 상태에서도
              읽혀야 한다 — 켜 둔 채로 잊은 사람이 대화만 보고 알아챌 유일한 자리다. */}
          <span className="shrink-0 rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-2xs text-neutral-500">
            auto {origin.attempt}/{origin.max}
          </span>
          <ChevronRight
            size={12}
            className={`ml-auto shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
        </span>
        {expanded && (
          <span className="mt-2 block whitespace-pre-wrap break-words border-t border-[var(--border)] pt-2 text-sm leading-relaxed text-neutral-300">
            {item.text}
          </span>
        )}
      </button>
    </div>
  )
}

function PeerMessage({
  item,
  title
}: {
  item: Extract<ChatItem, { type: 'user' }>
  title: string
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const origin = item.origin
  if (!origin || origin.kind !== 'peer') return <UserMessage text={item.text} title={title} />
  const messages = origin.messages
  const senders = new Set(
    messages.map((message) => `${message.fromRepoName}\0${message.fromBranch}`)
  )
  const only = messages[0]

  return (
    <div className="flex justify-end my-2" title={title}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="max-w-[min(42rem,88%)] rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-left text-xs text-neutral-400 hover:border-[var(--border-strong)] hover:text-neutral-300"
      >
        <span className="flex items-center gap-1.5">
          <MessagesSquare size={12} className="shrink-0 text-neutral-500" />
          {messages.length === 1 ? (
            <>
              <span>Message from</span>
              <span className="truncate font-mono text-neutral-300">{only.fromBranch}</span>
            </>
          ) : (
            <span>
              {messages.length} messages from {senders.size} workspace
              {senders.size === 1 ? '' : 's'}
            </span>
          )}
          {messages.length === 1 && only.crossRepo && (
            <span className="shrink-0 rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-2xs text-neutral-500">
              {only.fromRepoName}
            </span>
          )}
          <ChevronRight
            size={12}
            className={`ml-auto shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
        </span>
        {expanded && (
          <span className="mt-2 block border-t border-[var(--border)] pt-2 text-sm leading-relaxed text-neutral-300">
            {messages.map((message, index) => (
              <span
                key={`${message.fromRepoName}:${message.fromBranch}:${index}`}
                className="block"
              >
                {messages.length > 1 && (
                  <span className="mb-1 block text-xs text-neutral-500">
                    <span className="font-mono text-neutral-400">{message.fromBranch}</span>
                    {message.crossRepo ? ` · ${message.fromRepoName}` : ''}
                  </span>
                )}
                <span className="block whitespace-pre-wrap break-words">{message.message}</span>
                {index < messages.length - 1 && (
                  <span className="my-2 block border-t border-[var(--border)]" />
                )}
              </span>
            ))}
          </span>
        )}
      </button>
    </div>
  )
}

export default function MessageList({
  workspaceId,
  running
}: {
  workspaceId: string
  running: boolean
}): React.JSX.Element {
  const items = useStore((s) => s.transcripts[workspaceId]) ?? EMPTY
  // 빈 화면에서만 쓰는 값들 — 이 워크스페이스를 돌릴 에이전트를 아직 고를 수 있는지 판단한다.
  const workspace = useStore((s) => s.app?.workspaces.find((w) => w.id === workspaceId))
  const availableAgents = useAvailableBackends()
  // 스크롤 위치는 저장만 하고 구독하지 않는다(스크롤마다 재렌더 방지). 복원은 마운트 시 1회.
  const setScroll = useStore((s) => s.setScrollPosition)
  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  // 트랜스크립트는 비동기로 로드되므로, 내용이 처음 채워질 때 스크롤 위치를 1회 복원한다.
  const restoredRef = useRef(false)
  const [showJump, setShowJump] = useState(false)
  const [expandedBoundaryId, setExpandedBoundaryId] = useState<string>()
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const jumpTarget = useStore((s) => s.jumpTarget)
  // 대화 밀도(⌃O / 상태줄 칩). 무엇을 그릴지와 도구 출력을 펴 둘지를 모두 여기서 갈라 준다.
  const density = useStore((s) => s.transcriptDensity[workspaceId] ?? DEFAULT_TRANSCRIPT_DENSITY)
  const toolLogStyle = useStore((s) => s.app?.settings.toolLogStyle ?? 'wooi')
  const overlayOpen = useStore((s) => s.overlayOpen)
  // 나란히 두 칸을 띄우면 이 화면이 다는 전역 리스너가 두 번 발동한다 — 포커스된 칸만 받는다.
  const paneFocused = usePaneFocused()
  const hasMoreHistory = useStore((s) => !!s.transcriptPaging[workspaceId]?.hasMore)
  const loadingEarlier = useStore((s) => !!s.transcriptPaging[workspaceId]?.loading)
  const loadEarlier = useStore((s) => s.loadEarlierTranscript)
  // 위쪽에 항목이 끼어들면 콘텐츠가 자란다. 붙기 직전의 스크롤 상태를 잡아 두고, 커밋된 뒤
  // 자란 만큼 밀어 사용자가 보던 지점을 그대로 둔다 — 브라우저는 이걸 대신 해 주지 않는다.
  const prependAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null)
  // ⌘+ / ⌘- / ⌘0 — 대화 표면에만 걸리는 배율. 앱 전체 줌을 키우면 사이드바·터미널까지 커져서
  // 정작 읽으려던 대화가 좁아진 폭 안에 갇힌다. 오버레이가 덮고 있을 때는 키를 듣지 않는다.
  const fontScale = useChatFontScale(!overlayOpen && paneFocused)

  const compactWindow = useMemo(() => compactHistoryWindow(items), [items])
  const historyExpanded = expandedBoundaryId === compactWindow.boundary?.id
  const jumpTargetIndex =
    jumpTarget?.workspaceId === workspaceId
      ? items.findIndex((item) => item.id === jumpTarget.itemId)
      : -1
  const jumpInHiddenHistory = jumpTargetIndex >= 0 && jumpTargetIndex <= compactWindow.boundaryIndex
  const displayExpanded = historyExpanded || searchOpen || jumpInHiddenHistory
  const collapsed = compactWindow.boundaryIndex >= 0 && !displayExpanded
  // slice 가 핵심 최적화다. 접힌 과거는 DOM뿐 아니라 task 카드 계산·검색 대상에서도 빠진다.
  const renderedItems = collapsed ? items.slice(compactWindow.boundaryIndex + 1) : items

  // 점프 훅은 목적지를 찾으면 jumpTarget 을 지운다. 그 뒤에도 과거가 열린 채 남도록 경계 id를
  // 확정한다. microtask 로 넘겨 effect 본문에서 동기 setState 하는 추가 렌더도 피한다.
  useEffect(() => {
    if (!jumpInHiddenHistory || !compactWindow.boundary) return
    const boundaryId = compactWindow.boundary.id
    queueMicrotask(() => setExpandedBoundaryId(boundaryId))
  }, [compactWindow.boundary, jumpInHiddenHistory])

  // 할 일 도구 호출들을 체크리스트 카드로 묶는다. 카드로 대체된 도구 행·결과는 목록 단계에서
  // 걸러 내, 검색과 스크롤도 실제로 보이는 항목만 대상으로 삼게 한다.
  const {
    visibleItems,
    resolved,
    results,
    cardByItemId,
    latestCardItemId,
    groupByItemId,
    hiddenByDensity
  } = useMemo(() => {
    const { cardByItemId: cards, hiddenItemIds: taskHiddenIds } = buildTaskCards(renderedItems)
    // 체크리스트가 가져간 자리는 도구 그룹의 연속 구간에서도 경계다. 대표 카드 항목까지 제외해야
    // 두 시각화가 같은 원본을 서로 차지하지 않는다.
    const taskItemIds = new Set([...taskHiddenIds, ...cards.keys()])
    const { groupByItemId: groups, hiddenItemIds: groupHiddenIds } = buildToolGroups(
      renderedItems,
      taskItemIds
    )
    const hiddenItemIds = new Set([...taskHiddenIds, ...groupHiddenIds])
    const resolvedIds = new Set<string>()
    for (const it of renderedItems) if (it.type === 'tool_result') resolvedIds.add(it.toolId)
    const resultByToolId = new Map<string, Extract<ChatItem, { type: 'tool_result' }>>()
    const uses = new Set(
      renderedItems.filter((it) => it.type === 'tool_use').map((it) => it.toolId)
    )
    for (const it of renderedItems) if (it.type === 'tool_result') resultByToolId.set(it.toolId, it)
    // 체크리스트·묶음이 흡수한 자리와, 도구 카드 안으로 들어간 결과를 뺀 "실제로 놓이는" 항목들.
    const placed = renderedItems.filter(
      (it) => !hiddenItemIds.has(it.id) && !(it.type === 'tool_result' && uses.has(it.toolId))
    )
    const visible = placed.filter((it) =>
      showsEntry(
        density,
        transcriptEntryKind(it, {
          todoCard: cards.has(it.id),
          toolGroupHead: groups.has(it.id)
        })
      )
    )
    return {
      cardByItemId: cards,
      groupByItemId: groups,
      resolved: resolvedIds,
      results: resultByToolId,
      // 진행 중 스피너는 마지막 카드에만 붙인다 — 앞선 카드들은 이미 지나간 스냅샷이라,
      // 전부 돌면 어떤 것이 지금 상태인지 알 수 없게 된다.
      latestCardItemId: cards.size ? Array.from(cards.keys())[cards.size - 1] : undefined,
      visibleItems: visible,
      // Summary 가 몇 걸음을 접었는지. 아무것도 안 남은 화면을 고장으로 오해하지 않도록
      // 목록 끝에 한 줄로 알린다.
      hiddenByDensity: placed.length - visible.length
    }
  }, [renderedItems, density])

  // ── 대화 내 검색(⌘F) ─────────────────────────────────────────────────────
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return [] as string[]
    return visibleItems
      .filter((it) => {
        // 체크리스트로 대체된 자리는 도구 이름 대신 화면에 실제로 뜬 항목 제목으로 검색한다.
        const card = cardByItemId.get(it.id)
        const group = groupByItemId.get(it.id)
        const pairedResult = it.type === 'tool_use' ? results.get(it.toolId) : undefined
        const text = card
          ? card.map(taskLabel).join('\n')
          : group
            ? group.uses
                .map((use) => {
                  const result = results.get(use.toolId)
                  return `${itemText(use)}\n${JSON.stringify(use.input)}${result ? `\n${result.text}` : ''}`
                })
                .join('\n')
            : `${itemText(it)}${pairedResult ? `\n${pairedResult.text}` : ''}`
        return text.toLowerCase().includes(q)
      })
      .map((it) => it.id)
  }, [visibleItems, cardByItemId, groupByItemId, query, results])

  // 검색어가 바뀌면 첫 매치부터 다시 훑는다.
  useEffect(() => setActiveIdx(0), [query])

  // ⌘F / Ctrl+F 로 검색바를 연다(입력창 등 다른 곳에 포커스가 있어도 대화 검색을 우선한다).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!paneFocused) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        // 모달·파일 뷰어가 떠 있으면 ⌘F 는 그쪽 것이다(파일 내 검색). 뒤에서 대화 검색바가
        // 같이 열리면 닫을 때까지 사용자는 그 존재를 모른다.
        if (useStore.getState().overlayOpen) return
        e.preventDefault()
        setSearchOpen(true)
        setTimeout(() => searchInputRef.current?.select(), 0)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [paneFocused])

  // 검색어 변경으로 matches 가 줄어들면 setActiveIdx(0) 이펙트가 커밋되기 전 프레임에서 activeIdx 가
  // 범위를 벗어날 수 있다 — 카운터/하이라이트/스크롤 모두 클램프한 인덱스를 쓴다.
  const safeIdx = matches.length ? Math.min(activeIdx, matches.length - 1) : 0

  // 활성 매치를 화면 중앙으로 스크롤한다.
  useEffect(() => {
    if (!searchOpen || matches.length === 0) return
    const el = containerRef.current?.querySelector(`[data-item-id="${cssAttr(matches[safeIdx])}"]`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [safeIdx, matches, searchOpen])

  // 워크스페이스를 가로지르는 검색(⇧⌘K)에서 넘어온 이동. 도착한 항목은 ⌘F 매치와 같은
  // 강조를 잠시 두른다 — 하이라이트 경로가 이미 있으니 그 위에 얹는다.
  const jumpedId = useTranscriptJump(workspaceId, containerRef)

  const activeMatchId = searchOpen ? matches[safeIdx] : jumpedId
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

  /** 위쪽으로 한 페이지 더 읽는다. 스크롤로도, 버튼으로도 같은 자리를 지나간다. */
  const pageInEarlier = (): void => {
    const el = containerRef.current
    if (!el || !hasMoreHistory || loadingEarlier) return
    prependAnchorRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop }
    void loadEarlier(workspaceId)
    // 스토어가 첫 await 전에 동기로 loading 을 세운다. 서지 않았다면 요청이 거절된 것이므로
    // 앵커를 거둔다 — 남겨 두면 다음 스트리밍 갱신 때 엉뚱한 자리로 스크롤이 튄다.
    if (!useStore.getState().transcriptPaging[workspaceId]?.loading) {
      prependAnchorRef.current = null
    }
  }

  const onScroll = (): void => {
    const el = containerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200
    atBottomRef.current = atBottom
    setShowJump(!atBottom)
    setScroll(workspaceId, el.scrollTop)
    if (el.scrollTop < TRANSCRIPT_TOP_THRESHOLD_PX) pageInEarlier()
  }

  // 앞에 붙은 페이지의 높이만큼 스크롤을 밀어 준다. 페인트 전에 끝나야 화면이 튀지 않으므로
  // layout effect 다. 아래의 따라 내려가기 이펙트는 사용자가 위에 있는 동안 아무 일도 하지
  // 않으므로(atBottomRef) 여기와 부딪히지 않는다.
  useLayoutEffect(() => {
    const el = containerRef.current
    const anchor = prependAnchorRef.current
    if (!el || !anchor) return
    prependAnchorRef.current = null
    el.scrollTop = restoredScrollTop(anchor, el.scrollHeight)
  }, [items])

  const jumpToBottom = (): void => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }

  // ⇧⌘↓ — 현재 대화의 최신 메시지로 이동. ⌘↓는 다음 워크스페이스 이동에
  // 이미 쓰이므로 Shift를 더한다. 버튼과 같은 함수를 써서 스크롤 동작을 항상 맞춘다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!paneFocused) return
      if (
        e.metaKey &&
        e.shiftKey &&
        !e.ctrlKey &&
        !e.altKey &&
        e.key === 'ArrowDown' &&
        !useStore.getState().overlayOpen
      ) {
        e.preventDefault()
        jumpToBottom()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [paneFocused])

  if (items.length === 0) {
    // 에이전트는 나중에도 바꿀 수 있지만([[canSwitchAgentBackend]]) 공짜로 바꿀 수 있는 건 지금
    // 뿐이다 — 넘길 대화가 없어 인수인계 턴이 돌지 않는다. 그 사실을 알려 주기 좋은 화면이 여기다.
    // 고를 대상이 둘 이상일 때만 알린다.
    const switchable = availableAgents.length > 1 && !!workspace && canSwitchAgentBackend(workspace)
    const agentLabel = workspace
      ? (availableAgents.find((b) => b.id === workspace.agentBackend)?.label ??
        AGENT_BACKEND_LABELS[workspace.agentBackend])
      : ''

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
          {switchable && workspace && (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-neutral-600">
              <AgentBackendMark backend={workspace.agentBackend} size={12} />
              <span>
                Running on <span className="text-neutral-400">{agentLabel}</span> — type{' '}
                <kbd className="rounded bg-[var(--surface-2)] px-1 py-0.5 text-xs text-neutral-300">
                  /agent
                </kbd>{' '}
                to switch. Free right now — later, switching replays the conversation to the new
                agent.
              </span>
            </p>
          )}
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
        <SelectionCopyBubble
          className="max-w-3xl mx-auto px-5 py-5 space-y-3"
          style={fontScale === 1 ? undefined : { zoom: fontScale }}
        >
          {hasMoreHistory && (
            <button
              type="button"
              onClick={pageInEarlier}
              disabled={loadingEarlier}
              className="mx-auto flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs text-neutral-500 hover:bg-[var(--surface)] hover:text-neutral-300 disabled:opacity-50"
            >
              {loadingEarlier ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <ArrowUp size={12} />
              )}
              {loadingEarlier ? 'Loading earlier messages…' : 'Load earlier messages'}
            </button>
          )}
          {compactWindow.boundary && (
            <button
              type="button"
              aria-expanded={displayExpanded}
              onClick={() =>
                setExpandedBoundaryId(historyExpanded ? undefined : compactWindow.boundary?.id)
              }
              className="mx-auto flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs text-neutral-500 hover:bg-[var(--surface)] hover:text-neutral-300"
            >
              <ChevronRight
                size={12}
                className={`transition-transform ${displayExpanded ? 'rotate-90' : ''}`}
              />
              {displayExpanded
                ? 'Hide conversation before compaction'
                : `Show ${compactWindow.boundaryIndex} earlier conversation items`}
            </button>
          )}
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
              <MemoizedItem
                item={item}
                running={running}
                resolved={resolved}
                workspaceId={workspaceId}
                cardByItemId={cardByItemId}
                groupByItemId={groupByItemId}
                latestCardItemId={latestCardItemId}
                result={item.type === 'tool_use' ? results.get(item.toolId) : undefined}
                results={results}
                density={density}
                toolLogStyle={toolLogStyle}
              />
            </div>
          ))}
          {density === 'summary' && hiddenByDensity > 0 && (
            <div className="text-center text-xs text-neutral-600">
              Summary hides {hiddenByDensity} step{hiddenByDensity === 1 ? '' : 's'} —{' '}
              {DENSITY_SHORTCUT} for Normal
            </div>
          )}
          <div ref={bottomRef} />
        </SelectionCopyBubble>
      </div>
      {showJump && (
        <button
          onClick={jumpToBottom}
          title="Jump to latest (⇧⌘↓)"
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
  groupByItemId,
  latestCardItemId,
  result,
  results,
  density,
  toolLogStyle
}: {
  item: ChatItem
  running: boolean
  resolved: Set<string>
  workspaceId: string
  /** 이 자리에 할 일 체크리스트를 붙일 항목이면 그 시점의 목록 스냅샷. */
  cardByItemId: Map<string, TaskEntry[]>
  /** 이 자리에 연속 조회 도구의 접힌 행을 붙인다. */
  groupByItemId: Map<string, ToolGroup>
  /** 지금이 라이브 상태인 마지막 체크리스트의 항목 id(진행 중 스피너 판별용). */
  latestCardItemId?: string
  result?: Extract<ChatItem, { type: 'tool_result' }>
  results: ReadonlyMap<string, Extract<ChatItem, { type: 'tool_result' }>>
  density: TranscriptDensity
  toolLogStyle: 'wooi' | 'terminal'
}): React.JSX.Element | null {
  const time = formatTime(item.ts)
  // 밀도는 여기서 딱 두 가지로 번역된다 — 도구 출력을 펴 둘지, 인라인 diff 를 붙일지.
  // 무엇을 아예 그리지 않을지는 이미 목록 단계에서 걸러져 여기까지 오지 않는다.
  const toolVerbose = expandsToolOutput(density)

  // 할 일 도구 호출 구간은 원래의 도구 행 대신 체크리스트 카드 한 장으로 대체한다.
  const card = cardByItemId.get(item.id)
  if (card) return <TaskChecklist tasks={card} live={running && item.id === latestCardItemId} />

  const group = groupByItemId.get(item.id)
  if (group) {
    return (
      <ToolGroupCard group={group} results={results} style={toolLogStyle} verbose={toolVerbose} />
    )
  }

  switch (item.type) {
    case 'user':
      if (item.origin?.kind === 'peer') return <PeerMessage item={item} title={time} />
      if (item.origin?.kind === 'conflictResolve')
        return <ConflictResolveMessage item={item} title={time} />
      if (item.origin?.kind === 'ciFix') return <CiFixMessage item={item} title={time} />
      return (
        <UserMessage text={item.text} title={time}>
          {item.attachments && item.attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-1.5">
              {item.attachments.map((a, i) => (
                <span
                  key={i}
                  // 말풍선(--surface-4) 안에 얹히는 칩 — 다크에선 밝게, 라이트에선 어둡게
                  // 갈리는 --border-2 를 써서 두 테마 모두에서 면이 구분되게 한다.
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--border-2)] text-xs text-neutral-300"
                >
                  <ImageIcon size={11} className="text-neutral-400" />
                  {a.name}
                </span>
              ))}
            </div>
          )}
        </UserMessage>
      )
    case 'assistant':
      return (
        <AgentMessage
          text={item.text || (item.streaming ? '…' : '')}
          title={time}
          copyable={!!item.text && !item.streaming}
        />
      )
    case 'thinking':
      // 이미 기록된 대화에는 본문 없는 사고 과정 항목이 잔뜩 남아 있다(요약을 안 받던 시절의
      // 것들이다). 펼쳐도 아무것도 없는 카드라 자리만 차지하므로 그리지 않는다.
      return item.text.trim() ? <Thinking text={item.text} /> : null
    case 'tool_use':
      return (
        <ToolCard
          use={item}
          result={result}
          pending={running && !resolved.has(item.toolId)}
          style={toolLogStyle}
          verbose={toolVerbose}
        >
          {item.diff && showsInlineDiff(density) && (
            <pre className="ml-4 mt-1 max-h-72 overflow-auto rounded-md bg-[var(--code-bg)] py-1 text-xs font-mono leading-[1.45]">
              {item.diff.split('\n').map((line, i) => (
                <DiffLine key={i} line={line} />
              ))}
            </pre>
          )}
        </ToolCard>
      )
    case 'tool_result':
      return <ToolResult text={item.text} isError={item.isError} />
    case 'result':
      return <ResultFooter item={item} />
    case 'error':
      return <ErrorRow text={item.text} />
    case 'system':
      return <div className="text-xs text-neutral-500 text-center py-1">{item.text}</div>
    case 'compaction': {
      const tokens =
        typeof item.preTokens === 'number' && typeof item.postTokens === 'number'
          ? ` (${formatTokenCount(item.preTokens)} → ${formatTokenCount(item.postTokens)} tokens)`
          : ''
      return (
        <div className="text-xs text-neutral-500 text-center py-1">
          Compacted conversation{tokens}.
        </div>
      )
    }
    case 'bash':
      return (
        <BashBlock
          command={item.command}
          cwd={item.cwd}
          agent={item.agent}
          output={item.output}
          exitCode={item.exitCode}
          running={item.running}
          verbose={toolVerbose}
          // 사용자의 `!명령` 은 그 인라인 프로세스만 죽이면 되지만, 에이전트가 실행한 명령은
          // 턴의 일부다 — 프로세스만 죽이면 에이전트는 계속 도므로 턴 자체를 중단한다.
          onStop={() =>
            item.agent
              ? void window.api.chat.interrupt(workspaceId)
              : void window.api.terminal.killInline(workspaceId, item.id)
          }
        />
      )
    case 'task':
      return <TaskCard item={item} />
    case 'handoff':
      return <HandoffCard item={item} />
    case 'unknown':
      return <UnknownCard item={item} />
    default:
      return null
  }
}

/**
 * 스트리밍 중에는 목록 부모가 계속 계산돼도 이미 끝난 일반 메시지는 다시 렌더하지 않는다.
 * 도구 행은 주변 결과·그룹·실행 상태에 의존하므로 기본 비교에 맡겨 정확성을 우선한다.
 */
const MemoizedItem = memo(Item, (prev, next) => {
  if (
    prev.item !== next.item ||
    prev.workspaceId !== next.workspaceId ||
    prev.density !== next.density ||
    prev.toolLogStyle !== next.toolLogStyle
  ) {
    return false
  }
  return prev.item.type !== 'tool_use'
})

function UnknownCard({
  item
}: {
  item: Extract<ChatItem, { type: 'unknown' }>
}): React.JSX.Element {
  const backend = item.backend === 'claude' ? 'Claude Code' : 'Codex'
  return (
    <div className="rounded-lg border border-[var(--border-2)] bg-[var(--surface)] px-3 py-2 text-xs text-neutral-500">
      <div>
        Wooi didn&apos;t recognize something from {backend} — {item.what}. The conversation
        continued without it.
      </div>
      {item.hint && <div className="mt-1 text-neutral-600">{item.hint}</div>}
    </div>
  )
}

/**
 * 스택 자식이 올린 인계 보고 카드.
 *
 * **이 카드는 사람을 위한 것이다.** 트랜스크립트는 에이전트의 대화 맥락과 별개라, 이 워크스페이스의
 * 모델은 여기 쓰인 내용을 읽지 않는다 — 읽게 하려면 `check_stacked_work` 를 부르게 해야 한다.
 * 그 사실이 화면에서도 드러나도록 안내 한 줄을 같이 둔다.
 */
function HandoffCard({
  item
}: {
  item: Extract<ChatItem, { type: 'handoff' }>
}): React.JSX.Element {
  const selectWorkspace = useStore((s) => s.selectWorkspace)
  const exists = useStore((s) => s.app?.workspaces.some((w) => w.id === item.childWorkspaceId))
  const blocked = item.status === 'blocked'

  return (
    <div
      className={
        'rounded-lg border px-3 py-2.5 text-sm ' +
        (blocked
          ? 'border-[var(--warning-500)]/25 bg-[var(--warning-500)]/10'
          : 'border-[var(--border-2)] bg-[var(--surface)]')
      }
    >
      <div className="flex items-center gap-1.5">
        <Layers size={13} className={blocked ? 'text-[var(--warning-300)]' : 'text-neutral-400'} />
        <span className="text-neutral-200">
          {blocked ? 'Stacked work is blocked' : 'Stacked work finished'}
        </span>
        <span className="min-w-0 truncate font-mono text-xs text-neutral-500">
          {item.childBranch}
        </span>
        <div className="flex-1" />
        {exists && (
          <button
            onClick={() => void selectWorkspace(item.childWorkspaceId)}
            className="shrink-0 rounded-md px-2 py-0.5 text-xs text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100"
          >
            Open {item.childName}
          </button>
        )}
      </div>
      <div className="mt-1.5 whitespace-pre-wrap text-neutral-300">{item.summary}</div>
      <div className="mt-1.5 text-xs text-neutral-500">
        The agent here hasn&rsquo;t seen this — ask it to check stacked work if it should act on it.
      </div>
    </div>
  )
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
  cwd,
  agent,
  output,
  exitCode,
  running,
  verbose,
  onStop
}: {
  command: string
  /** 실행 디렉터리. 에이전트가 worktree 밖에서 돌렸을 때를 알아볼 수 있게 툴팁에 싣는다. */
  cwd?: string
  /** 에이전트가 실행한 명령인가(사용자의 `!명령` 과 구분). */
  agent?: boolean
  output: string
  exitCode: number | null
  running: boolean
  /** 도구 로그 전체 펼치기(⌃O) 상태. */
  verbose: boolean
  onStop: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const failed = !running && exitCode != null && exitCode !== 0
  const maxLines = agent ? BASH_FOLD.agent : BASH_FOLD.user
  const folded = foldBashOutput(output, maxLines)
  const expanded = verbose || open
  const shown = expanded ? output : folded.text
  return (
    <div className="group/bash rounded-lg border border-[var(--border)] bg-[var(--bg-3)] overflow-hidden font-mono text-xs">
      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-[var(--border)] bg-[var(--surface)]">
        <TerminalIcon size={12} className="text-neutral-500 shrink-0" />
        {/* 에이전트가 돌린 명령은 프롬프트 기호를 달리해, 내가 친 `!명령` 과 한눈에 구분되게 한다. */}
        <span
          className={
            'shrink-0 ' + (agent ? 'text-[var(--accent-400)]' : 'text-[var(--success-400)]')
          }
          title={agent ? 'Run by the agent' : 'Run by you'}
        >
          {agent ? '⌁' : '$'}
        </span>
        <span
          className="text-neutral-200 truncate"
          title={cwd ? `${command}\n\n(in ${cwd})` : command}
        >
          {command}
        </span>
        <span className="ml-auto shrink-0">
          {running ? (
            <button
              onClick={onStop}
              title={agent ? 'Interrupt the turn' : 'Stop'}
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
        <button
          type="button"
          className={`block w-full text-left ${SELECTABLE}`}
          onClick={unlessSelecting(() => setOpen((value) => !value))}
        >
          <pre
            className={
              'px-2.5 py-2 overflow-x-auto whitespace-pre-wrap text-neutral-400 ' +
              (expanded ? 'max-h-96 overflow-y-auto' : 'overflow-hidden')
            }
            // 긴 단일 행이 줄바꿈돼도 Codex와 같은 화면 행 예산을 넘지 않는다.
            style={expanded ? undefined : { maxHeight: `calc(${maxLines} * 1.5em + 1rem)` }}
          >
            {shown}
          </pre>
          {folded.omitted > 0 && (
            <span className="block border-t border-[var(--border)] px-2.5 py-1 text-xs text-neutral-600 hover:text-neutral-400">
              {expanded ? 'Collapse output' : `Show full output (${DENSITY_SHORTCUT} to expand)`}
            </span>
          )}
        </button>
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
    case 'handoff':
      return `${it.childName} ${it.childBranch} ${it.summary}`
    case 'unknown':
      return it.what
    default:
      return ''
  }
}

/** 속성 선택자 값에 들어갈 수 있는 따옴표·역슬래시를 이스케이프한다. */
function cssAttr(value: string): string {
  return value.replace(/["\\]/g, '\\$&')
}
