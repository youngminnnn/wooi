import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Send,
  Square,
  Terminal as TerminalIcon,
  MessageCircleQuestion,
  X,
  Clock,
  ImageIcon,
  Loader2,
  Plug,
  RefreshCw,
  Gauge,
  Receipt,
  Bot,
  Folder,
  FileText,
  ChevronRight,
  ArrowLeft,
  RotateCw,
  Power,
  PowerOff,
  Cpu,
  Zap,
  Rabbit,
  Check,
  History,
  ShieldCheck,
  Sparkles,
  Webhook,
  RotateCcw,
  Activity,
  BookMarked,
  Wrench
} from 'lucide-react'
import { useStore } from '../store'
import { permissionModeFooter, permissionModesFor } from '../lib/permission'
import { modelLabel, modelSupportsFastMode } from '../lib/models'
import { effortLabel, effortOptionsFor } from '../lib/effort'
import { FAST_MODE_HINT, fastModeLabel, fastModeStatus } from '../lib/fastMode'
import {
  useAgentSettings,
  useAvailableBackends,
  useModels,
  useWorkspaceBackend
} from '../lib/backends'
import { AgentBackendMark } from './BrandIcons'
import {
  AGENT_BACKEND_LABELS,
  INTERACTIVE_COMMANDS,
  MENTION_DROP_HINT_BYTES,
  MENTION_TRUNCATE_HINT_BYTES,
  agentSwitchNeedsHandoff,
  canSwitchAgentBackend
} from '@shared/types'
import { buildHandoffPrompt, estimateHandoffTokens, formatHandoffTokens } from '@shared/handoff'
import { useNow } from '../lib/useNow'
import {
  agoLabel,
  headlineWindows,
  isStale,
  isWarning,
  normalizeUtilization,
  resetLabel,
  shouldShowRateLimits
} from '../lib/rateLimit'
import { formatBytes } from '../lib/format'
import { appendMention, findMention, mentionToken, mentionWithRange } from '../lib/mention'
import { parseSubtaskCommand, subtaskPrompt, subtaskUnavailableReason } from '../lib/subtaskCommand'
import type {
  AgentBackendId,
  ChatItem,
  CommandPanelKind,
  CommandResult,
  EffortSetting,
  FileHit,
  HooksInfo,
  ImageAttachment,
  ImageMediaType,
  McpAction,
  McpServerInfo,
  MemoryScope,
  PermissionMode,
  PermissionsInfo,
  RateLimitSnapshot,
  RewindPoint,
  SlashCommandInfo,
  SkillInfo,
  StatusInfo,
  UsageTotals,
  Workspace,
  WorkspaceUsageInfo
} from '@shared/types'
import { matchWooiCommand, parseWooiCommandArgs, wooiCommandName } from '@shared/wooiCommands'
import { conversationForkDisabledReason, parseForkCommand } from '../lib/conversationFork'
import type { WooiCommandSpec } from '@shared/wooiCommands'
import { openSettings } from '../lib/settingsNavigation'
import type { ExportConversationDetail } from './ExportMenu'
import { WOOI_URLS } from '../lib/externalLinks'
import { FOCUS_COMPOSER_EVENT } from '../lib/composerFocus'

/** Claude 가 받는 이미지 형식. 클립보드의 다른 형식은 붙여넣기 시 무시한다. */
const IMAGE_TYPES: Record<string, ImageMediaType> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/gif': 'image/gif',
  'image/webp': 'image/webp'
}

/**
 * "Esc 두 번"으로 인정하는 최대 간격. 짧으면 의도한 연타를 놓치고, 길면 한참 뒤의 Esc 한 번이
 * 되감기 패널을 여는 것처럼 느껴진다.
 */
const DOUBLE_ESC_MS = 700

/** 화면에 띄우는 붙여넣기 이미지: 전송용 base64 + 썸네일용 data URL. */
type PendingImage = ImageAttachment & { id: string; previewUrl: string }

/** Blob → 순수 base64(+data URL). FileReader 로 읽어 "data:...;base64," 접두사를 떼어 본문만 남긴다. */
function readImage(blob: Blob): Promise<{ dataBase64: string; dataUrl: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result)
      resolve({ dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1), dataUrl })
    }
    reader.onerror = () => reject(reader.error ?? new Error('image read failed'))
    reader.readAsDataURL(blob)
  })
}

export default function Composer({ workspace }: { workspace: Workspace }): React.JSX.Element {
  // 초안은 store 에 보관해 workspace 전환에도 살아남는다(작성 중 메시지 분실 방지).
  const text = useStore((s) => s.drafts[workspace.id] ?? '')
  const setDraft = useStore((s) => s.setDraft)
  const promptSuggestion = useStore((s) => s.promptSuggestions[workspace.id] ?? null)
  const clearPromptSuggestion = useStore((s) => s.clearPromptSuggestion)
  const items = useStore((s) => s.transcripts[workspace.id]) ?? EMPTY
  // 실행 중 보낸 후속 메시지의 대기 큐(전송 전이라 취소 가능, 턴 종료 시 자동 전송).
  const queue = useStore((s) => s.messageQueue[workspace.id]) ?? EMPTY_QUEUE
  const enqueueMessage = useStore((s) => s.enqueueMessage)
  const removeQueued = useStore((s) => s.removeQueued)
  const pushToast = useStore((s) => s.pushToast)
  const confirm = useStore((s) => s.confirm)
  const refreshAuth = useStore((s) => s.refreshAuth)
  const resetTranscript = useStore((s) => s.resetTranscript)
  const taRef = useRef<HTMLTextAreaElement>(null)
  // ↑ 로 이전 사용자 메시지를 불러올 때의 커서(끝에서부터). -1 = 미사용.
  const historyIdx = useRef(-1)
  // 마지막으로 Esc 를 눌러 아무것도 소비되지 않은 시각(Esc 두 번 = 되감기 판정용). 0 = 없음.
  const lastEscAt = useRef(0)
  const running = workspace.status === 'running'
  // 대화 압축(자동/수동 /compact)이 도는 동안은 입력을 잠근다 — 압축 중에 보낸 메시지는 압축
  // 전 맥락에 끼어들어 방금 압축한 결과를 무의미하게 만든다(Claude Code CLI 도 같은 동안 막는다).
  // running 을 함께 보는 건 안전장치다: 배지가 어떤 이유로 남더라도 턴이 끝나면 입력이 풀린다.
  const compacting = useStore((s) => s.compacting[workspace.id] ?? false)
  const locked = compacting && running
  // 권한 모드의 푸터 문구는 백엔드가 선언한다(Claude 와 Codex 는 모드 이름부터 다르다).
  const backend = useWorkspaceBackend(workspace)
  // 이 백엔드가 답할 수 있는 인터랙티브 명령만 가로챈다. 카탈로그를 아직 못 읽었으면 빈 목록이라
  // 전부 일반 텍스트로 나가는데, 그게 "에러 토스트"보다 나은 폴백이다.
  const supportedCommands = backend?.capabilities.interactiveCommands ?? EMPTY_COMMANDS
  const supportsSideQuestion = backend?.capabilities.sideQuestion ?? false
  // 지원하지 않는 백엔드에서는 /fast 도 상태줄 표시도 감춘다.
  const supportsFastMode = backend?.capabilities.fastMode ?? false
  // 에이전트가 둘 이상이면 /agent 로 메인 에이전트를 바꿀 수 있다 — 상태줄 칩과 같은 판단을 쓴다.
  const agentSwitch = useAgentSwitch(workspace)

  // 슬래시 명령 자동완성: 명령 목록(워크스페이스당 1회 조회)과 메뉴 선택 인덱스.
  // 받아 둔 목록 + 그것이 무엇에 대한 목록인지(commandsKey). 아래 fresh 참고.
  const [commands, setCommands] = useState<{ key: string; list: SlashCommandInfo[] } | null>(null)
  const [loadingCommands, setLoadingCommands] = useState(false)
  const [menuIdx, setMenuIdx] = useState(0)

  // /btw 사이드 질문의 임시 답변(트랜스크립트와 분리, 닫으면 사라짐).
  const [sideAnswer, setSideAnswer] = useState<SideAnswer | null>(null)

  // /mcp·/context 등 인터랙티브 명령 결과 카드(임시 표시, 닫으면 사라짐).
  const [commandCard, setCommandCard] = useState<CommandCardState | null>(null)
  // /model·/effort·/fast·/agent 선택 카드(로컬 처리, 닫으면 사라짐).
  const [pickerCard, setPickerCard] = useState<PickerKind | null>(null)
  // `/wooi:*` 즉시 실행 결과 카드(임시 표시, 닫으면 사라짐).
  const [wooiCard, setWooiCard] = useState<WooiCardState | null>(null)
  // `#` 로 적은 기억. 어느 CLAUDE.md 에 남길지 고르는 동안만 들고 있는다.
  const [memoryDraft, setMemoryDraft] = useState<string | null>(null)
  // `/memory` 에 스코프가 없을 때 어느 CLAUDE.md 를 열지 고르는 카드.
  const [memoryOpenPick, setMemoryOpenPick] = useState(false)
  // 카드 응답을 현재 요청과만 맞추기 위한 단조 토큰(워크스페이스/명령 전환 시 stale 응답 무시).
  const cmdSeq = useRef(0)

  // 붙여넣은 이미지 첨부(전송 전 대기). 초안과 달리 워크스페이스 전환 시 비운다(다른 작업으로 새지 않도록).
  const [images, setImages] = useState<PendingImage[]>([])
  // 같은 워크스페이스 안에서 첨부 id 가 겹치지 않도록 하는 단조 카운터.
  const imgSeq = useRef(0)

  // @파일 멘션 자동완성. 멘션 감지는 커서 위치 기준이라 selectionStart 를 따라간다.
  const [caret, setCaret] = useState(0)
  const [mentionResult, setMentionResult] = useState<{ query: string; hits: FileHit[] } | null>(
    null
  )
  // Esc 로 닫은 `@` 토큰의 시작 위치. 같은 토큰을 계속 타이핑해도 메뉴가 다시 열리지 않게 한다.
  const [mentionDismissedAt, setMentionDismissedAt] = useState<number | null>(null)
  // 검색 응답을 현재 질의와만 맞추기 위한 단조 토큰(느린 응답이 최신 결과를 덮지 않도록).
  const mentionSeq = useRef(0)

  // 파일을 입력창 위로 끌어오는 중인지(드롭 대상임을 테두리로 알린다).
  const [dragging, setDragging] = useState(false)

  // 워크스페이스를 바꾸면 이전 사이드 답변·명령 카드·대기 중 첨부를 치운다(다른 작업으로 새지 않도록).
  useEffect(() => {
    setSideAnswer(null)
    setCommandCard(null)
    setWooiCard(null)
    setPickerCard(null)
    setMemoryDraft(null)
    setMemoryOpenPick(false)
    setImages([])
    setMentionResult(null)
    setMentionDismissedAt(null)
    // 초안이 통째로 바뀌므로 이전 워크스페이스의 커서 위치는 버린다
    // (남겨 두면 새 초안의 엉뚱한 자리를 `@` 토큰으로 오인해 메뉴가 뜬다).
    setCaret(0)
  }, [workspace.id])

  /** /model·/effort·/fast·/agent 선택 카드를 연다(다른 카드는 비켜 준다). 상태줄 클릭·슬래시 명령 공용. */
  const openPicker = (kind: PickerKind): void => {
    setSideAnswer(null)
    setCommandCard(null)
    setMemoryOpenPick(false)
    setPickerCard(kind)
  }

  const removeImage = (id: string): void => setImages((prev) => prev.filter((i) => i.id !== id))

  /** 이미지 파일 1개를 전송 대기 첨부로 올린다(붙여넣기·드롭 공용). */
  const addImage = (file: File, mediaType: ImageMediaType): void => {
    const id = `img:${imgSeq.current++}`
    const ext = mediaType.split('/')[1]
    const name =
      file.name && file.name !== 'image.png' ? file.name : `image-${imgSeq.current}.${ext}`
    void readImage(file).then(({ dataBase64, dataUrl }) => {
      setImages((prev) => [...prev, { id, name, mediaType, dataBase64, previewUrl: dataUrl }])
    })
  }

  /**
   * Preview 가 보내온 것(스크린샷·고른 요소) 받기. 캡처와 픽커는 다른 창(분리한 work 창)에서
   * 일어날 수 있어 store 를 우편함처럼 쓴다 — 도착한 것을 여기서 꺼내 이미지는 붙여넣기와 같은
   * 대기 첨부로, 텍스트는 초안 끝으로 올린다.
   *
   * 위의 "워크스페이스 전환 시 비우기" 이펙트보다 **뒤에** 있어야 한다. 앞에 두면 워크스페이스를
   * 옮기는 순간 방금 꺼낸 첨부가 그 초기화에 함께 지워진다(이펙트는 선언 순서대로 실행된다).
   */
  const pendingAttachments = useStore((s) => s.composerAttachments[workspace.id])
  const takeAttachments = useStore((s) => s.takeComposerAttachments)
  useEffect(() => {
    if (!pendingAttachments?.length) return
    const taken = takeAttachments(workspace.id)

    const images = taken.map((a) => a.image).filter((img) => img != null)
    if (images.length)
      setImages((prev) => [
        ...prev,
        ...images.map((img) => ({
          ...img,
          id: `img:${imgSeq.current++}`,
          previewUrl: `data:${img.mediaType};base64,${img.dataBase64}`
        }))
      ])

    // 초안은 store 가 들고 있으므로 최신 값을 그때 읽어 이어 붙인다 — 이 이펙트의 클로저가 본
    // text 로 덮어쓰면 그사이 사용자가 친 글자가 사라진다.
    const blocks = taken.map((a) => a.text).filter((t) => t != null && t.trim() !== '')
    if (blocks.length) {
      const current = useStore.getState().drafts[workspace.id] ?? ''
      setDraft(workspace.id, [current.trimEnd(), ...blocks].filter(Boolean).join('\n\n') + '\n\n')
      taRef.current?.focus()
    }
  }, [pendingAttachments, takeAttachments, setDraft, workspace.id])

  /** 클립보드의 이미지를 첨부로 받는다. 이미지가 하나라도 있으면 기본 텍스트 붙여넣기를 막는다. */
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(e.clipboardData.items)
      .filter((it) => it.kind === 'file' && IMAGE_TYPES[it.type])
      .map((it) => ({ mediaType: IMAGE_TYPES[it.type], file: it.getAsFile() }))
      .filter((x): x is { mediaType: ImageMediaType; file: File } => x.file != null)
    if (!files.length) return // 텍스트 붙여넣기는 그대로 둔다.

    e.preventDefault()
    for (const { mediaType, file } of files) addImage(file, mediaType)
  }

  // 사이드 질문 스트림 구독. 현재 워크스페이스의 이벤트만, id 로 스트림을 구분해 반영한다.
  useEffect(() => {
    return window.api.onSideQuestion((e) => {
      if (e.workspaceId !== workspace.id) return
      setSideAnswer((prev) => {
        if (e.phase === 'start')
          return { id: e.id, question: e.question, text: '', status: 'streaming' }
        if (!prev || prev.id !== e.id) return prev
        if (e.phase === 'delta') return { ...prev, text: prev.text + e.text }
        if (e.phase === 'done') return { ...prev, status: 'done' }
        return { ...prev, status: 'error', error: e.message }
      })
    })
  }, [workspace.id])

  const setText = (v: string): void => setDraft(workspace.id, v)

  // App 의 전역 ⌘L 단축키가 현재 대화의 실제 textarea 를 직접 알 필요가 없도록 이벤트로 잇는다.
  useEffect(() => {
    const focus = (): void => taRef.current?.focus()
    window.addEventListener(FOCUS_COMPOSER_EVENT, focus)
    return () => window.removeEventListener(FOCUS_COMPOSER_EVENT, focus)
  }, [])

  // textarea 높이 자동 조절.
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`
  }, [text])

  // 입력이 "/명령이름" 단계(아직 공백 없음)인지. 이때만 자동완성 메뉴를 띄운다.
  const slashQuery = useMemo(() => {
    const m = /^\/(\S*)$/.exec(text)
    return m ? m[1] : null
  }, [text])

  // "!" 로 시작하면 Claude Code CLI 의 bash 모드처럼 — 메시지가 아니라 터미널 명령으로 다룬다.
  const bashMode = text.startsWith('!')

  /**
   * 받아 둔 목록이 **무엇에 대한** 목록인지. 이 값이 달라지면 캐시는 낡은 것이다.
   *
   * 목록은 한 번 받으면 계속 쓰는데(아래 effect 의 가드), 이 두 값은 목록 자체를 바꾼다 —
   * 에이전트 팀으로 바꾸면 `/wooi:claude` 같은 위임 명령이 생기고([[shared/wooiCommands]]),
   * 메인 에이전트를 바꾸면 백엔드가 답하는 명령이 통째로 달라진다. 실측으로, 팀으로 바꾼 뒤에도
   * `/wooi:c` 에 위임 명령이 뜨지 않았다.
   *
   * effect 로 캐시를 비우지 않고 키를 함께 들고 있는 이유: 비우는 방식은 한 프레임 동안 낡은
   * 목록이 그대로 보이고, setState-in-effect 로 렌더가 한 번 더 돈다. 키가 어긋나면 캐시가
   * 없는 것으로 치는 편이 파생값에 가깝다.
   *
   * 워크스페이스 전환은 여기서 다루지 않는다 — ChatView 가 `key={workspace.id}` 로 이 컴포넌트를
   * 통째로 다시 만들어 상태가 저절로 비워진다([[App]]).
   */
  const commandsKey = `${workspace.agentBackend}:${workspace.multiAgent ? 'team' : 'solo'}`
  const fresh = commands?.key === commandsKey ? commands.list : null

  // 슬래시 모드 진입 시 명령 목록을 lazy 하게 조회한다.
  useEffect(() => {
    if (slashQuery === null || fresh !== null || loadingCommands) return
    setLoadingCommands(true)
    void window.api.commands.list(workspace.id).then((list) => {
      setCommands({ key: commandsKey, list })
      setLoadingCommands(false)
    })
  }, [slashQuery, fresh, loadingCommands, workspace.id, commandsKey])

  // 접두사 우선, 없으면 부분일치로 필터링. 접두사 매치를 위로 올린다.
  const matches = useMemo(() => {
    if (slashQuery === null || !fresh) return []
    const q = slashQuery.toLowerCase()
    const scored = fresh
      .map((c) => {
        // 이름 우선, 없으면 별칭(/cost·/stats 등)으로도 매칭한다.
        const names = [c.name, ...(c.aliases ?? [])].map((n) => n.toLowerCase())
        const rank = names.some((n) => n.startsWith(q))
          ? 0
          : names.some((n) => n.includes(q))
            ? 1
            : 2
        return { c, rank }
      })
      .filter((x) => x.rank < 2)
      .sort((a, b) => a.rank - b.rank || a.c.name.localeCompare(b.c.name))
    return scored.map((x) => x.c)
  }, [slashQuery, fresh])

  const menuOpen = slashQuery !== null && (loadingCommands || matches.length > 0)

  // 커서 직전의 `@토큰`. Esc 로 닫은 토큰이면 열지 않는다.
  const mention = useMemo(() => {
    const found = findMention(text, caret)
    if (!found || found.at === mentionDismissedAt) return null
    return found
  }, [text, caret, mentionDismissedAt])

  // `@` 질의가 바뀔 때마다 후보를 다시 조회한다(main 쪽에서 인덱스를 캐시하므로 매 타이핑 호출해도 싸다).
  const mentionQuery = mention?.query ?? null
  useEffect(() => {
    if (mentionQuery === null) return
    const seq = ++mentionSeq.current
    void window.api.fs.search(workspace.id, mentionQuery).then((hits) => {
      if (seq !== mentionSeq.current) return // 더 최신 질의가 이미 나갔다.
      setMentionResult({ query: mentionQuery, hits })
    })
  }, [mentionQuery, workspace.id])

  // 결과를 "어떤 질의의 결과인지"와 함께 들고 있다가 파생시킨다 — 질의가 바뀔 때마다
  // 이펙트에서 비우고 로딩 플래그를 세우면 렌더가 연쇄로 늘어난다.
  const mentionHits =
    mentionResult && mentionResult.query === mentionQuery ? mentionResult.hits : EMPTY_HITS
  const loadingMentions = mentionQuery !== null && mentionResult?.query !== mentionQuery

  const mentionOpen = mention !== null && (loadingMentions || mentionHits.length > 0)

  useEffect(() => {
    setMenuIdx(0)
  }, [slashQuery, mentionQuery])

  /** 입력과 커서를 함께 바꾼다 — 멘션 감지가 커서 위치에 걸려 있어 둘이 어긋나면 안 된다. */
  const setTextAt = (v: string, nextCaret: number): void => {
    setText(v)
    setCaret(nextCaret)
    requestAnimationFrame(() => {
      const ta = taRef.current
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(nextCaret, nextCaret)
    })
  }

  /**
   * 떨어뜨린 파일 처리.
   * 이미지는 붙여넣기와 같은 base64 첨부로, 나머지는 `@경로` 멘션으로 넣는다.
   * worktree 안의 파일은 상대경로로 줄여 CLI 가 cwd 기준으로 바로 찾게 하고,
   * 밖의 파일은 절대경로를 그대로 쓴다(CLI 는 절대경로 멘션도 받는다).
   */
  const handleDroppedFiles = (files: File[]): void => {
    if (!files.length) return

    const root = workspace.worktreePath.replace(/\/+$/, '') + '/'
    let draft = text
    let mentioned = false

    for (const file of files) {
      const mediaType = IMAGE_TYPES[file.type]
      if (mediaType) {
        addImage(file, mediaType)
        continue
      }
      const abs = window.api.pathForFile(file)
      if (!abs) continue
      draft = appendMention(
        draft,
        mentionWithRange(abs.startsWith(root) ? abs.slice(root.length) : abs)
      )
      mentioned = true
    }
    if (mentioned) setTextAt(draft, draft.length)
  }

  // 최신 핸들러를 ref 로 들고 있는다 — 아래 window 리스너는 한 번만 붙이므로
  // 클로저가 첫 렌더의 text/workspace 를 계속 보게 두면 안 된다.
  const dropRef = useRef(handleDroppedFiles)
  useEffect(() => {
    dropRef.current = handleDroppedFiles
  })

  /**
   * 파일 드롭은 입력창 박스가 아니라 **창 전체**에서 받는다.
   * 입력창에만 붙이면 사이드바나 대화 영역에 떨어뜨렸을 때 아무 반응 없이 무시된 것처럼 보인다
   * (기본 동작인 file:// 이동은 메인의 will-navigate 가 막지만, 사용자에겐 그냥 먹통으로 보인다).
   * dragover 에서 preventDefault 를 해 줘야 브라우저가 drop 을 허용한다.
   */
  useEffect(() => {
    const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer?.types.includes('Files')
    const onDragOver = (e: DragEvent): void => {
      if (!hasFiles(e)) return // 텍스트 선택 드래그 등은 그대로 둔다.
      e.preventDefault()
      setDragging(true)
    }
    const onDragLeave = (e: DragEvent): void => {
      // 창 밖으로 완전히 나갔을 때만 끈다(요소 사이를 지날 때도 dragleave 가 뜬다).
      if (!e.relatedTarget) setDragging(false)
    }
    const onDrop = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      setDragging(false)
      dropRef.current(Array.from(e.dataTransfer?.files ?? []))
    }
    const onDragEnd = (): void => setDragging(false)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    window.addEventListener('dragend', onDragEnd)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('dragend', onDragEnd)
    }
  }, [])

  /** 고른 파일/디렉토리를 `@` 토큰 자리에 넣는다. */
  const acceptMention = (hit: FileHit): void => {
    if (!mention) return
    const token = mentionToken(hit)
    const head = text.slice(0, mention.at) + token
    setTextAt(head + text.slice(caret), head.length)
    historyIdx.current = -1
  }

  // 압축이 끝나 입력창이 풀리면 포커스를 돌려준다 — disabled 가 되는 순간 브라우저가 포커스를
  // 떼므로, 그대로 두면 사용자가 입력창을 다시 클릭해야 한다(초안은 그대로 남아 있다).
  const wasLocked = useRef(false)
  useEffect(() => {
    if (wasLocked.current && !locked) taRef.current?.focus()
    wasLocked.current = locked
  }, [locked])

  /**
   * "!명령" 을 1회 실행한다(Claude Code CLI bash 모드). 실행했으면 true.
   * 우측 터미널 패널이 아니라 대화 흐름 안에 명령/출력을 인라인으로 보여 준다.
   */
  const runBash = (trimmed: string): boolean => {
    if (images.length || !trimmed.startsWith('!')) return false
    const command = trimmed.slice(1).trim()
    if (!command) return true // "!" 만 입력 — 메시지로 새지 않도록 삼키되 아무것도 실행 안 함.
    if (workspace.agentBackend === 'codex') void window.api.chat.send(workspace.id, trimmed)
    else void window.api.terminal.exec(workspace.id, command)
    return true
  }

  /**
   * 메시지를 실제로 백엔드에 넘긴다. steering 을 못 하는 백엔드만 실행 중 메시지를 대기 큐에
   * 넣는다(Codex 처럼 지원하면 즉시 보내 현재 턴에 반영한다). /subtask 가 렌더러에서 만들어 낸
   * 프롬프트도 이 길을 타야 큐잉·중단 규칙이 입구마다 갈라지지 않는다.
   */
  const deliver = (body: string, payload?: ImageAttachment[], stopFirst?: boolean): void => {
    setPickerCard(null)
    clearPromptSuggestion(workspace.id)
    if (running && !backend?.capabilities.steering) {
      enqueueMessage(workspace.id, body, payload?.length ? payload : undefined)
      // 큐에 넣은 뒤 중단한다 — 순서가 반대면 턴이 먼저 끝나 플러시가 이 메시지를 놓친다.
      if (stopFirst) void window.api.chat.interrupt(workspace.id)
    } else {
      void window.api.chat.send(workspace.id, body, payload?.length ? payload : undefined)
    }
  }

  /**
   * 입력창 내용을 보낸다.
   *
   * stopFirst 는 "지금 하던 걸 멈추고 이거부터" — 터미널에서 Esc 로 끊고 다시 치는 조작을 한 번에
   * 한다. 메시지를 큐에 넣고 턴을 중단하면, 턴이 idle 로 끝나는 순간 store 의 큐 플러시가 그대로
   * 이어서 보낸다(중단이 에러로 끝나면 메시지는 큐에 남아 사용자가 확인·취소할 수 있다).
   */
  const send = (opts?: { stopFirst?: boolean }): void => {
    // 압축 중에는 전송(및 로컬 명령·bash)을 모두 막는다 — 초안은 그대로 두고, 압축이 끝나면
    // 사용자가 그대로 다시 Enter 를 누르면 된다.
    if (locked) return
    const trimmed = text.trim()
    if (!trimmed && !images.length) return // 텍스트도 첨부도 없으면 무시.

    // "# 기억할 내용" 은 메시지가 아니라 CLAUDE.md 에 남긴다 — 어느 파일에 쓸지만 고르면 된다.
    // CLAUDE.md 를 읽는 백엔드에서만 가로챈다(Codex 는 규약이 다르므로 평범한 메시지로 보낸다).
    const memo = images.length || workspace.agentBackend !== 'claude' ? null : matchMemory(trimmed)
    if (memo) {
      setSideAnswer(null)
      setCommandCard(null)
      setWooiCard(null)
      setPickerCard(null)
      setMemoryOpenPick(false)
      setMemoryDraft(memo)
      setText('')
      historyIdx.current = -1
      return
    }

    // "!명령" 은 메시지로 보내지 않고 터미널에서 실행한다(Claude Code CLI 의 bash 모드).
    if (runBash(trimmed)) {
      setText('')
      historyIdx.current = -1
      return
    }

    // Codex 는 자체 카드로 app-server 의 plan mode 를 바꾸므로, 그 카드가 없는 백엔드에서만
    // 범용 권한 모드 선택기가 /plan 을 맡는다.
    const offersPlanPicker =
      permissionModesFor(backend).length > 1 && !supportedCommands.includes('plan')
    // /model·/effort·/fast·/agent·/plan 은 백엔드 왕복 없이 로컬 선택 카드로 처리한다(첨부가 있으면 일반 전송).
    const picker = images.length
      ? null
      : matchPicker(trimmed, {
          fast: supportsFastMode,
          agent: agentSwitch.offered,
          plan: offersPlanPicker
        })
    if (picker) {
      openPicker(picker)
      setText('')
      historyIdx.current = -1
      return
    }

    // /mcp·/context·/reload-plugins 등 인터랙티브(TUI 전용) 명령은 일반 프롬프트로 보내면 동작하지
    // 않으므로 인터셉트해 SDK 제어 메서드로 실행하고 결과를 카드로 보여 준다(첨부가 있으면 일반 전송).
    const interactive = images.length ? null : matchInteractive(trimmed, supportedCommands)
    if (interactive) {
      runInteractive(interactive)
      setText('')
      historyIdx.current = -1
      return
    }

    // Codex 계정/설치 화면 명령. 기존 설정·인증 경로를 재사용하고 모델 턴으로 보내지 않는다.
    const codexLocal = images.length ? null : matchCodexLocal(trimmed, workspace.agentBackend)
    if (codexLocal) {
      setText('')
      historyIdx.current = -1
      if (codexLocal === 'plugins') {
        openSettings('plugins')
      } else {
        // 이 Enter keydown 안에서 곧바로 confirm을 마운트하면, 같은 Enter가 ConfirmDialog의
        // 전역 핸들러까지 이어져 위험 동작을 즉시 승인한다. 다음 이벤트 루프에서 열어 키를 분리한다.
        setTimeout(() => {
          void confirm({
            title: 'Sign out of Codex?',
            body: 'You will need to sign in again before starting another Codex session.',
            confirmLabel: 'Sign out',
            danger: true
          }).then((ok) => {
            if (!ok) return
            void window.api.auth.codexLogout().then(
              () => {
                pushToast('success', 'Signed out of Codex.')
                openSettings('integrations')
              },
              (error: unknown) =>
                pushToast('error', error instanceof Error ? error.message : 'Could not sign out.')
            )
          })
        }, 0)
      }
      return
    }

    // `/wooi:*` 중 즉시 실행 명령은 에이전트를 거치지 않고 메인에서 도구를 바로 돌린다.
    // 나머지(`agent` 모드)는 가로채지 않고 그대로 흘려보낸다 — Claude 는 CLI 가 플러그인 본문으로,
    // Codex 는 매니저가 로컬로 확장한다([[shared/wooiCommands]]).
    const wooi = images.length ? null : matchWooiCommand(trimmed)
    if (wooi && wooi.spec.mode === 'direct') {
      runWooiCommand(wooi.spec, wooi.rest)
      historyIdx.current = -1
      return
    }

    // /fork 는 에이전트 제품의 명령이 아니라 Wooi 워크스페이스를 만드는 명령이다. 두 백엔드가
    // 같은 IPC 를 타야 원본을 보존한다는 계약과 안전 가드가 제품마다 갈라지지 않는다.
    const fork = images.length ? null : parseForkCommand(trimmed)
    if (fork) {
      const disabledReason = conversationForkDisabledReason(workspace)
      if (disabledReason) {
        pushToast('info', disabledReason)
        return
      }
      setText('')
      historyIdx.current = -1
      void useStore.getState().forkWorkspace(workspace.id, fork)
      return
    }

    // /diff·/copy·/help·/clear 등은 Wooi UI 에서 직접 처리한다(에이전트로 보내지 않는다).
    // runLocal 이 입력창 텍스트를 알맞게 정리하므로(대부분 비우고, /help 만 '/' 로 메뉴를 띄움)
    // 여기서는 setText 를 호출하지 않는다.
    const local = images.length ? null : matchLocal(trimmed, workspace.agentBackend === 'claude')
    if (local) {
      runLocal(local, trimmed)
      historyIdx.current = -1
      return
    }

    // /subtask 는 CLI 의 TUI 전용 명령이라 그냥 보내면 실패한다. Wooi 에는 같은 일을 하는 위임
    // 커맨드가 이미 있으므로 이 워크스페이스의 백엔드 것(`/wooi:claude`·`/wooi:codex`)으로 확장해
    // 평범한 메시지로 보낸다 — 렌더러에서 확장해야 CLI 가 확장하는 Claude 와 매니저가 확장하는
    // Codex 가 같은 길을 탄다.
    const subtask = images.length ? null : parseSubtaskCommand(trimmed)
    if (subtask) {
      const unavailable = subtaskUnavailableReason({
        multiAgent: workspace.multiAgent ?? false,
        canDelegate: backend?.capabilities.delegate ?? true
      })
      if (unavailable) {
        // 쓸 수 없을 때는 입력창을 비우지 않는다 — 팀으로 바꾼 뒤 그대로 다시 보내면 된다.
        pushToast('info', unavailable)
        taRef.current?.focus()
        return
      }
      if (!subtask.task) {
        pushToast('info', 'Usage: /subtask <task> — delegates it to a subagent in this workspace.')
        setText('/subtask ')
        taRef.current?.focus()
        return
      }
      deliver(subtaskPrompt(workspace.agentBackend, subtask.task))
      setText('')
      historyIdx.current = -1
      return
    }

    const lifecycle = images.length ? null : matchLifecycle(trimmed)
    if (lifecycle) {
      if (lifecycle.kind === 'rename') {
        if (lifecycle.name === null) {
          // Composer 에서는 ChatView 의 로컬 편집 상태에 닿을 수 없어 /diff 와 같은 이벤트로 연결한다.
          window.dispatchEvent(new CustomEvent('wooi:rename-workspace', { detail: workspace.id }))
        } else {
          const name = lifecycle.name
          void window.api.workspace.rename(workspace.id, name).then(
            () => pushToast('success', `Renamed workspace to “${name}”.`),
            (error) =>
              pushToast(
                'error',
                error instanceof Error ? error.message : 'Could not rename this workspace.'
              )
          )
        }
      } else {
        pushToast(
          'info',
          lifecycle.kind === 'archive'
            ? 'Use the sidebar Archive action so Wooi can show the workspace safety checks.'
            : '/delete is unavailable because its scope and confirmation cannot be made unambiguous here.'
        )
      }
      setText('')
      historyIdx.current = -1
      return
    }

    // /btw 는 사이드 질문으로 분기한다 — 일반 메시지로 보내면 현재 턴 뒤에 큐잉되어 메인 대화에
    // 쌓이므로(=오염), 맥락만 공유하는 임시 질의로 처리하고 답변은 별도 카드로 보여 준다.
    // (사이드 질문은 텍스트 전용 — 첨부가 있으면 일반 메시지로 보낸다.)
    const sideQ = images.length ? null : matchSideQuestion(trimmed, supportsSideQuestion)
    if (sideQ) {
      const question = (sideQ[1] ?? '').trim()
      if (!question) return // 질문 없이 "/btw" 만 보낸 경우는 무시.
      setPickerCard(null)
      setWooiCard(null)
      void window.api.chat.sideQuestion(workspace.id, question)
      setText('')
      historyIdx.current = -1
      return
    }

    // 첨부에서 화면 전용 필드(id·previewUrl)를 떼고 전송용 payload 만 보낸다.
    const payload: ImageAttachment[] = images.map(({ name, mediaType, dataBase64 }) => ({
      name,
      mediaType,
      dataBase64
    }))
    deliver(trimmed, payload, opts?.stopFirst)
    setText('')
    setImages([])
    historyIdx.current = -1
  }

  /** `#` 로 적은 기억을 고른 CLAUDE.md 에 덧붙인다. */
  const saveMemory = (scope: MemoryScope): void => {
    const memo = memoryDraft
    setMemoryDraft(null)
    setMemoryOpenPick(false)
    taRef.current?.focus()
    if (!memo) return
    void window.api.workspace.addMemory(workspace.id, scope, memo).then((r) => {
      if (r.error) pushToast('error', r.error)
      else
        pushToast(
          'success',
          scope === 'user' ? 'Added to ~/.claude/CLAUDE.md' : 'Added to this project’s CLAUDE.md'
        )
    })
  }

  /** `/memory` 카드에서 고른 CLAUDE.md 를 열고 입력창으로 돌아온다. */
  const openMemory = (scope: MemoryScope): void => {
    setMemoryOpenPick(false)
    taRef.current?.focus()
    void window.api.workspace.openMemory(workspace.id, scope).then((r) => {
      if (r.error) pushToast('error', r.error)
    })
  }

  /**
   * `/wooi:*` 즉시 실행 명령을 돌리고 결과를 카드로 띄운다.
   *
   * 인자가 틀리면 실행하지 않고 입력창에 그대로 남긴다 — 사용법 토스트를 보고 이어서 고쳐 칠 수
   * 있어야 한다(`/add-dir` 과 같은 처리). 그 외에는 입력창을 비우고 카드만 뜬다.
   */
  const runWooiCommand = (spec: WooiCommandSpec, rest: string): void => {
    const parsed = parseWooiCommandArgs(spec.name, rest)
    if ('error' in parsed) {
      pushToast('info', parsed.error)
      taRef.current?.focus()
      return
    }

    setSideAnswer(null)
    setCommandCard(null)
    setPickerCard(null)
    setText('')
    const seq = ++cmdSeq.current
    const title = `/${wooiCommandName(spec)}`
    setWooiCard({ title, status: 'loading' })
    void window.api.commands.wooiRun(workspace.id, spec.name, rest).then(({ result, error }) => {
      if (cmdSeq.current !== seq) return
      setWooiCard((prev) => {
        if (!prev || prev.title !== title) return prev
        if (error) return { ...prev, status: 'error', error }
        return { ...prev, status: 'done', result }
      })
    })
  }

  /** 인터랙티브 명령을 실행하고 결과를 카드로 띄운다(사이드 답변 카드는 비켜 준다). */
  const runInteractive = (cmd: (typeof INTERACTIVE_COMMANDS)[number]): void => {
    setSideAnswer(null)
    setWooiCard(null)
    setPickerCard(null)
    const seq = ++cmdSeq.current
    setCommandCard({ kind: cmd.kind, title: `/${cmd.name}`, status: 'loading' })
    void window.api.commands.run(workspace.id, cmd.kind).then(({ result, error }) => {
      // 이 카드를 띄운 요청이 아직 최신일 때만 반영(워크스페이스/명령 전환 후 도착한 응답은 버린다).
      if (cmdSeq.current !== seq) return
      setCommandCard((prev) => {
        if (!prev || prev.kind !== cmd.kind) return prev
        if (error || !result)
          return { ...prev, status: 'error', error: error || 'No data returned.' }
        return { ...prev, status: 'done', result }
      })
    })
  }

  /**
   * Esc 의 의미를 터미널 Claude Code 와 맞춘다. 위에서부터 먼저 걸리는 하나만 실행한다:
   *
   *   1. 열린 카드 닫기(명령 결과·사이드 답변) — 입력창 포커스가 빠져 있어도 닫히도록 window 에서 받는다
   *   2. 진행 중인 턴 중단 — 터미널의 Esc 가 하는 일. 지금까지는 Stop 버튼을 눌러야만 했다
   *   3. Esc 두 번 연속 → 되감기 패널 — 어느 메시지 시점으로 코드를 되돌릴지 고른다
   *
   * 모달·confirm·승인 프롬프트·자동완성 메뉴가 떠 있으면 Esc 는 그쪽 것이므로 전부 양보한다.
   * 핸들러가 최신 상태를 봐야 하므로 매 렌더 ref 만 갈아 끼우고 리스너는 마운트 때 한 번만 건다.
   */
  const escHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {})
  escHandlerRef.current = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || e.metaKey || e.ctrlKey || e.altKey) return
    const st = useStore.getState()
    if (st.overlayOpen || st.confirmState || menuOpen || mentionOpen) return
    // 승인·질문·계획 프롬프트가 떠 있으면 Esc 는 그 프롬프트의 거부/취소다.
    if (st.permissions.some((p) => p.workspaceId === workspace.id)) return

    if (memoryDraft || memoryOpenPick) {
      e.preventDefault()
      setMemoryDraft(null)
      setMemoryOpenPick(false)
      taRef.current?.focus()
      return
    }

    if (commandCard || wooiCard || sideAnswer) {
      e.preventDefault()
      if (commandCard) setCommandCard(null)
      else if (wooiCard) setWooiCard(null)
      else setSideAnswer(null)
      taRef.current?.focus()
      return
    }

    if (running) {
      e.preventDefault()
      void window.api.chat.interrupt(workspace.id)
      lastEscAt.current = 0 // 중단은 Esc 한 번으로 끝난다 — 연타가 되감기로 이어지지 않게.
      return
    }

    if (!supportedCommands.includes('rewind')) return
    const now = Date.now()
    if (now - lastEscAt.current <= DOUBLE_ESC_MS) {
      e.preventDefault()
      lastEscAt.current = 0
      const rewind = INTERACTIVE_COMMANDS.find((c) => c.kind === 'rewind')
      if (rewind) runInteractive(rewind)
      return
    }
    lastEscAt.current = now
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => escHandlerRef.current(e)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /** /clear — 확인 후 대화 기록·세션을 초기화한다(백엔드 + 화면 모두). */
  const doClear = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Clear this conversation?',
      body: 'Clears the transcript and starts a fresh session with empty context. This cannot be undone.',
      confirmLabel: 'Clear',
      danger: true
    })
    if (!ok) return
    await window.api.chat.clear(workspace.id)
    resetTranscript(workspace.id)
    pushToast('success', 'Started a fresh session.')
  }

  /**
   * Wooi UI 에서 직접 처리하는 로컬 명령. 에이전트로 보내지 않고 앱 기능으로 매핑한다.
   * 입력창 텍스트 정리도 여기서 한다(대부분 비우고, /help 만 자동완성 메뉴를 다시 띄우도록
   * '/' 를 남긴다).
   */
  const runLocal = (kind: LocalCommand, raw: string): void => {
    setSideAnswer(null)
    setCommandCard(null)
    setWooiCard(null)
    setPickerCard(null)
    setMemoryDraft(null) // 로컬 명령이 이어받은 뒤에도 `#` 메모를 남기면 두 메모리 카드가 서로를 가린다.
    setMemoryOpenPick(false)

    if (kind === 'help') {
      setText('/') // 자동완성 메뉴로 사용 가능한 명령을 모두 보여 준다.
      taRef.current?.focus()
      return
    }

    if (kind === 'export') {
      const format = parseExportFormat(raw)
      if (format === 'invalid') {
        pushToast('info', 'Usage: /export [md|json]')
        taRef.current?.focus()
        return
      }
      setText('')
      window.dispatchEvent(
        new CustomEvent<ExportConversationDetail>('wooi:export-conversation', {
          detail: {
            workspaceId: workspace.id,
            ...(format === 'menu' ? {} : { format })
          }
        })
      )
      return
    }

    if (kind === 'login') {
      setText('')
      const loginBackend: AgentBackendId = workspace.agentBackend === 'codex' ? 'codex' : 'claude'
      window.dispatchEvent(
        new CustomEvent<AgentBackendId>('wooi:open-login', { detail: loginBackend })
      )
      return
    }

    if (kind === 'logout') {
      setText('')
      // 이 Enter keydown 안에서 곷바로 confirm을 마운트하면, 같은 Enter가 ConfirmDialog의
      // 전역 핸들러까지 이어져 위험 동작을 즉시 승인한다. 다음 이벤트 루프에서 열어 키를 분리한다.
      setTimeout(() => {
        void (async () => {
          const ok = await confirm({
            title: 'Sign out of Claude Code?',
            body: 'Signing out ends any running turns for Claude Code.',
            confirmLabel: 'Sign out',
            danger: true
          })
          if (!ok) return
          try {
            await window.api.auth.claudeLogout()
            await refreshAuth()
            pushToast('success', 'Signed out of Claude Code.')
            openSettings('integrations')
          } catch (error) {
            pushToast(
              'error',
              error instanceof Error ? error.message : 'Could not sign out of Claude Code.'
            )
          }
        })()
      }, 0)
      return
    }

    const externalUrl =
      kind in EXTERNAL_LOCAL_COMMANDS
        ? EXTERNAL_LOCAL_COMMANDS[kind as keyof typeof EXTERNAL_LOCAL_COMMANDS]
        : undefined
    if (externalUrl) {
      setText('')
      void window.api.openExternal(externalUrl)
      return
    }

    // /add-dir 은 인자가 본체다 — 인자가 없으면 지우지 말고 이어 쓸 수 있게 남긴다.
    if (kind === 'add-dir') {
      const dir = raw.slice('/add-dir'.length).trim()
      if (!dir) {
        pushToast('info', 'Usage: /add-dir <path> — adds a directory outside this worktree.')
        setText('/add-dir ')
        taRef.current?.focus()
        return
      }
      setText('')
      void window.api.workspace.addDir(workspace.id, dir).then((r) => {
        if (r.error) pushToast('error', r.error)
        else pushToast('success', `Added ${dir}. The agent can use it from your next message.`)
      })
      return
    }

    if (kind === 'copy') {
      const index = parseCopyIndex(raw)
      if (index === null) {
        pushToast('info', 'Usage: /copy [N] — copies the Nth-latest response (default 1).')
        taRef.current?.focus()
        return
      }
      const responses = items.filter(
        (i): i is Extract<ChatItem, { type: 'assistant' }> =>
          i.type === 'assistant' && !!i.text?.trim()
      )
      if (responses.length === 0) {
        pushToast('info', 'No assistant response to copy yet.')
        taRef.current?.focus()
        return
      }
      const response = responses.at(-index)
      if (!response) {
        pushToast(
          'info',
          `Only ${responses.length} assistant ${responses.length === 1 ? 'response' : 'responses'} so far.`
        )
        taRef.current?.focus()
        return
      }
      setText('')
      void navigator.clipboard.writeText(response.text).then(
        () =>
          pushToast(
            'success',
            index === 1
              ? 'Copied the last response to the clipboard.'
              : `Copied response #${index} (counting back) to the clipboard.`
          ),
        () => pushToast('error', 'Could not copy to the clipboard.')
      )
      return
    }

    if (kind === 'memory') {
      const scope = parseMemoryScope(raw)
      if (scope === null) {
        pushToast('info', 'Usage: /memory [project|user]')
        taRef.current?.focus()
        return
      }
      setText('')
      if (scope === 'ask') {
        setMemoryOpenPick(true)
      } else {
        openMemory(scope)
      }
      return
    }

    setText('')
    // /stop 은 Stop 버튼·Esc 와 같은 중단이다. 돌고 있지 않을 때 입력창만 비우면 명령이
    // 먹혔는지 알 수 없으므로, 그때는 아무것도 멈추지 않았다고 말해 준다.
    if (kind === 'stop') {
      if (running) void window.api.chat.interrupt(workspace.id)
      else pushToast('info', 'Nothing is running.')
      return
    }
    if (kind === 'tasks') {
      // 실행 중 진행률은 자주 바뀌므로 Composer 를 구독시키지 않고, 명령을 누른 순간의 상태만 읽는다.
      const state = useStore.getState()
      const agents = state.runningAgents[workspace.id] ?? []
      if (agents.length === 0) {
        pushToast('info', 'No background agents or tasks running.')
        return
      }
      if (!(state.app?.settings.showRunningAgents ?? true)) {
        pushToast(
          'info',
          `${agents.length} running — turn on “Running agents in sidebar” in Settings to see them.`
        )
        return
      }
      state.expandAgents(workspace.id)
      // 목록이 이미 펼쳐져 있으면 화면 변화가 없어 명령이 실패한 것처럼 보일 수 있다.
      pushToast(
        'info',
        `${agents.length} ${agents.length === 1 ? 'task' : 'tasks'} running — listed under this workspace in the sidebar.`
      )
      return
    }
    if (kind === 'diff') {
      // ChatView 가 가진 diff 모달을 연다(Composer 에서 직접 접근할 수 없어 이벤트로 신호한다).
      window.dispatchEvent(new CustomEvent('wooi:open-diff', { detail: workspace.id }))
      return
    }
    if (kind === 'clear') {
      void doClear()
    }
  }

  /** 선택한 슬래시 명령을 입력창에 채운다(인자를 이어 쓸 수 있도록 공백을 붙이고 포커스 유지). */
  const acceptCommand = (cmd: SlashCommandInfo): void => {
    setText(`/${cmd.name} `)
    historyIdx.current = -1
    taRef.current?.focus()
  }

  const userMessages = (): string[] =>
    items
      .filter((i): i is Extract<ChatItem, { type: 'user' }> => i.type === 'user')
      .map((i) => i.text)

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // ⌘⏎ = 진행 중인 턴을 멈추고 방금 쓴 메시지를 바로 보낸다. 턴이 길어질 때 방향을 트는
    // 조작이라 대기 큐(Enter)와 별도 키가 필요하다.
    if (e.metaKey && e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send({ stopFirst: true })
      return
    }

    // 나머지 ⌘ 조합은 입력창이 처리하지 않고 전역 단축키(App.tsx)로 흘려보낸다. 특히 ⌘↑/⌘↓ 는
    // 워크스페이스 전환이라, 입력창에 포커스가 있어도(=대부분의 시간) 아래의 ↑/↓ 메시지 히스토리나
    // 자동완성 메뉴 이동에 먹히면 안 된다.
    if (e.metaKey) return

    // 자동완성 메뉴(슬래시 명령 / @파일)가 열려 있으면 방향키·Enter·Tab 을 메뉴 조작에 먼저 쓴다.
    // ↑ 는 아래의 메시지 히스토리 순회와 겹치므로 메뉴가 우선권을 갖는다.
    if (menuOpen || mentionOpen) {
      const count = menuOpen ? matches.length : mentionHits.length
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (count) setMenuIdx((i) => (i + 1) % count)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (count) setMenuIdx((i) => (i - 1 + count) % count)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        // 슬래시는 명령 입력을 비워 닫고, 멘션은 입력을 남긴 채 메뉴만 닫는다
        // (자동완성을 물리고 경로를 직접 마저 치려는 경우가 많다).
        if (menuOpen) setText('')
        else if (mention) setMentionDismissedAt(mention.at)
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.nativeEvent.isComposing) {
        if (menuOpen) {
          const cmd = matches[menuIdx]
          if (cmd) {
            e.preventDefault()
            acceptCommand(cmd)
            return
          }
        } else {
          const hit = mentionHits[menuIdx]
          if (hit) {
            e.preventDefault()
            acceptMention(hit)
            return
          }
        }
      }
    }

    // 자동완성이 열리지 않은 빈 입력창에서만 제안을 받는다. Shift+Tab 권한 모드 순환은 건드리지 않는다.
    if (e.key === 'Tab' && !e.shiftKey && text === '' && promptSuggestion) {
      e.preventDefault()
      clearPromptSuggestion(workspace.id)
      setText(promptSuggestion)
      historyIdx.current = -1
      return
    }

    // 카드 Esc 닫기는 window 리스너(위 useEffect)가 포커스와 무관하게 처리한다.

    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
      return
    }
    // 입력창이 비었거나 history 탐색 중일 때 ↑/↓ 로 이전 사용자 메시지 순회.
    if (e.key === 'ArrowUp' && (text === '' || historyIdx.current >= 0)) {
      const msgs = userMessages()
      if (!msgs.length) return
      e.preventDefault()
      const next = historyIdx.current < 0 ? msgs.length - 1 : Math.max(0, historyIdx.current - 1)
      historyIdx.current = next
      setText(msgs[next])
    } else if (e.key === 'ArrowDown' && historyIdx.current >= 0) {
      const msgs = userMessages()
      e.preventDefault()
      const next = historyIdx.current + 1
      if (next >= msgs.length) {
        historyIdx.current = -1
        setText('')
      } else {
        historyIdx.current = next
        setText(msgs[next])
      }
    }
  }

  return (
    <div className="shrink-0 px-4 py-3 border-t border-[var(--border)]">
      <div className="max-w-3xl mx-auto relative">
        {menuOpen && (
          <SlashMenu
            matches={matches}
            loading={loadingCommands && matches.length === 0}
            selectedIdx={menuIdx}
            onHover={setMenuIdx}
            onPick={acceptCommand}
          />
        )}
        {mentionOpen && (
          <MentionMenu
            hits={mentionHits}
            loading={loadingMentions && mentionHits.length === 0}
            selectedIdx={menuIdx}
            onHover={setMenuIdx}
            onPick={acceptMention}
          />
        )}
        {memoryDraft && !menuOpen && !mentionOpen && !memoryOpenPick && (
          <MemoryCard
            title="Add to memory"
            text={memoryDraft}
            onPick={saveMemory}
            onClose={() => {
              setMemoryDraft(null)
              setMemoryOpenPick(false)
              taRef.current?.focus()
            }}
          />
        )}
        {memoryOpenPick && !menuOpen && !mentionOpen && !memoryDraft && (
          <MemoryCard
            title="Open memory"
            onPick={openMemory}
            onClose={() => {
              setMemoryOpenPick(false)
              taRef.current?.focus()
            }}
          />
        )}
        {commandCard &&
          !menuOpen &&
          !mentionOpen &&
          !pickerCard &&
          !memoryDraft &&
          !memoryOpenPick && (
            <CommandCard
              card={commandCard}
              workspace={workspace}
              workspaceId={workspace.id}
              onResult={(result) => setCommandCard((prev) => (prev ? { ...prev, result } : prev))}
              onClose={() => setCommandCard(null)}
            />
          )}
        {wooiCard &&
          !menuOpen &&
          !mentionOpen &&
          !commandCard &&
          !pickerCard &&
          !memoryDraft &&
          !memoryOpenPick && <WooiCommandCard card={wooiCard} onClose={() => setWooiCard(null)} />}
        {sideAnswer &&
          !menuOpen &&
          !mentionOpen &&
          !commandCard &&
          !wooiCard &&
          !pickerCard &&
          !memoryDraft &&
          !memoryOpenPick && (
            <SideAnswerCard answer={sideAnswer} onClose={() => setSideAnswer(null)} />
          )}
        {pickerCard && !menuOpen && !mentionOpen && !memoryDraft && !memoryOpenPick && (
          <PickerCard
            kind={pickerCard}
            workspace={workspace}
            running={running}
            onClose={() => {
              setPickerCard(null)
              taRef.current?.focus()
            }}
          />
        )}
        {/* 입력창 위 상태줄: 디렉토리 · (교체 가능하면 에이전트) · 모델 · effort · 컨텍스트 사용량. */}
        <StatusLine workspace={workspace} onPick={openPicker} />
        {queue.length > 0 && (
          <div className="mb-2 space-y-1">
            {queue.map((m, i) => (
              <div
                key={i}
                className="flex items-center gap-2 bg-[var(--warning-500)]/5 border border-[var(--warning-500)]/20 rounded-lg pl-2.5 pr-1.5 py-1.5"
              >
                <Clock size={12} className="text-[var(--warning-400)]/80 shrink-0" />
                <span className="flex-1 min-w-0 truncate text-sm text-neutral-300" title={m.text}>
                  {m.text || (m.images?.length ? `${m.images.length} image(s)` : '')}
                </span>
                {m.images && m.images.length > 0 && (
                  <span className="text-xs text-neutral-600 shrink-0">📎{m.images.length}</span>
                )}
                <span className="text-xs text-neutral-600 shrink-0">queued</span>
                <button
                  onClick={() => removeQueued(workspace.id, i)}
                  title="Cancel this queued message"
                  className="shrink-0 h-5 w-5 grid place-items-center rounded text-neutral-500 hover:bg-[var(--surface-2)] hover:text-neutral-200"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {/* 드롭은 window 리스너가 창 전체에서 받는다. 여기서는 어디에 담기는지 보이도록 테두리만 켠다. */}
        <div
          className={
            'bg-[var(--surface)] border rounded-xl px-3 py-2 transition-shadow focus-within:border-[var(--border-strong)] focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--focus-ring)_12%,transparent)] ' +
            (dragging
              ? 'border-[var(--info-500)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--info-500)_18%,transparent)]'
              : 'border-[var(--border)]')
          }
        >
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {images.map((img) => (
                <ImageChip key={img.id} img={img} onRemove={() => removeImage(img.id)} />
              ))}
            </div>
          )}
          <div className="flex items-end gap-2">
            <textarea
              ref={taRef}
              value={text}
              onChange={(e) => {
                // 첫 입력에서 저장된 값 자체를 버려, 다시 빈 입력으로 돌아와도 제안이 살아나지 않게 한다.
                if (promptSuggestion) clearPromptSuggestion(workspace.id)
                // 커서를 입력과 같은 렌더에서 갱신한다 — 한 프레임이라도 어긋나면
                // @멘션 감지가 이전 커서로 잘못된 질의를 만든다.
                setText(e.target.value)
                setCaret(e.target.selectionStart ?? e.target.value.length)
                historyIdx.current = -1
              }}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              rows={1}
              disabled={locked}
              placeholder={
                locked
                  ? 'Compacting the conversation…  (input resumes when it finishes)'
                  : running
                    ? 'Queue a follow-up…  (Enter to queue · ⌘Enter to stop the turn and send now)'
                    : text === '' && promptSuggestion
                      ? `⇥ ${promptSuggestion}`
                      : 'Message your agent…  (Enter to send · @ for files · / for commands · ! for terminal)'
              }
              className="flex-1 bg-transparent resize-none outline-none text-base leading-relaxed text-neutral-200 placeholder:text-neutral-600 py-1 disabled:cursor-not-allowed"
            />
            {running && (
              <button
                onClick={() => void window.api.chat.interrupt(workspace.id)}
                title="Stop the current turn (Esc)"
                className="h-8 w-8 grid place-items-center rounded-lg bg-[var(--danger-500)]/15 text-[var(--danger-400)] hover:bg-[var(--danger-500)]/25 active:scale-95"
              >
                <Square size={15} fill="currentColor" />
              </button>
            )}
            <button
              onClick={() => send()}
              disabled={locked || (!text.trim() && images.length === 0)}
              title={
                locked
                  ? 'Compacting the conversation…'
                  : bashMode
                    ? 'Run in terminal'
                    : running
                      ? 'Queue message — ⌘Enter stops the current turn and sends now'
                      : 'Send'
              }
              className={
                'h-8 w-8 grid place-items-center rounded-lg text-white shadow-sm active:scale-95 disabled:bg-[var(--border)] disabled:text-neutral-600 disabled:shadow-none disabled:cursor-not-allowed ' +
                (bashMode
                  ? 'bg-[var(--success-600)] hover:bg-[var(--success-500)]'
                  : 'bg-[var(--info-600)] hover:bg-[var(--info-500)]')
              }
            >
              {bashMode ? <TerminalIcon size={15} /> : <Send size={15} />}
            </button>
          </div>
        </div>
      </div>
      <div className="max-w-3xl mx-auto mt-1.5 px-1 text-xs flex items-center gap-3">
        <div className="min-w-0 flex-1">
          {bashMode ? (
            <span className="text-[var(--success-400)] inline-flex items-center gap-1">
              <TerminalIcon size={11} />
              Run command{' '}
              <span className="text-neutral-600">
                (Enter to run · output shows here in the chat)
              </span>
            </span>
          ) : (
            (() => {
              const footer = permissionModeFooter(backend, workspace.permissionMode)
              // 읽기 전용 계열(plan·readOnly)은 "멈춤" 계열 색, 나머지는 경고 색으로 구분한다.
              const readOnlyish =
                workspace.permissionMode === 'plan' || workspace.permissionMode === 'readOnly'
              const accent = readOnlyish
                ? 'text-[var(--readonly-400)]'
                : 'text-[var(--warning-400)]'
              return footer ? (
                <span className={accent}>
                  {footer.symbol} {footer.text}{' '}
                  <span className="text-neutral-600">(shift+tab to cycle)</span>
                </span>
              ) : (
                <span className="text-neutral-600">shift+tab to cycle permission modes</span>
              )
            })()
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * `@` 파일 멘션 자동완성 메뉴. 슬래시 메뉴와 같은 위치·조작(↑↓ · Enter/Tab · Esc)을 쓴다.
 *
 * 파일 크기를 같이 보여 주는 게 핵심이다 — CLI 는 큰 파일을 말없이 앞부분만 넣거나 통째로
 * 버리는데 대화창에는 아무 흔적이 남지 않는다. 고르기 전에 알려 주는 쪽이 낫다.
 */
function MentionMenu({
  hits,
  loading,
  selectedIdx,
  onHover,
  onPick
}: {
  hits: FileHit[]
  loading: boolean
  selectedIdx: number
  onHover: (i: number) => void
  onPick: (hit: FileHit) => void
}): React.JSX.Element {
  const activeRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  return (
    <div className="absolute bottom-full mb-2 left-0 right-0 max-h-72 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--bg-3)] shadow-2xl py-1 z-20">
      {loading ? (
        <div className="px-3 py-2 text-sm text-neutral-500">Searching files…</div>
      ) : (
        hits.map((hit, i) => {
          const active = i === selectedIdx
          const slash = hit.path.lastIndexOf('/')
          const dir = slash < 0 ? '' : hit.path.slice(0, slash + 1)
          const name = slash < 0 ? hit.path : hit.path.slice(slash + 1)
          const size = hit.size
          const dropped = size !== undefined && size >= MENTION_DROP_HINT_BYTES
          const truncated = size !== undefined && size >= MENTION_TRUNCATE_HINT_BYTES

          return (
            <button
              key={(hit.isDir ? 'd:' : 'f:') + hit.path}
              ref={(el) => {
                if (active) activeRef.current = el
              }}
              onMouseEnter={() => onHover(i)}
              onMouseDown={(e) => {
                // textarea 가 blur 되지 않도록 기본 동작을 막고 직접 처리.
                e.preventDefault()
                onPick(hit)
              }}
              className={
                'w-full flex items-baseline gap-2 px-3 py-1.5 text-left ' +
                (active ? 'bg-[var(--surface-3)]' : 'hover:bg-[var(--surface)]')
              }
            >
              {hit.isDir ? (
                <Folder size={12} className="text-[var(--brand-400)]/80 shrink-0 translate-y-0.5" />
              ) : (
                <FileText size={12} className="text-neutral-500 shrink-0 translate-y-0.5" />
              )}
              <span className="text-sm font-medium text-neutral-100 shrink-0">
                {name}
                {hit.isDir && '/'}
              </span>
              <span className="text-xs text-neutral-500 truncate flex-1" title={hit.path}>
                {dir}
              </span>
              {size !== undefined && (
                <span
                  title={
                    dropped
                      ? 'Large enough that Claude Code may not attach it at all — ask the agent to Read it, or mention a line range like #L1-200.'
                      : truncated
                        ? 'Claude Code may attach only the first ~2000 lines of this file.'
                        : undefined
                  }
                  className={
                    'text-xs shrink-0 tabular-nums ' +
                    (dropped
                      ? 'text-[var(--danger-400)]'
                      : truncated
                        ? 'text-[var(--warning-400)]'
                        : 'text-neutral-600')
                  }
                >
                  {dropped || truncated ? '⚠ ' : ''}
                  {formatBytes(size)}
                </span>
              )}
            </button>
          )
        })
      )}
    </div>
  )
}

/** 전송 대기 중인 붙여넣기 이미지 칩(썸네일 + 이름 + 제거). */
function ImageChip({
  img,
  onRemove
}: {
  img: PendingImage
  onRemove: () => void
}): React.JSX.Element {
  return (
    <div className="group/chip relative flex items-center gap-1.5 pl-1 pr-2 py-1 rounded-lg bg-[var(--surface-3)] border border-[var(--border)]">
      <img src={img.previewUrl} alt={img.name} className="h-7 w-7 rounded object-cover" />
      <ImageIcon size={11} className="text-neutral-500 shrink-0" />
      <span className="text-xs text-neutral-300 max-w-[140px] truncate">{img.name}</span>
      <button
        onClick={onRemove}
        title="Remove image"
        className="ml-0.5 shrink-0 h-4 w-4 grid place-items-center rounded text-neutral-500 hover:text-neutral-200 hover:bg-[var(--surface-4)]"
      >
        <X size={12} />
      </button>
    </div>
  )
}

/** 입력창 위에 뜨는 슬래시 명령 자동완성 목록(Claude Code 스타일). */
function SlashMenu({
  matches,
  loading,
  selectedIdx,
  onHover,
  onPick
}: {
  matches: SlashCommandInfo[]
  loading: boolean
  selectedIdx: number
  onHover: (idx: number) => void
  onPick: (cmd: SlashCommandInfo) => void
}): React.JSX.Element {
  const activeRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])
  return (
    <div className="absolute bottom-full mb-2 left-0 right-0 max-h-72 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--bg-3)] shadow-2xl py-1 z-20">
      {loading ? (
        <div className="px-3 py-2 text-sm text-neutral-500">Loading commands…</div>
      ) : (
        matches.map((cmd, i) => {
          const active = i === selectedIdx
          return (
            <button
              key={cmd.name}
              ref={(el) => {
                if (active) activeRef.current = el
              }}
              onMouseEnter={() => onHover(i)}
              onMouseDown={(e) => {
                // textarea 가 blur 되지 않도록 기본 동작을 막고 직접 처리.
                e.preventDefault()
                onPick(cmd)
              }}
              className={
                'w-full flex items-baseline gap-2 px-3 py-1.5 text-left ' +
                (active ? 'bg-[var(--surface-3)]' : 'hover:bg-[var(--surface)]')
              }
            >
              <TerminalIcon
                size={12}
                className="text-[var(--accent-400)] shrink-0 translate-y-0.5"
              />
              <span className="text-sm font-medium text-neutral-100 shrink-0">/{cmd.name}</span>
              {cmd.argumentHint && (
                <span className="text-xs text-neutral-500 shrink-0">{cmd.argumentHint}</span>
              )}
              {cmd.description && (
                <span className="text-xs text-neutral-500 truncate">{cmd.description}</span>
              )}
            </button>
          )
        })
      )}
    </div>
  )
}

/** /btw 사이드 답변의 임시 상태(트랜스크립트에 저장되지 않음). */
type SideAnswer = {
  id: string
  question: string
  text: string
  status: 'streaming' | 'done' | 'error'
  error?: string
}

/**
 * 입력창 위에 뜨는 /btw 사이드 답변 카드.
 * 메인 대화와 분리된 임시 표시 — 닫으면(Esc/✕) 사라지고 기록에 남지 않는다.
 */
/**
 * CLAUDE.md 의 프로젝트/사용자 스코프를 고르는 공용 카드. `#` 기억은 남길 내용을 함께 보여 주고,
 * `/memory` 는 열 파일만 고른다. 1/2 로 바로 고를 수 있고 Esc 로 취소한다.
 */
function MemoryCard({
  title,
  text,
  onPick,
  onClose
}: {
  title: string
  text?: string
  onPick: (scope: MemoryScope) => void
  onClose: () => void
}): React.JSX.Element {
  const choices: { scope: MemoryScope; label: string; hint: string }[] = [
    { scope: 'project', label: 'Project memory', hint: 'CLAUDE.md — shared with this repo' },
    { scope: 'user', label: 'User memory', hint: '~/.claude/CLAUDE.md — all your projects' }
  ]
  // 숫자 단축키는 카드 안에서만 받는다 — window 에서 가로채면 입력창에 "1" 을 칠 수 없다.
  const firstRef = useRef<HTMLButtonElement>(null)
  useEffect(() => firstRef.current?.focus(), [])

  return (
    <div
      onKeyDown={(e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return
        const idx = Number(e.key) - 1
        if (!choices[idx]) return
        e.preventDefault()
        onPick(choices[idx].scope)
      }}
      className="absolute bottom-full mb-2 left-0 right-0 rounded-xl border border-[var(--accent-500)]/30 bg-[var(--bg-3)] shadow-2xl z-20"
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)]">
        <BookMarked size={13} className="text-[var(--accent-400)] shrink-0" />
        <span className="text-xs font-medium text-[var(--accent-300)] shrink-0">{title}</span>
        <span className="ml-auto shrink-0 text-xs text-neutral-600 select-none">Esc to cancel</span>
        <button
          onClick={onClose}
          title="Cancel (Esc)"
          className="shrink-0 h-5 w-5 grid place-items-center rounded text-neutral-500 hover:text-neutral-200 hover:bg-[var(--surface-3)]"
        >
          <X size={13} />
        </button>
      </div>
      {text !== undefined && (
        <p className="px-3 pt-2 text-sm leading-relaxed text-neutral-200 whitespace-pre-wrap break-words">
          {text}
        </p>
      )}
      <div className="p-2 flex flex-col gap-1">
        {choices.map((c, i) => (
          <button
            key={c.scope}
            ref={i === 0 ? firstRef : undefined}
            onClick={() => onPick(c.scope)}
            className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-left hover:bg-[var(--surface-3)]"
          >
            <span className="shrink-0 h-4 w-4 grid place-items-center rounded border border-[var(--border)] text-[10px] text-neutral-500">
              {i + 1}
            </span>
            <span className="text-xs text-neutral-200">{c.label}</span>
            <span className="text-[11px] text-neutral-500 truncate">{c.hint}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function SideAnswerCard({
  answer,
  onClose
}: {
  answer: SideAnswer
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="absolute bottom-full mb-2 left-0 right-0 max-h-80 overflow-y-auto rounded-xl border border-[var(--accent-500)]/30 bg-[var(--bg-3)] shadow-2xl z-20">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)] sticky top-0 bg-[var(--bg-3)]">
        <MessageCircleQuestion size={13} className="text-[var(--accent-400)] shrink-0" />
        <span className="text-xs font-medium text-[var(--accent-300)] shrink-0">Side question</span>
        <span className="text-xs text-neutral-500 truncate">{answer.question}</span>
        <span className="ml-auto shrink-0 text-xs text-neutral-600 select-none">Esc to close</span>
        <button
          onClick={onClose}
          title="Dismiss (Esc)"
          className="shrink-0 h-5 w-5 grid place-items-center rounded text-neutral-500 hover:text-neutral-200 hover:bg-[var(--surface-3)]"
        >
          <X size={13} />
        </button>
      </div>
      <div className="px-3 py-2 text-sm leading-relaxed text-neutral-200 whitespace-pre-wrap">
        {answer.status === 'error' ? (
          <span className="text-[var(--danger-400)]">
            {answer.error || 'Side question failed.'}
          </span>
        ) : (
          <>
            {answer.text}
            {answer.status === 'streaming' && (
              <span className="text-neutral-500">{answer.text ? ' ▍' : 'Thinking…'}</span>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * `/wooi:*` 즉시 실행 결과 카드.
 *
 * 결과를 예쁘게 파싱하지 않고 JSON 을 그대로 보여 준다. 도구 12개는 저마다 다른 모양을
 * 돌려주는데 각각에 전용 렌더러를 붙이면 도구를 하나 늘릴 때마다 렌더러가 하나 늘어난다 —
 * 그건 정확히 [[agent/tools/catalog]] 가 피하려던 비용이다. 이 카드는 "방금 무슨 일이
 * 일어났는지" 를 확인하는 자리이고, 읽어서 판단할 일이 있으면 그건 에이전트에게 물을 일이다.
 */
function WooiCommandCard({
  card,
  onClose
}: {
  card: WooiCardState
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="absolute bottom-full mb-2 left-0 right-0 max-h-80 overflow-y-auto rounded-xl border border-[var(--accent-500)]/30 bg-[var(--bg-3)] shadow-2xl z-20">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)] sticky top-0 bg-[var(--bg-3)]">
        <Wrench size={13} className="text-[var(--accent-400)] shrink-0" />
        <span className="text-xs font-medium text-[var(--accent-300)] shrink-0">{card.title}</span>
        <span className="ml-auto shrink-0 text-xs text-neutral-600 select-none">Esc to close</span>
        <button
          onClick={onClose}
          title="Dismiss (Esc)"
          className="shrink-0 h-5 w-5 grid place-items-center rounded text-neutral-500 hover:text-neutral-200 hover:bg-[var(--surface-3)]"
        >
          <X size={13} />
        </button>
      </div>
      <div className="px-3 py-2 text-sm leading-relaxed text-neutral-200">
        {card.status === 'loading' && <span className="text-neutral-500">Running…</span>}
        {card.status === 'error' && (
          <span className="text-[var(--danger-400)] whitespace-pre-wrap">
            {card.error || 'The command failed.'}
          </span>
        )}
        {card.status === 'done' && (
          <pre className="whitespace-pre-wrap break-words font-mono text-xs text-neutral-300">
            {JSON.stringify(card.result ?? null, null, 2)}
          </pre>
        )}
      </div>
    </div>
  )
}

/**
 * "/model"·"/effort"·"/fast"·"/agent"·"/plan" 이면 그 종류를 돌려준다(뒤따르는 인자는 무시하고 선택 카드를 연다).
 *
 * `allow.fast` 는 이 워크스페이스의 백엔드가 fast mode 를 지원하는지다 — 지원하지 않으면(Codex)
 * 가로채지 않고 일반 텍스트로 흘려보낸다. 아무 일도 안 하는 카드를 띄우는 것보다 낫다.
 * `allow.agent` 도 같은 이유다 — 쓸 수 있는 에이전트가 하나뿐이면 고를 것이 없다.
 * `allow.plan` 은 권한 모드가 여럿이면서 백엔드 전용 `/plan` 카드가 없을 때만 참이다. Codex 는
 * 자체 카드로 app-server 의 plan mode 를 바꾸고, 범용 선택기는 그런 카드가 없는 Claude 를 맡는다.
 * 거짓인 명령은 에이전트에게 보내는 평범한 메시지로 둔다.
 * 턴이 도는 중인지는 여기서 보지 않는다:
 * /model 과 마찬가지로 카드는 열리고, 잠긴 이유를 카드가 설명한다.
 */
export function matchPicker(
  text: string,
  allow: { fast: boolean; agent: boolean; plan: boolean }
): PickerKind | null {
  const m = /^\/(model|effort|fast|agent|plan)(?:\s.*)?$/.exec(text)
  if (!m) return null
  const kind = m[1] as PickerKind
  if (kind === 'fast' && !allow.fast) return null
  if (kind === 'agent' && !allow.agent) return null
  if (kind === 'plan' && !allow.plan) return null
  return kind
}

/**
 * "/mcp" 처럼 인자 없는 인터랙티브 명령이면 해당 정의를 돌려준다(아니면 null).
 * 별칭도 함께 해석한다(예: /cost·/stats → /usage).
 *
 * `supported` 는 이 워크스페이스의 백엔드가 실제로 답할 수 있는 종류다 — 지원하지 않는 명령은
 * 인터랙티브로 가로채지 않고 일반 텍스트로 흘려보낸다(에러 토스트 대신 에이전트가 답하게).
 */
export function matchInteractive(
  text: string,
  supported: readonly CommandPanelKind[]
): (typeof INTERACTIVE_COMMANDS)[number] | null {
  const m = /^\/([\w-]+)\s*$/.exec(text)
  if (!m) return null
  const name = m[1]
  const found = INTERACTIVE_COMMANDS.find((c) => c.name === name || c.aliases?.includes(name))
  return found && supported.includes(found.kind) ? found : null
}

type CodexLocalCommand = 'logout' | 'plugins'

/** account/logout와 Settings → Plugins로 처리할 Codex 전용 로컬 명령만 찾는다. */
export function matchCodexLocal(text: string, backend: AgentBackendId): CodexLocalCommand | null {
  if (backend !== 'codex') return null
  const match = /^\/(logout|plugins)\s*$/.exec(text)
  return match ? (match[1] as CodexLocalCommand) : null
}

/** Wooi UI 가 직접 처리하는 로컬 명령(에이전트로 보내지 않음). */
type LocalCommand =
  | 'diff'
  | 'copy'
  | 'help'
  | 'clear'
  | 'stop'
  | 'memory'
  | 'add-dir'
  | 'tasks'
  | 'export'
  | 'login'
  | 'logout'
  | keyof typeof EXTERNAL_LOCAL_COMMANDS
// 사용자가 실행 중인 앱은 Wooi 이므로 Anthropic 채널이 아니라 Wooi 이슈 트래커와 문서로 보낸다.
const EXTERNAL_LOCAL_COMMANDS = {
  bug: WOOI_URLS.bugReport,
  feedback: WOOI_URLS.featureRequest,
  'release-notes': WOOI_URLS.releases,
  'privacy-settings': WOOI_URLS.privacyPolicy
} as const
const LOCAL_COMMANDS: readonly LocalCommand[] = [
  'diff',
  'copy',
  'help',
  'clear',
  'stop',
  'memory',
  'add-dir',
  'tasks',
  'export',
  'login',
  'logout',
  ...(Object.keys(EXTERNAL_LOCAL_COMMANDS) as (keyof typeof EXTERNAL_LOCAL_COMMANDS)[])
]
const LOCAL_ALIASES: Record<string, LocalCommand> = { bashes: 'tasks' }
/** Claude Code 고유 기능이거나 Codex가 send() 앞쪽에 별도 처리기를 둔 명령. */
const CLAUDE_ONLY_COMMANDS: readonly string[] = ['memory', 'add-dir', 'logout']

/**
 * "/diff" 처럼 로컬에서 처리하는 명령이면 그 종류를 돌려준다(뒤따르는 인자는 호출부가 읽는다).
 * `/memory`·`/add-dir`·`/logout` 은 Claude 전용 경로라 다른 백엔드의 입력을 가로채지 않는다.
 */
export function matchLocal(text: string, allowClaudeOnly: boolean): LocalCommand | null {
  const m = /^\/([\w-]+)(?:\s[\s\S]*)?$/.exec(text)
  if (!m) return null
  const kind = LOCAL_ALIASES[m[1]] ?? m[1]
  if (!(LOCAL_COMMANDS as readonly string[]).includes(kind)) return null
  return CLAUDE_ONLY_COMMANDS.includes(kind) && !allowClaudeOnly ? null : (kind as LocalCommand)
}

export type LifecycleCommand =
  { kind: 'rename'; name: string | null } | { kind: 'archive' } | { kind: 'delete' }

export function matchLifecycle(text: string): LifecycleCommand | null {
  const rename = /^\/rename(?:\s+(.+))?$/.exec(text)
  // 이름 없는 /rename 은 오류가 아니라 헤더 제목을 더블클릭할 때와 같은 인라인 편집 요청이다.
  if (rename) return { kind: 'rename', name: rename[1]?.trim() || null }
  if (/^\/archive\s*$/.test(text)) return { kind: 'archive' }
  if (/^\/delete(?:\s[\s\S]*)?$/.test(text)) return { kind: 'delete' }
  return null
}

/** `/copy` 인자를 1-based 인덱스로 읽는다. 인자가 없으면 1(가장 최근), 숫자가 아니면 null. */
export function parseCopyIndex(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '/copy') return 1
  const match = /^\/copy\s+(\d+)$/.exec(trimmed)
  if (!match) return null
  const index = Number(match[1])
  return Number.isSafeInteger(index) && index > 0 ? index : null
}

export type ExportFormatResult = 'menu' | 'md' | 'json' | 'invalid'

/** `/export` 인자를 메뉴 또는 직접 내보낼 형식으로 읽는다. CLI 명령처럼 대소문자를 구분한다. */
export function parseExportFormat(raw: string): ExportFormatResult {
  const trimmed = raw.trim()
  if (trimmed === '/export') return 'menu'
  if (trimmed === '/export md' || trimmed === '/export markdown') return 'md'
  if (trimmed === '/export json') return 'json'
  return 'invalid'
}

/** `/memory` 인자를 스코프로 읽는다. 인자가 없으면 'ask'(카드로 고르게), 알 수 없는 값이면 null. */
export function parseMemoryScope(raw: string): MemoryScope | 'ask' | null {
  const trimmed = raw.trim()
  if (trimmed === '/memory') return 'ask'
  const match = /^\/memory\s+(project|user)$/.exec(trimmed)
  return match ? (match[1] as MemoryScope) : null
}

/**
 * `#` 로 시작하는 **한 줄**이면 CLAUDE.md 에 남길 기억이다(터미널 Claude Code 의 `#`).
 * `##` 로 시작하는 마크다운 제목과 여러 줄 프롬프트는 평범한 메시지로 둔다. 특히 이슈에서
 * 만든 초안은 `#123 제목`으로 시작하므로, 줄 수를 보지 않으면 전송 대신 기억 카드가 뜬다.
 */
export function matchMemory(text: string): string | null {
  const m = /^#(?!#)\s*([^\r\n]+)$/.exec(text)
  return m ? m[1].trim() || null : null
}

/** Claude side-question capability 가 있는 워크스페이스에서만 `/btw` 를 로컬 처리한다. */
export function matchSideQuestion(text: string, supported: boolean): RegExpExecArray | null {
  return supported ? /^\/btw(?:\s+([\s\S]+))?$/.exec(text) : null
}

/**
 * `/wooi:*` 즉시 실행 결과 카드의 임시 상태(트랜스크립트에 저장되지 않음).
 *
 * CommandPanelKind 를 늘리지 않고 따로 두는 이유: 그쪽은 백엔드 제어 채널에 붙은 명령들이라
 * capability 게이트와 종류별 전용 렌더러를 달고 다닌다. Wooi 도구 결과는 도구가 돌려준 값
 * 그대로라 종류가 없다 — 같은 카드 하나로 12개를 다 보여 줄 수 있다.
 */
type WooiCardState = {
  /** `/wooi:children` 처럼 사용자가 친 그대로. 응답을 카드와 맞추는 열쇠로도 쓴다. */
  title: string
  status: 'loading' | 'done' | 'error'
  result?: unknown
  error?: string
}

/** 인터랙티브 명령 결과 카드의 임시 상태(트랜스크립트에 저장되지 않음). */
type CommandCardState = {
  kind: CommandPanelKind
  title: string
  status: 'loading' | 'done' | 'error'
  result?: CommandResult
  error?: string
}

const CARD_ICON: Record<CommandPanelKind, React.ReactNode> = {
  mcp: <Plug size={13} className="text-[var(--accent-400)] shrink-0" />,
  context: <Gauge size={13} className="text-[var(--accent-400)] shrink-0" />,
  usage: <Receipt size={13} className="text-[var(--accent-400)] shrink-0" />,
  agents: <Bot size={13} className="text-[var(--accent-400)] shrink-0" />,
  reloadPlugins: <RefreshCw size={13} className="text-[var(--accent-400)] shrink-0" />,
  reloadSkills: <RefreshCw size={13} className="text-[var(--accent-400)] shrink-0" />,
  rewind: <History size={13} className="text-[var(--accent-400)] shrink-0" />,
  permissions: <ShieldCheck size={13} className="text-[var(--accent-400)] shrink-0" />,
  debugConfig: <Wrench size={13} className="text-[var(--accent-400)] shrink-0" />,
  experimental: <Activity size={13} className="text-[var(--accent-400)] shrink-0" />,
  status: <Activity size={13} className="text-[var(--accent-400)] shrink-0" />,
  skills: <Sparkles size={13} className="text-[var(--accent-400)] shrink-0" />,
  hooks: <Webhook size={13} className="text-[var(--accent-400)] shrink-0" />,
  goal: <BookMarked size={13} className="text-[var(--accent-400)] shrink-0" />,
  plan: <Wrench size={13} className="text-[var(--accent-400)] shrink-0" />,
  init: <BookMarked size={13} className="text-[var(--accent-400)] shrink-0" />
}

/** 토큰 수를 1.2k 형태로 간결하게 표기. */
function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`
}

/** 장부 한 줄 — "$0.12 · 340k tokens". 위임·리뷰처럼 곁가지 항목을 한 줄로 접을 때 쓴다. */
function ledgerLine(t: UsageTotals): string {
  const tokens = t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheCreationTokens
  return `$${t.costUsd.toFixed(4)} · ${fmtTokens(tokens)} tokens`
}

/**
 * Wooi 가 직접 센 워크스페이스 장부. 계정 단위 /usage 아래에 붙는다.
 *
 * **캐시 읽기 대 쓰기 비율이 이 표시의 핵심이다.** 대화가 길어져도 프롬프트 캐시가 살아 있으면
 * 맥락은 싼 "읽기" 로 다시 들어온다. 그런데 세션이 다시 열리면 같은 맥락이 비싼 "쓰기" 로 처음
 * 부터 다시 들어온다 — 그게 세션 재시작이 비싼 이유의 실제 모습이라, 재시작 횟수를 바로 옆에 둔다.
 */
function WorkspaceLedger({ info }: { info: WorkspaceUsageInfo }): React.JSX.Element {
  const t = info.total
  const input = t.cacheReadTokens + t.cacheCreationTokens + t.inputTokens
  const hit = input > 0 ? Math.round((t.cacheReadTokens / input) * 100) : null
  const delegated = ledgerHasAny(info.delegated)
  const reviews = ledgerHasAny(info.reviews)
  return (
    <div className="space-y-1.5 pt-2 border-t border-[var(--border)]">
      <div className="text-xs text-neutral-500">
        This workspace <span className="text-neutral-600">· since the app started</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-neutral-500 w-24 shrink-0">Cache hit</span>
        <div className="flex-1 h-1.5 rounded-full bg-[var(--surface-3)] overflow-hidden">
          <div className="h-full bg-[var(--success-400)]" style={{ width: `${hit ?? 0}%` }} />
        </div>
        <span className="text-xs text-neutral-500 shrink-0">{hit == null ? '—' : `${hit}%`}</span>
      </div>
      <div
        className="text-xs text-neutral-600 pl-24"
        title="Cache read is the cheap path. Cache write is what a fresh session pays to put the conversation back."
      >
        read {fmtTokens(t.cacheReadTokens)} · write {fmtTokens(t.cacheCreationTokens)} · uncached{' '}
        {fmtTokens(t.inputTokens)}
      </div>
      <LedgerRow label="Output" value={fmtTokens(t.outputTokens)} />
      <LedgerRow
        label="Session restarts"
        value={String(info.sessionRestarts)}
        title="Each restart replays the whole conversation from disk, so its context comes back as cache writes rather than cache reads."
      />
      <LedgerRow label="Cost (est.)" value={`$${t.costUsd.toFixed(4)}`} />
      {delegated && <LedgerRow label="Delegated runs" value={ledgerLine(info.delegated)} />}
      {reviews && (
        <LedgerRow
          label="Code reviews"
          value={ledgerLine(info.reviews)}
          title="Reviews belong to a pull request rather than a workspace, so this is the app-wide total and is not included above."
        />
      )}
    </div>
  )
}

function ledgerHasAny(t: UsageTotals): boolean {
  return (
    t.costUsd > 0 || t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheCreationTokens > 0
  )
}

function LedgerRow({
  label,
  value,
  title
}: {
  label: string
  value: string
  title?: string
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between text-xs" title={title}>
      <span className="text-neutral-500">{label}</span>
      <span className="text-neutral-400">{value}</span>
    </div>
  )
}

const MCP_STATUS_COLOR: Record<string, string> = {
  connected: 'bg-[var(--success-400)]',
  failed: 'bg-[var(--danger-400)]',
  'needs-auth': 'bg-[var(--warning-400)]',
  pending: 'bg-neutral-400',
  disabled: 'bg-neutral-600'
}

const MCP_STATUS_LABEL: Record<McpServerInfo['status'], string> = {
  connected: 'connected',
  failed: 'failed',
  'needs-auth': 'needs auth',
  pending: 'connecting…',
  disabled: 'disabled'
}

/** 상세 보기에서 서버 상태별로 가능한 동작 순서(키보드 커서 인덱스의 기준). */
function mcpActionsFor(server: McpServerInfo): McpAction[] {
  return server.status === 'disabled' ? ['enable'] : ['reconnect', 'disable']
}

/** 동작 메뉴 항목의 아이콘·라벨. */
const MCP_ACTION_META: Record<McpAction, { icon: React.ReactNode; label: string }> = {
  reconnect: { icon: <RotateCw size={12} />, label: 'Reconnect' },
  enable: { icon: <Power size={12} />, label: 'Enable' },
  disable: { icon: <PowerOff size={12} />, label: 'Disable' }
}

/** 키보드로 가로채는 내비게이션 키(나머지 입력은 textarea 로 그대로 흘려보낸다). */
const MCP_NAV_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape']

/**
 * /mcp 패널. Claude Code CLI 의 /mcp 처럼 단순 목록이 아니라, 서버를 골라 들어가 재연결·
 * 활성/비활성을 할 수 있는 인터랙티브 뷰다. 동작은 main 의 살아 있는 세션 제어 채널에서
 * 일어나며(필요하면 세션을 warm up), 적용 후 갱신된 목록을 onResult 로 카드에 되돌린다.
 *
 * 카드는 입력창(textarea) 위에 떠 있고 포커스는 textarea 에 남으므로, 방향키/Enter 를
 * document 캡처 단계에서 가로채 처리한다 — 가로챈 키는 stopPropagation 으로 textarea(=히스토리
 * 탐색·전송)까지 가지 않게 막고, 그 외 키는 건드리지 않아 평소처럼 입력된다. 목록에서의 Esc 만은
 * 가로채지 않고 흘려보내 Composer 가 카드를 닫게 둔다.
 */
function McpPanel({
  servers,
  workspaceId,
  onResult
}: {
  servers: McpServerInfo[]
  workspaceId: string
  onResult: (result: CommandResult) => void
}): React.JSX.Element {
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState<McpAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [listCursor, setListCursor] = useState(0)
  const [actionCursor, setActionCursor] = useState(0)
  // 키보드 커서가 가리키는 항목(스크롤 추적용).
  const activeRef = useRef<HTMLElement | null>(null)

  const current = selected ? (servers.find((s) => s.name === selected) ?? null) : null

  const open = (name: string): void => {
    setSelected(name)
    setActionCursor(0)
    setError(null)
  }
  const back = (): void => {
    setSelected(null)
    setError(null)
  }
  const runAction = (action: McpAction, name: string): void => {
    setBusy(action)
    setError(null)
    void window.api.commands.mcpAction(workspaceId, name, action).then((res) => {
      setBusy(null)
      if (res.error || !res.servers) {
        setError(res.error || 'Action failed.')
        return
      }
      onResult({ kind: 'mcp', servers: res.servers })
    })
  }

  // 최신 상태를 보는 키 핸들러를 매 렌더 갱신하고, 리스너는 한 번만 바인딩한다(stale closure 방지).
  const handlerRef = useRef<(e: KeyboardEvent) => void>(() => {})
  handlerRef.current = (e: KeyboardEvent): void => {
    // ⌘ 조합은 가로채지 않는다 — ⌘↑/⌘↓(워크스페이스 전환) 같은 전역 단축키가 카드 때문에 죽으면 안 된다.
    if (e.metaKey) return
    if (!servers.length || !MCP_NAV_KEYS.includes(e.key)) return
    const stop = (): void => {
      e.preventDefault()
      e.stopPropagation()
    }

    // 상세 보기: ↑/↓ 로 동작(+뒤로) 이동, Enter 실행, Esc/← 로 뒤로.
    if (current) {
      if (e.key === 'Escape' || e.key === 'ArrowLeft') {
        stop()
        back()
        return
      }
      stop() // 그 외 내비 키는 진행 중이어도 textarea 로 새지 않게 가둔다.
      if (busy) return
      const acts = mcpActionsFor(current)
      const count = acts.length + 1 // +뒤로
      if (e.key === 'ArrowDown') setActionCursor((c) => (c + 1) % count)
      else if (e.key === 'ArrowUp') setActionCursor((c) => (c - 1 + count) % count)
      else if (e.key === 'Enter') {
        if (actionCursor >= acts.length) back()
        else runAction(acts[actionCursor], current.name)
      }
      return
    }

    // 목록 보기: Esc 는 카드 닫기(Composer)에 맡기고, 나머지는 가로채 이동/진입한다.
    if (e.key === 'Escape') return
    stop()
    if (e.key === 'ArrowDown') setListCursor((c) => (c + 1) % servers.length)
    else if (e.key === 'ArrowUp') setListCursor((c) => (c - 1 + servers.length) % servers.length)
    else if (e.key === 'Enter' || e.key === 'ArrowRight') {
      const s = servers[Math.min(listCursor, servers.length - 1)]
      if (s) open(s.name)
    }
  }

  useEffect(() => {
    const listener = (e: KeyboardEvent): void => handlerRef.current(e)
    document.addEventListener('keydown', listener, true)
    return () => document.removeEventListener('keydown', listener, true)
  }, [])

  // 커서가 가리키는 항목을 화면 안으로 스크롤.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [listCursor, actionCursor, selected])

  if (servers.length === 0) return <Empty>No MCP servers configured.</Empty>

  if (current) {
    return (
      <McpServerDetail
        server={current}
        busy={busy}
        error={error}
        cursor={actionCursor}
        activeRef={activeRef}
        onHover={setActionCursor}
        onActivate={(i) => {
          const acts = mcpActionsFor(current)
          if (i >= acts.length) back()
          else runAction(acts[i], current.name)
        }}
      />
    )
  }

  const cursor = Math.min(listCursor, servers.length - 1)
  return (
    <div className="space-y-1.5">
      <ul className="space-y-0.5">
        {servers.map((s, i) => {
          const active = i === cursor
          return (
            <li key={s.name}>
              <button
                ref={(el) => {
                  if (active) activeRef.current = el
                }}
                onMouseEnter={() => setListCursor(i)}
                onClick={() => open(s.name)}
                className={`w-full flex items-center gap-2 text-left rounded-md px-1.5 py-1 transition-colors ${active ? 'bg-[var(--surface-3)]' : 'hover:bg-[var(--surface-3)]'}`}
              >
                <span
                  className={`h-2 w-2 rounded-full shrink-0 ${MCP_STATUS_COLOR[s.status] ?? 'bg-neutral-500'}`}
                  title={MCP_STATUS_LABEL[s.status]}
                />
                <span className="font-medium text-neutral-100 truncate">{s.name}</span>
                <span className="text-xs text-neutral-500 shrink-0">
                  {MCP_STATUS_LABEL[s.status]}
                </span>
                {s.scope && <span className="text-xs text-neutral-600 shrink-0">· {s.scope}</span>}
                {typeof s.toolCount === 'number' && (
                  <span className="text-xs text-neutral-500 ml-auto shrink-0">
                    {s.toolCount} {s.toolCount === 1 ? 'tool' : 'tools'}
                  </span>
                )}
                <ChevronRight
                  size={13}
                  className={`text-neutral-600 shrink-0 ${typeof s.toolCount === 'number' ? '' : 'ml-auto'}`}
                />
              </button>
            </li>
          )
        })}
      </ul>
      <McpHint text="↑↓ navigate · ↵ open · esc close" />
    </div>
  )
}

/** /mcp 서버 1개의 상세 + 동작(재연결·활성/비활성) 메뉴 뷰. */
function McpServerDetail({
  server,
  busy,
  error,
  cursor,
  activeRef,
  onHover,
  onActivate
}: {
  server: McpServerInfo
  busy: McpAction | null
  error: string | null
  /** 키보드 커서 인덱스(0..actions.length, 마지막은 '뒤로'). */
  cursor: number
  activeRef: React.MutableRefObject<HTMLElement | null>
  onHover: (index: number) => void
  onActivate: (index: number) => void
}): React.JSX.Element {
  const actions = mcpActionsFor(server)
  const items = actions.length // '뒤로' 항목 인덱스

  return (
    <div className="space-y-2.5">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full shrink-0 ${MCP_STATUS_COLOR[server.status] ?? 'bg-neutral-500'}`}
          />
          <span className="font-medium text-neutral-100 truncate">{server.name}</span>
          <span className="text-xs text-neutral-500 shrink-0">
            {MCP_STATUS_LABEL[server.status]}
          </span>
          {server.version && (
            <span className="text-xs text-neutral-600 shrink-0">v{server.version}</span>
          )}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-neutral-500">
          {server.scope && <span>scope: {server.scope}</span>}
          {server.transport && <span>transport: {server.transport}</span>}
          {typeof server.toolCount === 'number' && (
            <span>
              {server.toolCount} {server.toolCount === 1 ? 'tool' : 'tools'}
            </span>
          )}
        </div>
        {server.endpoint && (
          <div className="text-xs text-neutral-600 break-all" title={server.endpoint}>
            {server.endpoint}
          </div>
        )}
      </div>

      {server.error && (
        <div className="text-xs text-[var(--danger-400)] break-words rounded-md bg-[var(--danger-500)]/10 px-2 py-1.5">
          {server.error}
        </div>
      )}

      {server.status === 'needs-auth' && (
        <div className="text-xs text-[var(--warning-400)]">
          Authentication required — reconnect to start the auth flow.
        </div>
      )}

      {/* 동작 메뉴: CLI /mcp 와 동일하게 재연결 + 활성/비활성 + 뒤로. 키보드/마우스 모두 가능. */}
      <div className="space-y-0.5">
        {actions.map((action, i) => {
          const active = i === cursor
          const loading = busy === action
          return (
            <button
              key={action}
              ref={(el) => {
                if (active) activeRef.current = el
              }}
              onMouseEnter={() => onHover(i)}
              onClick={() => onActivate(i)}
              disabled={busy !== null}
              className={`w-full flex items-center gap-1.5 text-left rounded-md px-2 py-1 text-xs transition-colors disabled:opacity-50 disabled:cursor-default ${active ? 'bg-[var(--surface-3)] text-neutral-100' : 'text-neutral-300 hover:bg-[var(--surface-3)]'}`}
            >
              {loading ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                MCP_ACTION_META[action].icon
              )}
              {MCP_ACTION_META[action].label}
            </button>
          )
        })}
        <button
          ref={(el) => {
            if (cursor === items) activeRef.current = el
          }}
          onMouseEnter={() => onHover(items)}
          onClick={() => onActivate(items)}
          className={`w-full flex items-center gap-1.5 text-left rounded-md px-2 py-1 text-xs transition-colors ${cursor === items ? 'bg-[var(--surface-3)] text-neutral-100' : 'text-neutral-400 hover:bg-[var(--surface-3)]'}`}
        >
          <ArrowLeft size={12} /> Back to all servers
        </button>
      </div>

      {error && <div className="text-xs text-[var(--danger-400)]">{error}</div>}

      {server.tools && server.tools.length > 0 && (
        <div className="space-y-1 pt-1 border-t border-[var(--border)]">
          <div className="text-xs text-neutral-500 pt-1.5">Tools</div>
          <ul className="space-y-0.5">
            {server.tools.map((t) => (
              <li key={t.name} className="text-xs">
                <span className="text-neutral-200">{t.name}</span>
                {t.description && (
                  <span className="text-neutral-600 truncate"> — {t.description}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <McpHint text="↑↓ navigate · ↵ select · esc/← back" />
    </div>
  )
}

/** /mcp 패널 하단의 키보드 조작 힌트. */
function McpHint({ text }: { text: string }): React.JSX.Element {
  return <div className="text-xs text-neutral-600 pt-0.5">{text}</div>
}

/**
 * 입력창 위에 뜨는 인터랙티브 명령 결과 카드(/mcp·/context 등).
 * /btw 카드와 같은 임시 표시 — 닫으면(Esc/✕) 사라지고 기록에 남지 않는다.
 */
function CommandCard({
  card,
  workspace,
  workspaceId,
  onResult,
  onClose
}: {
  card: CommandCardState
  workspace: Workspace
  workspaceId: string
  /** mcp 패널의 서버 동작 후 갱신된 결과를 카드에 반영하기 위한 콜백. */
  onResult: (result: CommandResult) => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="absolute bottom-full mb-2 left-0 right-0 max-h-96 overflow-y-auto rounded-xl border border-[var(--accent-500)]/30 bg-[var(--bg-3)] shadow-2xl z-20">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)] sticky top-0 bg-[var(--bg-3)]">
        {CARD_ICON[card.kind]}
        <span className="text-sm font-medium text-[var(--accent-300)] shrink-0">{card.title}</span>
        {card.status === 'loading' && (
          <Loader2 size={12} className="text-neutral-500 animate-spin" />
        )}
        <span className="ml-auto shrink-0 text-xs text-neutral-600 select-none">Esc to close</span>
        <button
          onClick={onClose}
          title="Dismiss (Esc)"
          className="shrink-0 h-5 w-5 grid place-items-center rounded text-neutral-500 hover:text-neutral-200 hover:bg-[var(--surface-3)]"
        >
          <X size={13} />
        </button>
      </div>
      <div className="px-3 py-2.5 text-sm leading-relaxed text-neutral-200">
        {card.status === 'loading' ? (
          <span className="text-neutral-500">Loading…</span>
        ) : card.status === 'error' ? (
          <span className="text-[var(--danger-400)]">{card.error || 'Command failed.'}</span>
        ) : (
          card.result && (
            <CommandResultView
              result={card.result}
              workspace={workspace}
              workspaceId={workspaceId}
              onResult={onResult}
            />
          )
        )}
      </div>
    </div>
  )
}

/** CommandResult 종류별 본문 렌더링. */
function CommandResultView({
  result,
  workspace,
  workspaceId,
  onResult
}: {
  result: CommandResult
  workspace: Workspace
  workspaceId: string
  onResult: (result: CommandResult) => void
}): React.JSX.Element {
  switch (result.kind) {
    case 'mcp':
      return <McpPanel servers={result.servers} workspaceId={workspaceId} onResult={onResult} />

    case 'agents':
      return result.agents.length === 0 ? (
        <Empty>No subagents available.</Empty>
      ) : (
        <ul className="space-y-1.5">
          {result.agents.map((a) => (
            <li key={a.name}>
              <div className="flex items-baseline gap-2">
                <span className="font-medium text-neutral-100">{a.name}</span>
                {a.model && <span className="text-xs text-neutral-500">{a.model}</span>}
              </div>
              <div className="text-xs text-neutral-500 leading-snug">{a.description}</div>
            </li>
          ))}
        </ul>
      )

    case 'context': {
      const c = result.context
      return (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="flex-1 h-2 rounded-full bg-[var(--surface-3)] overflow-hidden">
              <div
                className="h-full bg-[var(--accent-400)]"
                style={{ width: `${Math.min(100, Math.round(c.percentage))}%` }}
              />
            </div>
            <span className="text-xs text-neutral-400 shrink-0">
              {fmtTokens(c.totalTokens)} / {fmtTokens(c.maxTokens)} ({Math.round(c.percentage)}%)
            </span>
          </div>
          <div className="text-xs text-neutral-600">{c.model}</div>
          <ul className="space-y-1">
            {c.categories.slice(0, 8).map((cat) => (
              <li key={cat.name} className="flex items-center justify-between gap-2">
                <span className="text-neutral-300 truncate">{cat.name}</span>
                <span className="text-xs text-neutral-500 shrink-0">{fmtTokens(cat.tokens)}</span>
              </li>
            ))}
          </ul>
        </div>
      )
    }

    case 'usage': {
      const u = result.usage
      // 라이브 세션이 없으면 세션 값은 전부 0 이다 — 0 을 그대로 그리면 "안 썼다" 로 읽히므로
      // 그 자리에 사정을 적는다. 계정 단위 값(플랜·레이트리밋)은 단명 쿼리에서도 정확하니 남긴다.
      const noSession = u.sessionDataAvailable === false
      return (
        <div className="space-y-2">
          {noSession ? (
            <div className="text-xs text-neutral-500">
              No live session — session cost and lines changed are unavailable. Send a message to
              start one. Plan usage below is account-wide and up to date.
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <span className="text-neutral-400">Session cost</span>
                <span className="font-medium text-neutral-100">${u.totalCostUsd.toFixed(4)}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-neutral-500">Lines changed</span>
                <span className="text-neutral-400">
                  <span className="text-[var(--success-400)]">+{u.linesAdded}</span>{' '}
                  <span className="text-[var(--danger-400)]">−{u.linesRemoved}</span>
                </span>
              </div>
            </>
          )}
          {u.subscriptionType && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-neutral-500">Plan</span>
              <span className="text-neutral-400 capitalize">{u.subscriptionType}</span>
            </div>
          )}
          {u.rateLimitsAvailable && u.rateLimits.length > 0 && (
            <div className="space-y-1 pt-1 border-t border-[var(--border)]">
              {u.rateLimits.map((r) => (
                <div key={r.label} className="flex items-center gap-2">
                  <span className="text-xs text-neutral-500 w-24 shrink-0">{r.label}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-[var(--surface-3)] overflow-hidden">
                    <div
                      className="h-full bg-[var(--accent-400)]"
                      style={{ width: `${Math.min(100, Math.round(r.utilization ?? 0))}%` }}
                    />
                  </div>
                  <span className="text-xs text-neutral-500 shrink-0">
                    {r.utilization == null ? '—' : `${Math.round(r.utilization)}%`}
                  </span>
                </div>
              ))}
            </div>
          )}
          {!u.rateLimitsAvailable && (
            <div className="text-xs text-neutral-600 pt-1">
              Plan rate limits not available for this session.
            </div>
          )}
          {u.workspace && <WorkspaceLedger info={u.workspace} />}
        </div>
      )
    }

    case 'reloadPlugins': {
      const r = result.reload
      const parts = [
        `${r.pluginCount ?? 0} plugins`,
        `${r.commandCount ?? 0} commands`,
        `${r.agentCount ?? 0} agents`,
        `${r.mcpServerCount ?? 0} MCP servers`
      ]
      return (
        <div className="space-y-1">
          <div className="text-[var(--success-400)]">Reloaded {parts.join(' · ')}.</div>
          {!!r.errorCount && (
            <div className="text-[var(--warning-500)]">{r.errorCount} error(s) during reload.</div>
          )}
        </div>
      )
    }

    case 'reloadSkills':
      return (
        <div className="text-[var(--success-400)]">
          Reloaded {result.reload.skillCount ?? 0} skills.
        </div>
      )

    case 'rewind':
      return <RewindPanel checkpoints={result.checkpoints} workspaceId={workspaceId} />

    case 'permissions':
      return <PermissionsPanel info={result.permissions} />

    case 'debugConfig':
      return (
        <div className="space-y-2">
          {result.sources.length > 0 && (
            <ul className="space-y-0.5 text-xs text-neutral-500">
              {result.sources.map((source) => (
                <li key={source} className="break-all">
                  {source}
                </li>
              ))}
            </ul>
          )}
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--surface-2)] p-2 text-xs text-neutral-300">
            {JSON.stringify(result.config, null, 2)}
          </pre>
        </div>
      )

    case 'unsupported':
      return <div className="text-[var(--warning-500)]">{result.reason}</div>

    case 'status':
      return <StatusPanel info={result.status} workspace={workspace} />

    case 'skills':
      return <SkillsPanel skills={result.skills} />

    case 'hooks':
      return <HooksPanel info={result.hooks} />

    case 'goal': {
      const goal = result.goal
      if (!goal) return <Empty>No goal set for this thread.</Empty>
      return (
        <div className="space-y-1 text-xs">
          <div className="text-sm text-neutral-100">{goal.objective}</div>
          <StatusRow label="Status" value={goal.status} />
          <StatusRow
            label="Tokens"
            value={`${goal.tokensUsed.toLocaleString()}${goal.tokenBudget == null ? '' : ` / ${goal.tokenBudget.toLocaleString()}`}`}
          />
          <StatusRow label="Elapsed" value={`${goal.timeUsedSeconds}s`} />
        </div>
      )
    }

    case 'plan':
      return <div className="text-[var(--success-400)]">Plan mode is now active.</div>

    case 'init':
      return (
        <div className={result.created ? 'text-[var(--success-400)]' : 'text-neutral-400'}>
          {result.created
            ? `Created ${result.path}.`
            : `Kept the existing ${result.path}; no changes were made.`}
        </div>
      )
  }
}

/** 상태 카드에서 반복되는 label/value 한 줄. */
function StatusRow({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3 text-xs">
      <span className="text-neutral-500 shrink-0">{label}</span>
      <span className="text-neutral-300 text-right break-all">{value}</span>
    </div>
  )
}

/** /status — 계정·세션·Wooi 워크스페이스 설정을 한 장에서 구분해 보여 준다. */
function StatusPanel({
  info,
  workspace
}: {
  info: StatusInfo
  workspace: Workspace
}): React.JSX.Element {
  const backend = useWorkspaceBackend(workspace)
  const agentLabel = backend?.label ?? AGENT_BACKEND_LABELS[workspace.agentBackend]
  const Section = ({
    title,
    children
  }: {
    title: string
    children: React.ReactNode
  }): React.JSX.Element => (
    <div className="space-y-1">
      <div className="text-xs font-medium text-neutral-400">{title}</div>
      {children}
    </div>
  )
  return (
    <div className="space-y-2.5">
      <Section title="Account">
        <StatusRow label="Email" value={info.account.email ?? '—'} />
        <StatusRow label="Organization" value={info.account.organization ?? '—'} />
        <StatusRow label="Plan" value={info.account.subscriptionType ?? '—'} />
        <StatusRow label="Provider" value={info.account.apiProvider ?? '—'} />
      </Section>
      <Section title="Session">
        <StatusRow label="State" value={info.live ? 'Live session' : 'No live session'} />
        {info.sessionId && <StatusRow label="Session ID" value={info.sessionId} />}
        <StatusRow label="Output style" value={info.outputStyle ?? '—'} />
        {info.fastMode ? (
          <StatusRow
            label="Fast mode"
            value={`${info.fastMode.state}${info.fastMode.disabledReason ? ` — ${info.fastMode.disabledReason}` : ''}`}
          />
        ) : (
          <div className="text-xs text-neutral-600">
            No live session — start one to see fast mode state.
          </div>
        )}
        <StatusRow
          label="Context"
          value={
            info.context
              ? `${fmtTokens(info.context.usedTokens)} / ${fmtTokens(info.context.maxTokens)} (${Math.round(info.context.percentage * 100)}%)`
              : 'No usage yet'
          }
        />
        {info.usage && (
          <StatusRow
            label="Plan usage"
            value={
              info.usage.available
                ? info.usage.windows
                    .map((window) =>
                      window.utilization == null
                        ? `${window.label}: —`
                        : `${window.label}: ${Math.round(window.utilization)}%`
                    )
                    .join(' · ') || 'No limits reported'
                : 'Not available'
            }
          />
        )}
      </Section>
      <Section title="Workspace">
        <StatusRow label="Model" value={info.workspace.model ?? 'Default'} />
        <StatusRow label="Effort" value={info.workspace.effort ?? 'Default'} />
        <StatusRow label="Fast mode preference" value={info.workspace.fastMode ? 'On' : 'Off'} />
        <StatusRow label="Permission mode" value={info.workspace.permissionMode} />
        <StatusRow label="Branch" value={workspace.branch} />
        <StatusRow label="Agent" value={agentLabel} />
        <StatusRow label="Working directory" value={info.workspace.cwd} />
      </Section>
    </div>
  )
}

/** /skills — 출처 배지와 함께 긴 설명은 두 줄까지만 보여 준다. */
function SkillsPanel({ skills }: { skills: SkillInfo[] }): React.JSX.Element {
  if (skills.length === 0) return <Empty>No skills available in this session.</Empty>
  const badge: Record<SkillInfo['source'], string> = {
    plugin: 'Plugin',
    user: 'User',
    builtin: 'Built-in'
  }
  return (
    <ul className="space-y-2">
      {skills.map((skill) => (
        <li key={skill.name} className="min-w-0">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="font-medium text-neutral-100 truncate">/{skill.name}</span>
            {skill.argumentHint && (
              <span className="text-xs font-mono text-neutral-500 shrink-0">
                {skill.argumentHint}
              </span>
            )}
            <span className="text-[10px] text-neutral-500 bg-[var(--surface-3)] rounded px-1 shrink-0">
              {badge[skill.source]}
            </span>
          </div>
          <div className="text-xs text-neutral-500 leading-snug line-clamp-2">
            {skill.description}
          </div>
        </li>
      ))}
    </ul>
  )
}

/** /hooks — 설정 파일에서 선언된 훅을 이벤트별로 읽기 전용 표시한다. */
function HooksPanel({ info }: { info: HooksInfo }): React.JSX.Element {
  if (info.events.length === 0) {
    return (
      <Empty>
        No hooks configured. Hooks run shell commands on session events — configure them in
        <span className="font-mono"> .claude/settings.json</span>.
      </Empty>
    )
  }
  return (
    <div className="space-y-2.5">
      {info.events.map(({ event, entries }) => (
        <div key={event} className="space-y-1">
          <div className="text-xs font-medium text-neutral-400">{event}</div>
          {entries.map((entry, index) => (
            <div key={`${entry.source}:${index}`} className="pl-2 border-l border-[var(--border)]">
              <div className="text-xs text-neutral-600">
                {entry.matcher ? `Matcher: ${entry.matcher}` : 'All matches'}
              </div>
              {entry.commands.length > 0 ? (
                entry.commands.map((command) => (
                  <div key={command} className="text-xs font-mono text-neutral-300 break-all">
                    {command}
                  </div>
                ))
              ) : (
                <div className="text-xs text-neutral-600">No command hooks</div>
              )}
            </div>
          ))}
        </div>
      ))}
      <div className="text-xs text-neutral-600 pt-1 border-t border-[var(--border)] break-all">
        From: {info.sources.join(' · ')}
      </div>
    </div>
  )
}

/** 권한 모드별 한 줄 설명(상태줄·footer 와 같은 의미). */
const PERMISSION_MODE_LABEL: Record<string, string> = {
  default: 'Default — ask before edits and commands',
  acceptEdits: 'Accept edits — auto-approve file edits',
  plan: 'Plan — read-only, proposes a plan first',
  auto: 'Auto — run without asking (use with care)'
}

/**
 * /permissions — 현재 권한 모드와 설정 파일에서 모은 allow/ask/deny 규칙을 읽기 전용으로 보여 준다.
 * 모드 변경은 Claude Code 처럼 Shift+Tab 으로 순환한다(이 카드는 현황 표시 전용).
 */
function PermissionsPanel({ info }: { info: PermissionsInfo }): React.JSX.Element {
  const Section = ({
    title,
    rules,
    tone
  }: {
    title: string
    rules: string[]
    tone: string
  }): React.JSX.Element => (
    <div className="space-y-1">
      <div className="text-xs text-neutral-500">
        {title} <span className="text-neutral-600">({rules.length})</span>
      </div>
      {rules.length === 0 ? (
        <div className="text-xs text-neutral-600">—</div>
      ) : (
        <ul className="space-y-0.5">
          {rules.map((r) => (
            <li key={r} className={`text-xs font-mono ${tone}`}>
              {r}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
  return (
    <div className="space-y-2.5">
      <div className="space-y-0.5">
        <div className="text-neutral-200">{PERMISSION_MODE_LABEL[info.mode] ?? info.mode}</div>
        <div className="text-xs text-neutral-600">shift+tab to cycle the permission mode</div>
      </div>
      <div className="space-y-2 pt-1 border-t border-[var(--border)]">
        <Section title="Allow" rules={info.allow} tone="text-[var(--success-400)]" />
        <Section title="Ask" rules={info.ask} tone="text-[var(--warning-400)]" />
        <Section title="Deny" rules={info.deny} tone="text-[var(--danger-400)]" />
      </div>
      <div className="text-xs text-neutral-600 pt-1 border-t border-[var(--border)] space-y-0.5">
        {info.sources.length > 0 ? (
          <div className="break-all">From: {info.sources.join(' · ')}</div>
        ) : (
          <div>No permission rules found in settings files.</div>
        )}
        <div>Rules loaded by plugins or applied per session are not listed here.</div>
      </div>
    </div>
  )
}

/**
 * /rewind — 파일 체크포인트(보낸 메시지 지점) 목록. 하나를 고르면 그 시점으로 추적된 파일을 되돌린다.
 * 체크포인트 백업은 살아 있는 세션 안에 있으므로, 같은 세션이 떠 있을 때만 동작한다 —
 * 비어 있거나 되돌릴 수 없으면 그 사정을 안내한다.
 */
function RewindPanel({
  checkpoints,
  workspaceId
}: {
  checkpoints: RewindPoint[]
  workspaceId: string
}): React.JSX.Element {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [done, setDone] = useState<{ id: string; text: string; ok: boolean } | null>(null)
  const pushToast = useStore((s) => s.pushToast)

  if (checkpoints.length === 0) {
    return (
      <Empty>
        No checkpoints yet. Each message you send while this session is live becomes a restore
        point.
      </Empty>
    )
  }

  const restore = (cp: RewindPoint): void => {
    setBusyId(cp.userMessageId)
    setDone(null)
    void window.api.commands
      .rewindAction(workspaceId, cp.userMessageId)
      .then(({ result, error }) => {
        setBusyId(null)
        if (error || !result) {
          setDone({ id: cp.userMessageId, text: error || 'Rewind failed.', ok: false })
          return
        }
        if (!result.canRewind) {
          setDone({ id: cp.userMessageId, text: result.error || 'Nothing to restore.', ok: false })
          return
        }
        const n = result.filesChanged?.length ?? 0
        const detail =
          typeof result.insertions === 'number' || typeof result.deletions === 'number'
            ? ` (+${result.insertions ?? 0} −${result.deletions ?? 0})`
            : ''
        const summary = `Restored ${n} file${n === 1 ? '' : 's'}${detail}.`
        setDone({ id: cp.userMessageId, text: summary, ok: true })
        pushToast('success', summary)
      })
  }

  return (
    <div className="space-y-1.5">
      <div className="text-xs text-neutral-600">Restore tracked files to a message:</div>
      <ul className="space-y-0.5">
        {checkpoints.map((cp) => {
          const busy = busyId === cp.userMessageId
          const result = done?.id === cp.userMessageId ? done : null
          return (
            <li key={cp.userMessageId}>
              <button
                onClick={() => restore(cp)}
                disabled={busyId !== null}
                className="w-full flex items-center gap-2 text-left rounded-md px-1.5 py-1 transition-colors hover:bg-[var(--surface-3)] disabled:opacity-50 disabled:cursor-default"
              >
                {busy ? (
                  <Loader2 size={12} className="shrink-0 animate-spin text-neutral-500" />
                ) : (
                  <RotateCcw size={12} className="shrink-0 text-neutral-500" />
                )}
                <span className="flex-1 min-w-0 truncate text-sm text-neutral-200" title={cp.text}>
                  {cp.text}
                </span>
              </button>
              {result && (
                <div
                  className={`px-1.5 pb-1 text-xs ${result.ok ? 'text-[var(--success-400)]' : 'text-[var(--danger-400)]'}`}
                >
                  {result.text}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="text-neutral-500">{children}</span>
}

/**
 * 인수인계 비용을 사람이 읽는 한 구절로. 어림값이므로([[shared/handoff]]) 정확한 척하지 않고
 * 자릿수만 보여 준다 — 사용자가 이 숫자로 하는 판단은 "지금 넘길 만한가" 하나다.
 * 아직 기록을 못 읽어 크기를 모르면(0) 숫자를 지어내지 않고 비용이 든다는 사실만 말한다.
 */
function handoffCostLabel(tokens: number): string {
  if (tokens <= 0) return 'a full turn of input'
  return `${formatHandoffTokens(tokens)} tokens of input in one turn`
}

/** 메인 에이전트 교체에 대한 이 화면의 판단(상태줄 칩 · /agent 카드 공용). */
interface AgentSwitchState {
  /** 고를 대상이 둘 이상이라 교체라는 선택지 자체가 존재하는가(칩·/agent 노출 여부). */
  offered: boolean
  /** 지금 이 순간 실제로 바꿀 수 있는가(턴이 도는 중·아카이브면 false). */
  switchable: boolean
  /** 바꾸면 지난 대화를 새 에이전트에게 넘기는 턴이 도는가 — 그렇다면 비용을 먼저 알린다. */
  needsHandoff: boolean
}

/**
 * 규칙 자체는 shared 의 [[canSwitchAgentBackend]]·[[agentSwitchNeedsHandoff]] 가 갖고 있고,
 * 여기서는 렌더러 쪽 재료만 모은다 — 고를 대상이 둘 이상인지, 그리고 이 워크스페이스의 대화
 * 기록을 실제로 읽었는지.
 *
 * 기록을 아직 못 읽은 상태는 "대화가 없다" 가 아니라 "모른다" 다. 그 구분을 안 하면 기록을
 * 불러오는 짧은 순간에 누른 교체가 경고 없이 턴을 돌린다 — 그래서 모르는 동안에는 경고 쪽으로
 * 기울여 둔다(main 이 기록 파일로 다시 판정하므로, 넘겨짚어 확인을 건너뛰면 거절당하기도 한다).
 *
 * 대화 **개수**만 구독하는 것이 중요하다. 항목 배열을 구독하면 답변이 스트리밍되는 동안 토큰마다
 * 입력창 전체가 다시 그려진다 — 여기서 필요한 건 "대화가 있는가" 뿐이다.
 */
function useAgentSwitch(workspace: Workspace): AgentSwitchState {
  const available = useAvailableBackends()
  const loaded = useStore((s) => s.loadedTranscripts[workspace.id] ?? false)
  const messageCount = useStore((s) => s.transcripts[workspace.id]?.length ?? 0)
  const offered = available.length > 1
  return {
    offered,
    switchable: offered && canSwitchAgentBackend(workspace),
    needsHandoff: !loaded || agentSwitchNeedsHandoff(workspace, messageCount)
  }
}

/**
 * 인수인계로 넘어갈 대략적인 토큰 수. main 이 실제로 보낼 프롬프트를 같은 함수로 만들어 재 본다 —
 * 경고에 적힌 양과 실제로 보내는 양이 갈리면 경고가 아니라 소음이다.
 *
 * `enabled` 가 false 면 재지 않는다(0). 프롬프트 조립은 대화 길이에 비례하는 일이라, 필요하지도
 * 않은 화면에서 매 렌더 돌릴 것이 아니다 — /agent 카드가 열려 있고 실제로 바꿀 수 있을 때만 쓴다.
 */
function useHandoffEstimate(workspace: Workspace, enabled: boolean): number {
  const items = useStore((s) => (enabled ? s.transcripts[workspace.id] : undefined)) ?? EMPTY
  const backends = useAvailableBackends()
  const fromLabel =
    backends.find((b) => b.id === workspace.agentBackend)?.label ??
    AGENT_BACKEND_LABELS[workspace.agentBackend]
  return useMemo(() => {
    if (!enabled) return 0
    const prompt = buildHandoffPrompt({ items, fromLabel })
    return prompt ? estimateHandoffTokens(prompt) : 0
  }, [enabled, items, fromLabel])
}

/**
 * 입력창 바로 위에 항상 노출되는 상태줄.
 * worktree 디렉토리명 · 컨텍스트 사용량을 한 줄로 보여 준다(옵셔널/토글 없음).
 * 컨텍스트는 Claude Code CLI 의 컨텍스트 게이지에 대응 — 막대 + 퍼센트로 표시하고,
 * 자동 압축이 도는 동안에는 진행 표시로, 사용량 데이터가 아직 없으면(첫 턴 전) "—" 로 바뀐다.
 */
function StatusLine({
  workspace,
  onPick
}: {
  workspace: Workspace
  /** 모델/effort/fast 항목 클릭 시 해당 선택 카드를 연다(슬래시 /model·/effort·/fast 와 동일). */
  onPick: (kind: PickerKind) => void
}): React.JSX.Element {
  const usage = useStore((s) => s.contextUsage[workspace.id])
  const compacting = useStore((s) => s.compacting[workspace.id] ?? false)
  const fallbackModel = useStore((s) => s.activeFallbackModels[workspace.id])
  // 레이트리밋은 계정 단위 전역 값이라 workspace.id 로 색인하지 않는다(contextUsage 와 다른 점).
  const rateLimits = useStore((s) => {
    const app = s.app!
    if (app.rateLimitsByAgent) return app.rateLimitsByAgent[workspace.agentBackend]
    return workspace.agentBackend === 'claude' ? app.rateLimits : undefined
  })
  const backend = useWorkspaceBackend(workspace)
  const models = useModels(workspace.agentBackend)
  const defaults = useAgentSettings(workspace.agentBackend)
  // fast mode 는 Claude Code 전용이라, 지원하지 않는 백엔드에서는 상태줄에서도 감춘다.
  const supportsFastMode = backend?.capabilities.fastMode ?? false
  // 에이전트 칩은 **고를 것이 있을 때만** 띄운다. 어떤 에이전트가 도는지는 헤더의 브랜드 마크가
  // 늘 말해 주므로, 하나뿐인 사용자에게 여기서까지 반복하면 아무 데도 이어지지 않는 라벨이 하나
  // 더 늘 뿐이다. 반대로 둘 이상이면 모델·effort 칩과 같은 성질이 된다 — 언제든 눌러 바꾸는 값.
  const agentSwitch = useAgentSwitch(workspace)
  const agentLabel = backend?.label ?? AGENT_BACKEND_LABELS[workspace.agentBackend]

  // worktree 절대 경로의 마지막 구간(디렉토리명). 비정상 경로면 전체 경로로 폴백한다.
  const dirName = workspace.worktreePath.split('/').filter(Boolean).pop() ?? workspace.worktreePath

  // 표시는 "유효 값" 기준: workspace 오버라이드 → (모델은 init 으로 확정된 lastModel) → 전역 설정.
  const modelText = modelLabel(models, workspace.model ?? workspace.lastModel ?? defaults.model)
  const effortText = effortLabel(backend, workspace.effort ?? defaults.effort)
  // fast mode 는 "설정" 보다 세션이 보고한 "실제 상태" 를 우선해 보여 준다(쿨다운·미지원 모델 등).
  const fast = fastModeStatus(
    workspace.fastMode ?? defaults.fastMode,
    workspace.fastModeState,
    workspace.fastModeReason
  )

  return (
    <div className="flex items-center gap-3 mb-1.5 px-1 text-xs text-neutral-500">
      <span
        className="flex items-center gap-1 min-w-0 shrink"
        title={`Directory: ${workspace.worktreePath}`}
      >
        <Folder size={11} className="shrink-0 text-neutral-600" />
        <span className="truncate">{dirName}</span>
      </span>
      {agentSwitch.offered && (
        <button
          onClick={() => onPick('agent')}
          className="flex items-center gap-1 min-w-0 shrink hover:text-neutral-300 transition-colors"
          title={`Agent: ${agentLabel} — click or type /agent to switch`}
        >
          <AgentBackendMark backend={workspace.agentBackend} size={11} />
          <span className="truncate">{agentLabel}</span>
        </button>
      )}
      <button
        onClick={() => onPick('model')}
        className="flex items-center gap-1 min-w-0 shrink hover:text-neutral-300 transition-colors"
        title={`Model: ${modelText} — click or type /model to change`}
      >
        <Cpu size={11} className="shrink-0 text-neutral-600" />
        <span className="truncate">{modelText}</span>
      </button>
      {fallbackModel && (
        <span
          className="shrink-0 text-amber-400"
          title={`Primary model unavailable — using fallback ${modelLabel(models, fallbackModel)}`}
        >
          Fallback: {modelLabel(models, fallbackModel)}
        </span>
      )}
      <button
        onClick={() => onPick('effort')}
        className="flex items-center gap-1 min-w-0 shrink hover:text-neutral-300 transition-colors"
        title={`Reasoning effort: ${effortText} — click or type /effort to change`}
      >
        <Zap size={11} className="shrink-0 text-neutral-600" />
        <span className="truncate">{effortText}</span>
      </button>
      {supportsFastMode && (
        <button
          onClick={() => onPick('fast')}
          className={
            'flex items-center gap-1 min-w-0 shrink transition-colors ' +
            (fast.active
              ? 'text-[var(--accent-300)] hover:text-[var(--accent-200)]'
              : 'hover:text-neutral-300')
          }
          title={`${fast.title} — click or type /fast to change`}
        >
          <Rabbit
            size={11}
            className={
              'shrink-0 ' + (fast.active ? 'text-[var(--accent-400)]' : 'text-neutral-600')
            }
          />
          <span className="truncate">{fast.text}</span>
        </button>
      )}
      <ContextStatus usage={usage} compacting={compacting} />
      <RateLimitStatus backend={workspace.agentBackend} snapshot={rateLimits} />
    </div>
  )
}

/** 선택 카드 1개의 옵션. value '' = 전역 설정 따름(Default). */
type PickerOption = {
  value: string
  label: string
  hint?: string
  /** 있으면 라벨 앞에 그 에이전트의 브랜드 마크를 그린다(/agent 카드). */
  mark?: AgentBackendId
}

/** 상태줄 클릭·슬래시 명령으로 여는 로컬 선택 카드의 종류. */
type PickerKind = 'model' | 'effort' | 'fast' | 'agent' | 'plan'

/**
 * 입력창 위에 뜨는 /model·/effort 선택 카드. 백엔드 왕복 없이 로컬에서 값을 고른다 —
 * 현재 값을 강조하고, ↑↓ 로 이동·Enter 로 적용·Esc 로 닫는다(카드가 입력창 위에 떠 있고
 * 포커스는 textarea 에 남으므로 document 캡처 단계에서 키를 가로챈다, McpPanel 과 동일한 방식).
 * 턴이 도는 중에는 적용을 막고 안내만 보여 준다(헤더 드롭다운 시절의 동작과 동일). 모델은 이제
 * 살아 있는 세션 위에서 갈아 끼우지만(setModel), effort·fast mode 는 여전히 query 시작 시점에
 * 고정돼 세션을 다시 열어야 하므로 잠금은 셋 모두에 그대로 둔다.
 *
 * /agent 만 성질이 다르다. 로컬에서 끝나지 않고 main 이 다시 판정하며, 이미 대화가 오간
 * 워크스페이스에서는 적용 전에 확인을 받는다 — 새 에이전트는 지금까지의 맥락을 하나도 못 보고
 * 처음부터 다시 파악해야 해서, 그 한 번이 세션 사용량을 크게 먹는다.
 */
function PickerCard({
  kind,
  workspace,
  running,
  onClose
}: {
  kind: PickerKind
  workspace: Workspace
  running: boolean
  onClose: () => void
}): React.JSX.Element {
  const backend = useWorkspaceBackend(workspace)
  const models = useModels(workspace.agentBackend)
  const defaults = useAgentSettings(workspace.agentBackend)
  const pushToast = useStore((s) => s.pushToast)
  const confirm = useStore((s) => s.confirm)
  const resetContextUsage = useStore((s) => s.resetContextUsage)
  // 에이전트 교체는 이 카드가 유일한 경로가 아니다(main 이 같은 규칙으로 다시 판정한다).
  // 여기서는 카드가 떠 있는 동안 조건이 무너지는 경우(다른 창에서 턴이 시작됐다든지)를 본다.
  const availableAgents = useAvailableBackends()
  const agentSwitch = useAgentSwitch(workspace)
  // 크기는 이 카드가 실제로 교체를 제안하는 동안에만 잰다(잠겨 있으면 고를 수도 없다).
  const handoffTokens = useHandoffEstimate(
    workspace,
    kind === 'agent' && agentSwitch.switchable && agentSwitch.needsHandoff
  )

  const options = useMemo<PickerOption[]>(() => {
    if (kind === 'agent') {
      // 교체는 "지금 쓸 수 있는" 에이전트로만 — 설치되지 않은 CLI 를 고르게 하면 첫 메시지에서야
      // 실패한다. 기본값(전역 설정 따름) 항목이 없는 것도 요점이다: 워크스페이스의 에이전트는
      // 항상 확정된 값이라, "안 고름" 이라는 상태가 존재하지 않는다.
      return availableAgents.map((b) => ({ value: b.id, label: b.label, mark: b.id }))
    }
    if (kind === 'plan') {
      // 권한 모드는 항상 확정된 값이라 /agent 처럼 전역 기본값을 따르는 가상 항목을 두지 않는다.
      return permissionModesFor(backend).map((mode) => ({
        value: mode.id,
        label: mode.label,
        hint: mode.description
      }))
    }
    if (kind === 'fast') {
      return [
        { value: '', label: 'Default', hint: fastModeLabel(defaults.fastMode) },
        { value: 'on', label: 'On', hint: FAST_MODE_HINT },
        { value: 'off', label: 'Off', hint: 'Standard output speed' }
      ]
    }
    if (kind === 'model') {
      const base: PickerOption[] = [
        { value: '', label: 'Default', hint: modelLabel(models, defaults.model) },
        ...models.map((m) => ({ value: m.id, label: m.label }))
      ]
      // 목록에 없는 커스텀 모델을 이미 쓰고 있으면 그 항목도 노출해 선택 상태가 보이도록.
      if (workspace.model && !models.some((m) => m.id === workspace.model)) {
        base.push({ value: workspace.model, label: workspace.model })
      }
      return base
    }
    // effort 는 모델이 지원 단계를 알려 주면(Codex) 그쪽으로 좁힌다.
    const active = models.find((m) => m.id === (workspace.model ?? defaults.model))
    return [
      { value: '', label: 'Default', hint: effortLabel(backend, defaults.effort) },
      ...effortOptionsFor(backend, active).map((e) => ({
        value: e.id,
        label: e.label,
        hint: e.hint
      }))
    ]
  }, [
    kind,
    backend,
    models,
    availableAgents,
    defaults.model,
    defaults.effort,
    defaults.fastMode,
    workspace.model
  ])

  // 현재 값: fast 는 boolean|null 을 'on'/'off'/''(전역 따름) 문자열로 환산해 다른 카드와 같게 다룬다.
  const current =
    kind === 'agent'
      ? workspace.agentBackend
      : kind === 'plan'
        ? workspace.permissionMode
        : kind === 'model'
          ? (workspace.model ?? '')
          : kind === 'effort'
            ? (workspace.effort ?? '')
            : workspace.fastMode === null
              ? ''
              : workspace.fastMode
                ? 'on'
                : 'off'
  const currentIdx = Math.max(
    0,
    options.findIndex((o) => o.value === current)
  )
  const [cursor, setCursor] = useState(currentIdx)
  const activeRef = useRef<HTMLButtonElement | null>(null)

  // /plan 은 Shift+Tab 처럼 턴 중에도 바꿀 수 있어 model·effort 의 세션 잠금을 따르지 않는다.
  const locked = kind === 'agent' ? !agentSwitch.switchable : kind === 'plan' ? false : running

  /**
   * 에이전트 교체 1건. 지난 대화를 넘겨야 하는 자리에서는 먼저 확인을 받는다 — 그 인수인계는
   * 사용자가 시키지 않은 턴이 한 번 도는 일이고, 대화가 길수록 비싸다. 값이 조용히 바뀌는 다른
   * 카드들과 무게가 다르므로 크기까지 함께 보여 주고 묻는다.
   * 최종 판정은 main 이 하므로 거절 사유(CLI 미설치·턴 진행 중)는 토스트로 그대로 보여 준다.
   */
  const switchAgent = async (value: AgentBackendId): Promise<void> => {
    const label = availableAgents.find((b) => b.id === value)?.label ?? AGENT_BACKEND_LABELS[value]
    if (agentSwitch.needsHandoff) {
      const ok = await confirm({
        title: `Switch this workspace to ${label}?`,
        body:
          `Agents can’t share a session, so the conversation so far rides along with your next ` +
          `message to ${label} — ${handoffCostLabel(handoffTokens)}, billed to your usage. ` +
          `Until you send that message it knows nothing about this workspace.`,
        confirmLabel: 'Switch and hand over',
        danger: true
      })
      if (!ok) return
    }
    const res = await window.api.workspace.setAgentBackend(workspace.id, value, {
      handoff: agentSwitch.needsHandoff
    })
    if (res?.error) {
      pushToast('error', res.error)
      return
    }
    // 새 세션이라 컨텍스트도 처음부터다 — 옛 에이전트의 사용량을 남겨 두면 인수인계 턴이 값을
    // 다시 보내 줄 때까지 게이지가 엉뚱한 양을 가리킨다.
    resetContextUsage(workspace.id)
  }

  const apply = (value: string): void => {
    if (locked) return // 잠긴 동안에는 안내만 보여 준다.
    if (value !== current) {
      if (kind === 'agent') void switchAgent(value as AgentBackendId)
      else if (kind === 'plan')
        void window.api.workspace.setPermissionMode(workspace.id, value as PermissionMode)
      else if (kind === 'model') void window.api.workspace.setModel(workspace.id, value || null)
      else if (kind === 'effort')
        void window.api.workspace.setEffort(workspace.id, (value || null) as EffortSetting | null)
      else void window.api.workspace.setFastMode(workspace.id, value ? value === 'on' : null)
    }
    onClose()
  }

  // 최신 상태를 보는 키 핸들러를 매 렌더 갱신하고 리스너는 한 번만 바인딩한다(stale closure 방지).
  const handlerRef = useRef<(e: KeyboardEvent) => void>(() => {})
  handlerRef.current = (e: KeyboardEvent): void => {
    // ⌘ 조합은 가로채지 않는다 — ⌘↑/⌘↓(워크스페이스 전환) 같은 전역 단축키가 카드 때문에 죽으면 안 된다.
    if (e.metaKey) return
    if (!['ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(e.key)) return
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') onClose()
    else if (e.key === 'ArrowDown') setCursor((c) => (c + 1) % options.length)
    else if (e.key === 'ArrowUp') setCursor((c) => (c - 1 + options.length) % options.length)
    else if (e.key === 'Enter') apply(options[Math.min(cursor, options.length - 1)].value)
  }
  useEffect(() => {
    const listener = (e: KeyboardEvent): void => handlerRef.current(e)
    document.addEventListener('keydown', listener, true)
    return () => document.removeEventListener('keydown', listener, true)
  }, [])

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const title =
    kind === 'agent'
      ? '/agent'
      : kind === 'plan'
        ? '/plan'
        : kind === 'model'
          ? '/model'
          : kind === 'effort'
            ? '/effort'
            : '/fast'
  const description =
    kind === 'agent'
      ? 'Main agent for this workspace'
      : kind === 'plan'
        ? 'Permissions for this workspace'
        : kind === 'model'
          ? 'Model for this workspace'
          : kind === 'effort'
            ? 'Reasoning effort for this workspace'
            : 'Fast mode for this workspace — same model, faster output'
  // /fast 카드에서만: 지금 쓰는 모델이 fast mode 를 지원하지 않으면 켜도 소용없으므로 미리 알린다.
  const effectiveModel = workspace.model ?? workspace.lastModel ?? defaults.model
  const fastUnsupported = kind === 'fast' && !modelSupportsFastMode(models, effectiveModel)
  const iconProps = { size: 13, className: 'text-[var(--accent-400)] shrink-0' }
  const icon =
    kind === 'agent' ? (
      <Bot {...iconProps} />
    ) : kind === 'plan' ? (
      <ShieldCheck {...iconProps} />
    ) : kind === 'model' ? (
      <Cpu {...iconProps} />
    ) : kind === 'effort' ? (
      <Zap {...iconProps} />
    ) : (
      <Rabbit {...iconProps} />
    )

  return (
    <div className="absolute bottom-full mb-2 left-0 right-0 max-h-96 overflow-y-auto rounded-xl border border-[var(--accent-500)]/30 bg-[var(--bg-3)] shadow-2xl z-20">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)] sticky top-0 bg-[var(--bg-3)]">
        {icon}
        <span className="text-sm font-medium text-[var(--accent-300)] shrink-0">{title}</span>
        <span className="text-xs text-neutral-500 truncate">{description}</span>
        <span className="ml-auto shrink-0 text-xs text-neutral-600 select-none">Esc to close</span>
        <button
          onClick={onClose}
          title="Dismiss (Esc)"
          className="shrink-0 h-5 w-5 grid place-items-center rounded text-neutral-500 hover:text-neutral-200 hover:bg-[var(--surface-3)]"
        >
          <X size={13} />
        </button>
      </div>
      <div className="py-1">
        {options.map((opt, i) => {
          const active = i === cursor
          const selected = opt.value === current
          return (
            <button
              key={opt.value || '__default'}
              ref={(el) => {
                if (active) activeRef.current = el
              }}
              onMouseEnter={() => setCursor(i)}
              onMouseDown={(e) => {
                e.preventDefault() // textarea blur 방지
                apply(opt.value)
              }}
              disabled={locked}
              className={
                'w-full flex items-baseline gap-2 px-3 py-1.5 text-left disabled:cursor-not-allowed ' +
                (active ? 'bg-[var(--surface-3)]' : 'hover:bg-[var(--surface)]')
              }
            >
              <Check
                size={12}
                className={
                  'shrink-0 translate-y-0.5 ' +
                  (selected ? 'text-[var(--accent-400)]' : 'text-transparent')
                }
              />
              {opt.mark && (
                <span className="shrink-0 translate-y-0.5 text-neutral-400">
                  <AgentBackendMark backend={opt.mark} size={13} />
                </span>
              )}
              <span className="text-sm font-medium text-neutral-100 shrink-0">{opt.label}</span>
              {opt.hint && <span className="text-xs text-neutral-500 truncate">{opt.hint}</span>}
            </button>
          )
        })}
      </div>
      {fastUnsupported && (
        <div className="px-3 py-1.5 text-xs text-[var(--warning-400)]/90 border-t border-[var(--border)]">
          {modelLabel(models, effectiveModel)} doesn’t support fast mode — switch to Opus 5 or Opus
          4.8 with /model.
        </div>
      )}
      {kind === 'agent' && !locked && (
        // 대화가 오간 뒤의 교체는 값 하나 바꾸는 일이 아니라 턴이 한 번 도는 일이다. 고르고 나면
        // 확인 대화상자가 한 번 더 묻지만, 고르기 **전에** 알아야 할 이야기라 카드에서도 말한다.
        <div className="px-3 py-1.5 text-xs space-y-1 border-t border-[var(--border)]">
          {agentSwitch.needsHandoff && (
            <p className="text-[var(--warning-400)]/90">
              This conversation rides along with your next message to the new agent —{' '}
              {handoffCostLabel(handoffTokens)}, billed to your usage.
            </p>
          )}
          <p className="text-neutral-600">
            Switching resets the model, reasoning effort, and fast mode to this agent’s defaults.
          </p>
        </div>
      )}
      <div className="px-3 py-1.5 text-xs text-neutral-600 border-t border-[var(--border)]">
        {locked
          ? kind === 'agent'
            ? 'Stop the current turn to switch agents.'
            : 'Stop the current turn to change it.'
          : '↑↓ navigate · ↵ select · esc close'}
      </div>
    </div>
  )
}

/** 상태줄 우측의 컨텍스트 사용량 표시(막대 + 퍼센트 · 압축 중 · 데이터 없음). */
function ContextStatus({
  usage,
  compacting
}: {
  usage?: { usedTokens: number; maxTokens: number; percentage: number }
  compacting: boolean
}): React.JSX.Element {
  if (compacting) {
    return (
      <span className="ml-auto shrink-0 flex items-center gap-1.5 text-[var(--accent-400)]">
        <span className="h-2.5 w-2.5 rounded-full border-2 border-[var(--accent-400)]/40 border-t-violet-400 animate-spin" />
        Compacting…
      </span>
    )
  }

  // 첫 턴 전(사용량 미집계)에도 항상 노출 — 자리만 잡고 "—" 로 표시한다.
  if (!usage || usage.maxTokens <= 0) {
    return (
      <span
        className="ml-auto shrink-0 flex items-center gap-1.5 text-neutral-600"
        title="Context usage appears after the first turn"
      >
        <Gauge size={11} className="shrink-0" />
        context —
      </span>
    )
  }

  const pct = Math.min(100, Math.round(usage.percentage * 100))
  // 70% 미만 중립, 70~89% 주의(amber), 90%+ 위험(red).
  const tone =
    pct >= 90
      ? 'text-[var(--danger-400)]'
      : pct >= 70
        ? 'text-[var(--warning-400)]'
        : 'text-neutral-500'
  const barTone =
    pct >= 90 ? 'bg-[var(--danger-400)]' : pct >= 70 ? 'bg-[var(--warning-400)]' : 'bg-neutral-500'

  return (
    <span
      className={'ml-auto shrink-0 flex items-center gap-1.5 ' + tone}
      title={`Context: ${usage.usedTokens.toLocaleString()} / ${usage.maxTokens.toLocaleString()} tokens (${pct}%)`}
    >
      <Gauge size={11} className="shrink-0" />
      <span className="h-1 w-16 rounded-full bg-[var(--surface-3)] overflow-hidden">
        <span className={'block h-full rounded-full ' + barTone} style={{ width: `${pct}%` }} />
      </span>
      {pct}%
    </span>
  )
}

/**
 * 상태줄의 계정 레이트리밋 표시(요약 1개 + 클릭 시 전체 창 팝오버).
 *
 * 값은 워크스페이스가 아니라 **계정** 단위라 AppState 의 전역 스냅샷을 그대로 읽는다 —
 * 어느 워크스페이스를 보고 있든 같은 값이 보인다.
 *
 * 표시 규칙:
 * - 스냅샷이 없으면(첫 조회 전) 아무것도 그리지 않는다. 요금제 사용자인지 API 키 사용자인지
 *   모르는 상태에서 자리를 잡아 두면, API 키 사용자에게 잠깐 나타났다 사라지는 깜빡임이 된다.
 * - available=false(API 키 등 요금제 한도 미적용)면 **완전히 숨긴다**(0%·N/A 를 보여 주지 않는다).
 * - 창이 여럿이라도 상태줄에는 하나만(나머지는 팝오버로). 어느 창인지는 backend 마다 고정이다 —
 *   Claude 는 5시간 세션 창, Codex 는 주간 창(statusWindow). 다만 **다른 창이 경고선을 넘으면
 *   경고색은 그대로 켠다** — 보여 주는 창을 고정한 대가로 임박한 한도를 놓치면 안 되기 때문이다.
 */
function RateLimitStatus({
  backend,
  snapshot
}: {
  backend: AgentBackendId
  snapshot?: RateLimitSnapshot
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  // 리셋 카운트다운과 stale 표시는 둘 다 "흐르는" 값이지만 분 단위라 30 초면 충분하다.
  // 팝오버가 닫혀 있어도 stale 전환은 보여야 하므로 스냅샷이 있는 동안에는 계속 돌린다.
  const now = useNow(30_000, !!snapshot)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  // 대표 창은 backend 마다 고정(Claude=5시간, Codex=주간). 사용률 순위로 바뀌지 않는다.
  // 경고색 판단에 쓰는 hotter 는 "표시 창보다 뜨거운 창" — Overview 와 같은 규칙을 공유한다.
  const { shown, hotter } = useMemo(
    () => headlineWindows(backend, snapshot?.windows ?? []),
    [backend, snapshot]
  )

  if (!shouldShowRateLimits(snapshot) || !snapshot || !shown) return null

  const pct = normalizeUtilization(shown.utilization) ?? 0
  const hottestPct = normalizeUtilization(hotter?.utilization ?? null)
  // 다른 창이 더 뜨거우면 그쪽으로도 경고를 켠다(숫자는 고정된 창을 유지한 채 색만 알린다).
  const warn = isWarning(pct) || !!hotter
  const stale = isStale(snapshot, now)

  const tone = warn ? 'text-[var(--warning-400)]' : 'text-neutral-500'
  const barTone = warn ? 'bg-[var(--warning-400)]' : 'bg-neutral-500'

  const onRefresh = (): void => {
    setRefreshing(true)
    void window.api.rateLimits.refresh().finally(() => setRefreshing(false))
  }

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={
          'flex items-center gap-1.5 transition-colors hover:text-neutral-300 ' +
          tone +
          (stale ? ' opacity-50' : '')
        }
        title={
          `Plan usage — ${shown.label} at ${pct}%` +
          (hotter ? ` (${hotter.label} at ${hottestPct}%)` : '') +
          (stale ? ` (last checked ${agoLabel(now - snapshot.fetchedAt)})` : '') +
          ' — click for all windows'
        }
      >
        <Activity size={11} className="shrink-0" />
        <span className="h-1 w-16 rounded-full bg-[var(--surface-3)] overflow-hidden">
          <span className={'block h-full rounded-full ' + barTone} style={{ width: `${pct}%` }} />
        </span>
        {pct}%
      </button>

      {open && (
        <div className="absolute bottom-full right-0 z-50 mb-1.5 w-72 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2.5 shadow-xl">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-neutral-200">Plan usage</span>
            {snapshot.subscriptionType && (
              <span className="text-[10px] uppercase tracking-wide text-neutral-500">
                {snapshot.subscriptionType}
              </span>
            )}
          </div>

          <div className="space-y-1.5">
            {snapshot.windows.map((w) => {
              const wp = normalizeUtilization(w.utilization)
              const wWarn = isWarning(wp)
              const reset = resetLabel(w.resetsAt, now)
              return (
                <div key={w.label} className="flex items-center gap-2">
                  <span className="w-24 shrink-0 text-xs text-neutral-500">{w.label}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--surface-3)]">
                    <div
                      className={
                        'h-full ' + (wWarn ? 'bg-[var(--warning-400)]' : 'bg-[var(--accent-400)]')
                      }
                      style={{ width: `${wp ?? 0}%` }}
                    />
                  </div>
                  <span
                    className={
                      'w-8 shrink-0 text-right text-xs tabular-nums ' +
                      (wWarn ? 'text-[var(--warning-400)]' : 'text-neutral-500')
                    }
                  >
                    {wp == null ? '—' : `${wp}%`}
                  </span>
                  <span className="w-14 shrink-0 text-right text-[10px] text-neutral-600">
                    {reset ? `in ${reset}` : ''}
                  </span>
                </div>
              )
            })}
          </div>

          <div className="mt-2 flex items-center justify-between gap-2 border-t border-[var(--border)] pt-2">
            <span className="text-[10px] text-neutral-600">
              Updated {agoLabel(now - snapshot.fetchedAt)}
            </span>
            <button
              onClick={onRefresh}
              disabled={refreshing}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-neutral-400 transition-colors hover:bg-[var(--surface-3)] hover:text-neutral-200 disabled:opacity-50"
              title="Check plan rate limits now"
            >
              <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

const EMPTY: ChatItem[] = []
/** 멘션 후보가 없을 때 돌려주는 고정 배열(매 렌더 새 배열을 만들지 않도록). */
const EMPTY_HITS: FileHit[] = []
const EMPTY_QUEUE: import('../store').QueuedMessage[] = []
/** 참조 동일성 유지용 — 매 렌더마다 새 배열을 만들면 하위 memo 가 헛되이 깨진다. */
const EMPTY_COMMANDS: CommandPanelKind[] = []
