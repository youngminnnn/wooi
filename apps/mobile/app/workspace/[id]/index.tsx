import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Dimensions,
  Image,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import {
  ArrowRightLeft,
  Brain,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  CornerDownRight,
  Camera,
  FileText,
  FolderOpen,
  Image as ImageGlyph,
  Images,
  ListTodo,
  Paperclip,
  Terminal,
  Users,
  Wrench,
  X,
  type LucideIcon
} from 'lucide-react-native'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import type { ChatAttachment, ChatItem, PermissionRequest } from '@shared/types'
import { workspaceDisplayName } from '@shared/types'
import {
  REMOTE_MAX_ATTACHMENTS,
  REMOTE_MAX_ATTACHMENT_TOTAL_BYTES,
  isRemoteImageMediaType
} from '@shared/remote'
import { formatToolGroup } from '@shared/toolGroups'
import { BrandMark } from '../../../src/components/BrandMark'
import { DemoBanner } from '../../../src/components/DemoBanner'
import { QuestionCard } from '../../../src/components/QuestionCard'
import {
  PermissionModeFooter,
  WorkspaceStatusBar
} from '../../../src/components/WorkspaceStatusBar'
import { usePrColors } from '../../../src/state/prColors'
import { isLaptopAway, useRemoteStore } from '../../../src/state/store'
import { agoLabel, untilLabel, useNow } from '../../../src/state/useNow'
import { useDeviceAuthentication } from '../../../src/state/useDeviceAuth'
import { useTheme, useThemedStyles } from '../../../src/state/theme'
import type { Theme } from '../../../src/theme'
import { buildChatRows, type ChatRowModel, type ToolCardModel } from '../../../src/chat/rows'
import { isPermissionRequest, isQuestionRequest } from '../../../src/chat/questions'
import { chunkBase64 } from '../../../src/attachments/chunks'
import {
  AttachmentError,
  pickCameraPhoto,
  pickDocuments,
  pickImages,
  type PendingAttachment
} from '../../../src/attachments/pick'

const PAGE_SIZE = 100
const WATCH_REFRESH_MS = 40_000
const MAX_PROMPT_BYTES = 32 * 1024

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatPermissionInput(request: PermissionRequest): string {
  if (request.kind === 'command') {
    const command = request.input.command
    if (typeof command === 'string') return command
    if (Array.isArray(command) && command.every((part) => typeof part === 'string')) {
      return command.join(' ')
    }
  }
  return JSON.stringify(request.input, null, 2)
}

function Diff({ value }: { value: string }): React.JSX.Element {
  const styles = useThemedStyles(makeStyles)
  return (
    <ScrollView horizontal style={styles.permissionCodeScroll}>
      <View>
        {value.split('\n').map((line, index) => (
          <View
            key={`${index}-${line}`}
            style={[
              styles.diffLine,
              line.startsWith('+') && !line.startsWith('+++') && styles.diffAdded,
              line.startsWith('-') && !line.startsWith('---') && styles.diffRemoved
            ]}
          >
            <Text style={styles.permissionCode} selectable>
              {line || ' '}
            </Text>
          </View>
        ))}
      </View>
    </ScrollView>
  )
}

function PermissionCard({
  request,
  command
}: {
  request: PermissionRequest
  command: NonNullable<ReturnType<typeof useRemoteStore.getState>['command']>
}): React.JSX.Element {
  const theme = useTheme()
  const styles = useThemedStyles(makeStyles)
  const [pending, setPending] = useState<'deny' | 'once' | 'session' | null>(null)
  const responding = pending !== null
  const [responseError, setResponseError] = useState<string | null>(null)
  const authenticate = useDeviceAuthentication()
  const demo = useRemoteStore((store) => store.demo)

  const respond = useCallback(
    async (choice: 'deny' | 'once' | 'session'): Promise<void> => {
      if (responding) return
      const behavior = choice === 'deny' ? 'deny' : 'allow'
      const rememberForSession = choice === 'session'
      setResponseError(null)
      if (!demo && behavior === 'allow' && !(await authenticate('Approve action on your computer'))) {
        setResponseError('Device authentication was cancelled or unsuccessful. Nothing was sent.')
        return
      }
      const stillPending = useRemoteStore
        .getState()
        .state?.pendingPermissions.some(
          (item) => isPermissionRequest(item) && item.requestId === request.requestId
        )
      if (stillPending !== true) return
      setPending(choice)
      const decision =
        behavior === 'deny'
          ? { behavior: 'deny' as const }
          : rememberForSession
            ? { behavior: 'allow' as const, rememberForSession: true }
            : { behavior: 'allow' as const }
      try {
        await command('permission:respond', [request.requestId, decision])
      } catch (respondError) {
        setResponseError(errorMessage(respondError))
        setPending(null)
      }
    },
    [authenticate, command, demo, request.requestId, responding]
  )

  const substance = formatPermissionInput(request)
  return (
    <View style={styles.permissionCard}>
      <View style={styles.permissionHeading}>
        <Text style={styles.permissionEyebrow}>PERMISSION REQUIRED</Text>
        {responding ? <ActivityIndicator color={theme.accent} size="small" /> : null}
      </View>
      <Text style={styles.permissionTitle}>
        {request.title ?? request.displayName ?? 'Approve this action?'}
      </Text>
      <Text style={styles.permissionTool}>{request.toolName}</Text>
      <View style={styles.permissionSubstance}>
        {request.kind === 'fileChange' && request.diff !== undefined ? (
          <Diff value={request.diff} />
        ) : (
          <ScrollView style={styles.permissionTextScroll} nestedScrollEnabled>
            <Text style={styles.permissionCode} selectable>
              {substance}
            </Text>
          </ScrollView>
        )}
      </View>
      {responseError ? <Text style={styles.permissionError}>{responseError}</Text> : null}
      {request.rule ? (
        <View style={styles.ruleBox}>
          <Text style={styles.ruleLabel}>SESSION RULE</Text>
          <Text style={styles.permissionRule}>{request.rule}</Text>
        </View>
      ) : null}
      <Text style={styles.permissionScope}>
        “Always” applies for the rest of this session only.
      </Text>
      <View style={styles.permissionActions}>
        <Pressable
          style={[styles.permissionButton, responding && styles.disabled]}
          disabled={responding}
          onPress={() => void respond('deny')}
        >
          <Text style={styles.denyButtonText}>{pending === 'deny' ? 'Sending…' : 'Deny'}</Text>
        </Pressable>
        <Pressable
          style={[styles.permissionButton, styles.sessionButton, responding && styles.disabled]}
          disabled={responding}
          onPress={() => void respond('session')}
        >
          <Text style={styles.sessionButtonText}>
            {pending === 'session' ? 'Sending…' : 'Always'}
          </Text>
        </Pressable>
        <Pressable
          style={[styles.permissionButton, styles.allowButton, responding && styles.disabled]}
          disabled={responding}
          onPress={() => void respond('once')}
        >
          <Text style={styles.allowButtonText}>{pending === 'once' ? 'Sending…' : 'Allow'}</Text>
        </Pressable>
      </View>
    </View>
  )
}

/**
 * 키보드가 가린 높이를 돌려준다.
 *
 * Android 는 `KeyboardAvoidingView` 만으로 부족하다 — Expo SDK 54 는 edge-to-edge 가 기본이라
 * `adjustResize` 가 창을 줄이지 않고, 그래서 컴포저가 키보드 뒤에 그대로 남는다. 이벤트로
 * 실제 높이를 받아 직접 패딩을 준다. SafeAreaView 가 이미 bottom inset 을 주므로 그만큼 뺀다.
 */
function useKeyboardInset(): number {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      (event) => {
        // **키보드 높이가 아니라 "창 아래에서 키보드 상단까지"** 를 쓴다.
        // Expo SDK 54 의 Android edge-to-edge 에서는 화면이 내비게이션 바 아래까지 이어지는데,
        // endCoordinates.height 에는 그 영역이 빠져 있다(실측: 창 880, 키보드 상단 488.3,
        // 높이 376.7 → 15dp 부족). 그래서 높이만 쓰면 컴포저가 딱 그만큼 가려진다.
        const windowHeight = Dimensions.get('window').height
        setInset(Math.max(0, windowHeight - event.endCoordinates.screenY))
      }
    )
    const hide = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setInset(0)
    )
    return () => {
      show.remove()
      hide.remove()
    }
  }, [])
  return inset
}

function isChatItem(value: unknown): value is ChatItem {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.ts !== 'number') return false
  switch (value.type) {
    case 'user':
    case 'assistant':
    case 'thinking':
    case 'error':
    case 'system':
      return typeof value.text === 'string'
    case 'tool_use':
      return typeof value.toolId === 'string' && typeof value.name === 'string'
    case 'tool_result':
      return (
        typeof value.toolId === 'string' &&
        typeof value.text === 'string' &&
        typeof value.isError === 'boolean'
      )
    case 'result':
      return (
        typeof value.subtype === 'string' &&
        typeof value.isError === 'boolean' &&
        typeof value.durationMs === 'number' &&
        typeof value.numTurns === 'number'
      )
    case 'unknown':
      return typeof value.backend === 'string' && typeof value.what === 'string'
    case 'bash':
      return (
        typeof value.command === 'string' &&
        typeof value.output === 'string' &&
        typeof value.running === 'boolean' &&
        (typeof value.exitCode === 'number' || value.exitCode === null)
      )
    case 'task':
      return (
        typeof value.taskId === 'string' &&
        typeof value.name === 'string' &&
        typeof value.description === 'string' &&
        typeof value.status === 'string'
      )
    case 'handoff':
      return (
        typeof value.childWorkspaceId === 'string' &&
        typeof value.childName === 'string' &&
        typeof value.childBranch === 'string' &&
        typeof value.status === 'string' &&
        typeof value.summary === 'string'
      )
    default:
      return false
  }
}

function parseTranscript(value: unknown): ChatItem[] {
  // 배열이 아니면 프로토콜이 어긋난 것이라 던진다. 하지만 **아이템 하나가 이상하다고
  // 페이지 전체를 버리지는 않는다** — 랩탑이 큰 본문을 잘라 보내거나 우리가 모르는 타입이
  // 하나 섞였을 때, 나머지 대화까지 못 읽게 되는 편이 훨씬 나쁘다.
  if (!Array.isArray(value)) throw new Error('The computer returned an invalid transcript')
  return value.filter(isChatItem)
}

/**
 * 한 번에 그릴 본문 길이. 랩탑은 봉투에 들어가는 만큼(수십만 자) 보내 주는데, 그걸 그대로
 * Text 하나에 넣으면 스크롤이 끊긴다. 앞부분만 먼저 그리고 나머지는 눌러서 펼친다 —
 * 자르는 게 아니라 **미루는 것**이라 내용은 그대로 다 있다.
 */
const RENDER_CHARS = 8000

function RichText({
  text,
  color
}: {
  text: string
  color?: string
}): React.JSX.Element {
  const theme = useTheme()
  const styles = useThemedStyles(makeStyles)
  const tint = color ?? theme.text
  const [expanded, setExpanded] = useState(false)
  const hidden = expanded ? 0 : Math.max(0, text.length - RENDER_CHARS)
  // 서러게이트 쌍 한가운데서 자르면 이모지가 깨진 글자로 남는다.
  const cut = /[\uD800-\uDBFF]/.test(text.charAt(RENDER_CHARS - 1))
    ? RENDER_CHARS - 1
    : RENDER_CHARS
  const shown = hidden > 0 ? text.slice(0, cut) : text
  const parts = shown.split(/(```[\s\S]*?```)/g).filter(Boolean)
  return (
    <View>
      {parts.map((part, index) => {
        const fenced = part.startsWith('```') && part.endsWith('```')
        if (!fenced) {
          return (
            <Text key={index} style={[styles.bodyText, { color: tint }]} selectable>
              {part}
            </Text>
          )
        }
        const code = part.slice(3, -3).replace(/^[^\n]*\n/, '')
        return (
          <ScrollView key={index} horizontal style={styles.codeScroll}>
            <Text style={styles.code} selectable>
              {code}
            </Text>
          </ScrollView>
        )
      })}
      {hidden > 0 ? (
        <Pressable onPress={() => setExpanded(true)}>
          <Text style={styles.moreButton}>
            Show the rest ({hidden.toLocaleString()} more characters)
          </Text>
        </Pressable>
      ) : null}
    </View>
  )
}

function Collapsible({
  title,
  text,
  subtitle,
  icon: Icon,
  error = false,
  expandable = true,
  children
}: {
  title: string
  text?: string
  subtitle?: string
  icon: LucideIcon
  error?: boolean
  expandable?: boolean
  children?: React.ReactNode
}): React.JSX.Element {
  const theme = useTheme()
  const styles = useThemedStyles(makeStyles)
  const [open, setOpen] = useState(false)
  const Chevron = open ? ChevronDown : ChevronRight
  const tint = error ? theme.danger : theme.textFaint
  const head = (
    <>
      <View style={styles.cardHead}>
        <Icon size={13} color={tint} />
        <Text style={[styles.cardTitle, error && styles.errorText]} numberOfLines={1}>
          {title}
        </Text>
        {expandable ? <Chevron size={14} color={theme.textFaint} /> : null}
      </View>
      {!open && subtitle ? (
        <Text style={[styles.cardSubtitle, error && styles.errorText]} numberOfLines={1}>
          {subtitle}
        </Text>
      ) : null}
    </>
  )
  // 펼칠 것이 없으면 셰브런도 탭도 주지 않는다. 눌렀는데 아무 일도 일어나지 않는 카드보다
  // 한 줄로 끝나는 편이 정직하고, 결과가 도착하면 그때 펼칠 수 있는 카드가 된다.
  if (!expandable) return <View style={styles.compactCard}>{head}</View>
  return (
    <Pressable
      style={styles.compactCard}
      onPress={(event) => {
        event.stopPropagation()
        setOpen((value) => !value)
      }}
    >
      {head}
      {open
        ? children ?? <RichText text={text ?? ''} color={error ? theme.danger : theme.textMuted} />
        : null}
    </Pressable>
  )
}

function ToolCard({ card }: { card: ToolCardModel }): React.JSX.Element {
  const theme = useTheme()
  const styles = useThemedStyles(makeStyles)
  return (
    <Collapsible
      icon={card.use ? Wrench : CornerDownRight}
      title={card.title}
      subtitle={card.subtitle}
      error={card.error}
      expandable={card.body !== undefined}
    >
      {card.body ? (
        <RichText text={card.body} color={card.error ? theme.danger : theme.textMuted} />
      ) : null}
      {card.omittedLines > 0 ? (
        <Text style={styles.truncated}>Output truncated · {card.omittedLines} lines omitted</Text>
      ) : null}
    </Collapsible>
  )
}

function SheetRow({
  icon: Icon,
  label,
  onPress
}: {
  icon: LucideIcon
  label: string
  onPress: () => void
}): React.JSX.Element {
  const theme = useTheme()
  const styles = useThemedStyles(makeStyles)
  return (
    <Pressable style={styles.sheetRow} onPress={onPress}>
      <Icon color={theme.textMuted} size={17} />
      <Text style={styles.sheetLabel}>{label}</Text>
    </Pressable>
  )
}

/** 보내기 전 컴포저에 얹힌 첨부 하나. 이미지는 썸네일로, 나머지는 이름으로 보여 준다. */
function AttachmentChip({
  attachment,
  disabled,
  onRemove
}: {
  attachment: PendingAttachment
  disabled: boolean
  onRemove: () => void
}): React.JSX.Element {
  const theme = useTheme()
  const styles = useThemedStyles(makeStyles)
  return (
    <View style={styles.chip}>
      {attachment.previewUri !== undefined ? (
        <Image source={{ uri: attachment.previewUri }} style={styles.chipThumb} />
      ) : (
        <View style={styles.chipThumb}>
          <FileText color={theme.textMuted} size={16} />
        </View>
      )}
      <View style={styles.chipText}>
        <Text style={styles.chipName} numberOfLines={1}>
          {attachment.name}
        </Text>
        <Text style={styles.chipSize}>{Math.max(1, Math.round(attachment.bytes / 1024))} KB</Text>
      </View>
      <Pressable
        style={[styles.chipRemove, disabled && styles.disabled]}
        disabled={disabled}
        onPress={onRemove}
        accessibilityLabel={`Remove ${attachment.name}`}
      >
        <X color={theme.textMuted} size={14} />
      </Pressable>
    </View>
  )
}

/**
 * 이미 보낸 메시지에 딸린 첨부. 트랜스크립트에는 이름과 형식만 남으므로(본문은 모델에만
 * 필요하다) 데스크톱처럼 칩으로만 보여 준다.
 */
function SentAttachments({
  attachments
}: {
  attachments?: ChatAttachment[]
}): React.JSX.Element | null {
  const theme = useTheme()
  const styles = useThemedStyles(makeStyles)
  if (attachments === undefined || attachments.length === 0) return null
  return (
    <View style={styles.sentRow}>
      {attachments.map((attachment, index) => (
        <View key={`${attachment.name}-${index}`} style={styles.sentChip}>
          {isRemoteImageMediaType(attachment.mediaType) ? (
            <ImageGlyph color={theme.textMuted} size={11} />
          ) : (
            <FileText color={theme.textMuted} size={11} />
          )}
          <Text style={styles.sentName} numberOfLines={1}>
            {attachment.name}
          </Text>
        </View>
      ))}
    </View>
  )
}

function ChatRow({ row }: { row: ChatRowModel }): React.JSX.Element | null {
  const theme = useTheme()
  const styles = useThemedStyles(makeStyles)
  if (row.kind === 'tool') return <ToolCard card={row.card} />
  if (row.kind === 'tool-group') {
    return (
      <Collapsible icon={Wrench} title={formatToolGroup(row.group)} subtitle={row.group.latestHint}>
        <View style={styles.groupBody}>
          {row.cards.map((card) => (
            <ToolCard key={card.use?.id ?? card.result?.id} card={card} />
          ))}
        </View>
      </Collapsible>
    )
  }
  const item = row.item
  switch (item.type) {
    case 'user':
      return (
        <View style={[styles.message, styles.userMessage]}>
          <Text style={styles.label}>YOU</Text>
          <RichText text={item.text} />
          <SentAttachments attachments={item.attachments} />
        </View>
      )
    case 'assistant':
      return (
        <View style={styles.message}>
          <Text style={styles.label}>AGENT{item.streaming ? ' · WRITING' : ''}</Text>
          <RichText text={item.text} />
        </View>
      )
    case 'thinking':
      if (!item.text.trim()) return null
      return (
        <Collapsible
          icon={Brain}
          title={item.streaming ? 'Thinking…' : 'Thinking'}
          text={item.text}
        />
      )
    case 'result':
      return (
        <Text style={[styles.footer, item.isError && styles.errorText]}>
          {item.subtype} · {(item.durationMs / 1000).toFixed(1)}s · {item.numTurns} turns
        </Text>
      )
    case 'error':
      return (
        <View style={styles.errorCard}>
          <RichText text={item.text} color={theme.dangerFg} />
        </View>
      )
    case 'system':
      return (
        <View style={styles.compactCard}>
          <RichText text={item.text} color={theme.textDim} />
        </View>
      )
    case 'unknown':
      return (
        <Collapsible
          icon={CircleDashed}
          title={`Unsupported ${item.backend} item`}
          text={`${item.what}${item.hint ? `\n${item.hint}` : ''}`}
        />
      )
    case 'bash':
      return (
        <Collapsible
          icon={Terminal}
          title={`${item.running ? 'Running' : 'Command'} · ${item.command}`}
          text={item.output || 'No output'}
          error={item.exitCode !== null && item.exitCode !== 0}
        />
      )
    case 'task':
      return (
        <Collapsible
          icon={ListTodo}
          title={`${item.name} · ${item.status}`}
          text={item.summary ?? item.description}
          error={item.status === 'failed'}
        />
      )
    case 'handoff':
      return (
        <Collapsible
          icon={ArrowRightLeft}
          title={`Handoff · ${item.childName}`}
          text={item.summary}
          error={item.status === 'blocked'}
        />
      )
    case 'compaction':
      return (
        <Text style={styles.footer}>
          Conversation compacted{item.trigger === 'auto' ? ' automatically' : ''}
        </Text>
      )
    default:
      // 랩탑이 더 새 버전이면 이 앱이 모르는 종류가 온다. 조용히 버리면 대화에 구멍이 난
      // 것을 사용자가 알 방법이 없으므로, 자리만이라도 남긴다 — 데스크톱의 'unknown' 카드가
      // 같은 이유로 존재한다.
      return (
        <Text style={styles.footer}>Unsupported item — open this workspace on your computer</Text>
      )
  }
}

export default function WorkspaceScreen(): React.JSX.Element {
  const theme = useTheme()
  const styles = useThemedStyles(makeStyles)
  const prColors = usePrColors()
  const params = useLocalSearchParams<{ id: string }>()
  const workspaceId = Array.isArray(params.id) ? params.id[0] : params.id
  const router = useRouter()
  const command = useRemoteStore((store) => store.command)
  const status = useRemoteStore((store) => store.status)
  const activityRev = useRemoteStore((store) => store.activityRev)
  const workspace = useRemoteStore((store) =>
    store.state?.workspaces.find((item) => item.id === workspaceId)
  )
  const authenticate = useDeviceAuthentication()
  const laptopSeenAt = useRemoteStore((store) => store.laptopSeenAt)
  const now = useNow()
  const laptopAway = isLaptopAway(laptopSeenAt, now)
  const permission = useRemoteStore((store) => {
    const pending = store.state?.pendingPermissions.find(
      (item) => isPermissionRequest(item) && item.workspaceId === workspaceId
    )
    return isPermissionRequest(pending) ? pending : undefined
  })
  const [items, setItems] = useState<ChatItem[]>([])
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [picking, setPicking] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [uploaded, setUploaded] = useState<{ done: number; total: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [hasOlder, setHasOlder] = useState(true)
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rows = useMemo(() => buildChatRows(items), [items])
  const refreshing = useRef(false)
  const focused = useRef(false)

  const mergeItems = useCallback((next: ChatItem[]): void => {
    setItems((current) => {
      const merged = new Map(current.map((item) => [item.id, item]))
      for (const item of next) merged.set(item.id, item)
      return [...merged.values()].sort((left, right) => right.ts - left.ts)
    })
  }, [])

  const loadLatest = useCallback(async (): Promise<void> => {
    if (command === null || workspaceId === undefined || refreshing.current) return
    refreshing.current = true
    try {
      const page = parseTranscript(
        await command('remote:transcript', [workspaceId, { limit: PAGE_SIZE }])
      )
      mergeItems(page)
      // **개수로 판단하지 않는다.** 랩탑은 한 봉투에 들어가는 만큼만 담아 보내므로, 큰
      // 메시지가 섞이면 요청한 100개보다 훨씬 적게 온다 — 그걸 "더 없음"으로 읽으면
      // 위로 당겨 읽는 길이 막힌다. 빈 페이지가 올 때에만 끝으로 본다.
      setHasOlder(page.length > 0)
      setError(null)
    } catch (loadError) {
      setError(errorMessage(loadError))
    } finally {
      refreshing.current = false
      setLoading(false)
    }
  }, [command, mergeItems, workspaceId])

  useFocusEffect(
    useCallback(() => {
      if (command === null || workspaceId === undefined) return undefined
      focused.current = true
      void command('remote:watch', [workspaceId]).catch((watchError: unknown) => {
        setError(errorMessage(watchError))
      })
      void loadLatest()
      const watchTimer = setInterval(() => {
        void command('remote:watch', [workspaceId]).catch(() => undefined)
      }, WATCH_REFRESH_MS)
      return () => {
        focused.current = false
        clearInterval(watchTimer)
        // 해제 결과를 기다리느라 화면 전환을 막지 않는다.
        void command('remote:watch', [null]).catch(() => undefined)
      }
    }, [command, loadLatest, workspaceId])
  )

  useEffect(() => {
    if (focused.current && activityRev > 0) void loadLatest()
  }, [activityRev, loadLatest])

  const loadOlder = useCallback(async (): Promise<void> => {
    if (command === null || workspaceId === undefined || loadingOlder || !hasOlder) return
    const oldest = items.reduce((minimum, item) => Math.min(minimum, item.ts), Infinity)
    if (!Number.isFinite(oldest)) return
    setLoadingOlder(true)
    try {
      const page = parseTranscript(
        await command('remote:transcript', [workspaceId, { beforeTs: oldest, limit: PAGE_SIZE }])
      )
      mergeItems(page)
      setHasOlder(page.length > 0)
    } catch (loadError) {
      setError(errorMessage(loadError))
    } finally {
      setLoadingOlder(false)
    }
  }, [command, hasOlder, items, loadingOlder, mergeItems, workspaceId])

  /**
   * 고른 첨부를 예산 안에서만 받는다. 넘치는 것은 **조용히 버리지 않고** 말해 준다 —
   * 보냈다고 믿은 첨부가 빠지는 것이 아예 못 붙이는 것보다 나쁘다.
   */
  const addAttachments = useCallback(
    (picked: PendingAttachment[]): void => {
      if (picked.length === 0) return
      const accepted: PendingAttachment[] = []
      let bytes = attachments.reduce((sum, item) => sum + item.bytes, 0)
      let dropped = 0
      for (const item of picked) {
        const full = attachments.length + accepted.length >= REMOTE_MAX_ATTACHMENTS
        if (full || bytes + item.bytes > REMOTE_MAX_ATTACHMENT_TOTAL_BYTES) {
          dropped += 1
          continue
        }
        accepted.push(item)
        bytes += item.bytes
      }
      if (accepted.length > 0) setAttachments([...attachments, ...accepted])
      if (dropped > 0) {
        setError(
          `${dropped} attachment${dropped === 1 ? '' : 's'} didn't fit — a message can carry ${REMOTE_MAX_ATTACHMENTS} files and ${Math.round(REMOTE_MAX_ATTACHMENT_TOTAL_BYTES / 1024)} KB in total.`
        )
      }
    },
    [attachments]
  )

  const runPicker = useCallback(
    async (pick: () => Promise<PendingAttachment[]>): Promise<void> => {
      setPicking(true)
      try {
        addAttachments(await pick())
      } catch (pickError) {
        setError(
          pickError instanceof AttachmentError ? pickError.message : errorMessage(pickError)
        )
      } finally {
        setPicking(false)
      }
    },
    [addAttachments]
  )

  /**
   * 첨부 메뉴를 연다. `Alert` 를 쓰지 않는 이유는 **안드로이드가 버튼을 세 개까지만** 그리기
   * 때문이다 — 보관함·카메라·파일에 취소까지 네 개라 한 항목이 조용히 사라진다.
   */
  const attach = useCallback((): void => {
    if (attachments.length >= REMOTE_MAX_ATTACHMENTS) {
      setError(`A message can carry ${REMOTE_MAX_ATTACHMENTS} attachments.`)
      return
    }
    Keyboard.dismiss()
    setMenuOpen(true)
  }, [attachments.length])

  const chooseSource = useCallback(
    (source: 'library' | 'camera' | 'files'): void => {
      setMenuOpen(false)
      const remaining = REMOTE_MAX_ATTACHMENTS - attachments.length
      if (remaining <= 0) return
      void runPicker(() =>
        source === 'library'
          ? pickImages(remaining)
          : source === 'camera'
            ? pickCameraPhoto()
            : pickDocuments(remaining)
      )
    },
    [attachments.length, runPicker]
  )

  const send = useCallback(async (): Promise<void> => {
    const prompt = text.trim()
    if (command === null || workspaceId === undefined || sending) return
    if (prompt.length === 0 && attachments.length === 0) return
    if (new TextEncoder().encode(prompt).length > MAX_PROMPT_BYTES) {
      setError('Message is too large. Keep it under 32 KiB.')
      return
    }
    // 에이전트가 묻지 않고 실행하는 모드에서는 프롬프트 하나가 곧 임의 실행이므로 여기서
    // 막는다. 묻는 모드라면 위험한 일이 전부 권한 프롬프트에 걸리고 그건 이미 인증으로
    // 막혀 있으니, 여기서 또 묻는 것은 마찰만 늘리고 아무것도 더 지키지 못한다.
    if (workspace?.actsWithoutAsking === true) {
      if (!(await authenticate('Send this to your computer'))) {
        setError('Device authentication was cancelled or unsuccessful. Nothing was sent.')
        return
      }
    }
    setSending(true)
    setError(null)
    try {
      // 첨부 본문은 명령 하나에 들어가지 않아 조각으로 먼저 올라간다. 조각은 결과를 기다리지
      // 않고 **순서대로 꽂아만 둔다** — 랩탑이 넣은 순서대로 처리하므로 아래 chat:send 보다
      // 반드시 먼저 도착하고, 빠진 조각은 그 chat:send 의 오류로 한 번에 드러난다.
      if (attachments.length > 0) {
        const plan = attachments.map((item) => ({ item, chunks: chunkBase64(item.base64) }))
        const total = plan.reduce((sum, entry) => sum + entry.chunks.length, 0)
        let done = 0
        setUploaded({ done, total })
        for (const { item, chunks } of plan) {
          for (const [index, chunk] of chunks.entries()) {
            await command('remote:upload', [item.id, index, chunks.length, chunk], {
              awaitResult: false
            })
            done += 1
            setUploaded({ done, total })
          }
        }
      }
      // 첨부가 없으면 인자를 두 개만 보낸다 — 첨부를 모르는 옛 랩탑은 인자 수부터 거절한다.
      await command(
        'chat:send',
        attachments.length === 0
          ? [workspaceId, prompt]
          : [
              workspaceId,
              prompt,
              attachments.map(({ id, name, mediaType }) => ({ uploadId: id, name, mediaType }))
            ]
      )
      setText('')
      setAttachments([])
      await loadLatest()
    } catch (sendError) {
      setError(
        attachments.length > 0
          ? `${errorMessage(sendError)} If your computer runs an older Wooi, update it — attachments need a newer desktop app.`
          : errorMessage(sendError)
      )
    } finally {
      setUploaded(null)
      setSending(false)
    }
  }, [attachments, authenticate, command, loadLatest, sending, text, workspace, workspaceId])

  const stop = useCallback(async (): Promise<void> => {
    if (command === null || workspaceId === undefined || stopping) return
    setStopping(true)
    setError(null)
    try {
      await command('chat:interrupt', [workspaceId])
    } catch (stopError) {
      setError(errorMessage(stopError))
    } finally {
      setStopping(false)
    }
  }, [command, stopping, workspaceId])

  // 이름 규칙은 데스크톱과 같은 함수에서 나온다 — 사용자 지정 이름이 없으면 PR 제목,
  // 그것도 없으면 worktree 이름. PR 제목은 랩탑이 투영에 실어 보낸다(mirror 의 projectPr).
  const title = useMemo(
    () =>
      workspace === undefined
        ? 'Workspace'
        : workspaceDisplayName(workspace, workspace.pr?.title),
    [workspace]
  )

  const modeFooter = workspace?.permissionModeFooter ?? null
  const statusLine = workspace?.statusLine ?? null

  const repoName = useRemoteStore(
    (store) => store.state?.repos.find((repo) => repo.id === workspace?.repoId)?.name ?? null
  )

  /**
   * 헤더 한 줄에 담는 것들. 데스크톱 사이드바가 행에 보여 주는 것과 같은 성격이되, 여기서는
   * "지금 이 워크스페이스가 무엇으로 어떻게 돌고 있나"에 답하는 것만 남긴다 —
   * 권한 모드는 전송 시 인증 여부까지 가르므로 특히 보여야 한다.
   */
  const headerMeta = useMemo(() => {
    if (workspace === undefined) return status
    // 에이전트도 팀 여부도 이제 마크로 보여 준다(데스크톱과 같은 그림) — 여기서는 글자를 빼고
    // 마크가 답하지 못하는 것만 남긴다.
    // 폰 헤더는 한 줄이다. 모델 이름까지 넣으면 브랜치가 잘리는데, 지금 어느 브랜치를 보고
    // 있는지가 어느 모델인지보다 훨씬 자주 필요하다.
    return workspace.branch
  }, [status, workspace])

  const limitLabel = useMemo(() => {
    const limit = workspace?.rateLimit ?? null
    if (limit === null) return null
    const when = limit.at === null ? null : untilLabel(limit.at, now)
    if (limit.kind === 'resuming') {
      return when === null ? 'rate limit' : `rate limit · resumes in ${when}`
    }
    return when === null ? 'rate limit' : `rate limit · resets in ${when}`
  }, [now, workspace])

  const insets = useSafeAreaInsets()
  // 키보드가 올라오면 그 높이만큼, 아니면 하단 안전영역만큼 띄운다. SafeAreaView 의 bottom
  // edge 와 동시에 쓰면 둘이 더해져 어긋나므로 여기서만 관리한다.
  const keyboard = useKeyboardInset()
  const keyboardInset = keyboard > 0 ? keyboard : insets.bottom

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={[styles.screen, { paddingBottom: keyboardInset }]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <Text style={styles.back}>‹ Back</Text>
          </Pressable>
          <View style={styles.headerTitle}>
            {/* 목록에서 보던 정보를 그대로 가져온다. 워크스페이스에 들어온 순간 어느 리포의
                무엇을 보고 있는지 모르게 되면, 폰에서는 되돌아가 확인하는 비용이 크다. */}
            {repoName !== null ? (
              <Text style={styles.headerRepo} numberOfLines={1}>
                {repoName}
              </Text>
            ) : null}
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
            <View style={styles.headerMetaLine}>
              <BrandMark backend={workspace?.agentBackend} size={10} />
              {/* 팀이면 마크 옆에 사람 아이콘 하나 — 목록 행·데스크톱 사이드바와 같은 표기다. */}
              {workspace?.multiAgent ? (
                <View accessible accessibilityLabel="Agent team">
                  <Users size={11} color={theme.accent} />
                </View>
              ) : null}
              <Text style={styles.headerMeta} numberOfLines={1}>
                {headerMeta}
              </Text>
            </View>
            {/* PR 줄은 화면으로 가는 문이다 — 라벨 한 줄은 무엇이 막고 있는지 말하지 못하고,
                그걸 확인하러 랩탑으로 돌아가는 비용이 폰에서는 크다. 이미 PR 을 말하고 있는
                줄에 붙이므로 새 어포던스를 하나 더 만들지 않는다. */}
            {workspace?.pr ? (
              <Pressable
                accessibilityHint="Shows CI checks for this pull request"
                accessibilityLabel={`Pull request #${workspace.pr.number}, ${workspace.pr.label}`}
                accessibilityRole="button"
                hitSlop={8}
                onPress={() => router.push(`/workspace/${workspaceId}/pr`)}
                style={({ pressed }) => [styles.headerPrRow, pressed && styles.headerPrPressed]}
              >
                <Text
                  style={[styles.headerPr, { color: prColors[workspace.pr.state] ?? theme.textDim }]}
                  numberOfLines={1}
                >
                  #{workspace.pr.number} · {workspace.pr.label}
                </Text>
                <ChevronRight
                  color={prColors[workspace.pr.state] ?? theme.textDim}
                  size={12}
                  strokeWidth={2.2}
                />
              </Pressable>
            ) : null}
            {limitLabel !== null ? (
              <Text style={styles.headerLimit} numberOfLines={1}>
                {limitLabel}
              </Text>
            ) : null}
          </View>
          {workspace?.status === 'running' ? (
            <Pressable style={styles.stopButton} disabled={stopping} onPress={() => void stop()}>
              <Text style={styles.stopText}>{stopping ? 'Stopping…' : 'Stop'}</Text>
            </Pressable>
          ) : (
            <View style={styles.headerSpacer} />
          )}
        </View>
        <DemoBanner />
        {/* 두 가지는 다른 문제다: 내 신호가 안 나가는 것과, 받을 상대가 없는 것. */}
        {status === 'offline' ? (
          <Text style={styles.offline}>
            This phone is not connected. Anything you send is queued until it reconnects.
          </Text>
        ) : laptopAway && laptopSeenAt !== null ? (
          <Text style={styles.offline}>
            Your laptop is asleep or offline — last seen {agoLabel(laptopSeenAt, now)}. Anything you
            send will run when it wakes.
          </Text>
        ) : null}
        {error ? <Text style={styles.errorBanner}>{error}</Text> : null}
        <FlatList
          inverted
          data={rows}
          keyExtractor={(row) => row.id}
          renderItem={({ item: row }) => <ChatRow row={row} />}
          contentContainerStyle={styles.list}
          onEndReached={() => void loadOlder()}
          onEndReachedThreshold={0.3}
          ListFooterComponent={loadingOlder ? <ActivityIndicator color={theme.accent} /> : null}
          ListEmptyComponent={
            loading ? (
              <ActivityIndicator style={styles.loading} color={theme.accent} />
            ) : (
              <Text style={styles.empty}>No conversation yet</Text>
            )
          }
        />
        {/* 답을 받아야 하는 질문(AskUserQuestion)은 Allow/Deny 가 아니라 선택지 UI 로 분기한다 —
            데스크톱 ChatView 와 같은 갈림이다. 승인해 봐야 답이 비면 모델은 그냥 진행한다. */}
        {permission !== undefined && command !== null ? (
          isQuestionRequest(permission) ? (
            <QuestionCard
              key={permission.requestId}
              request={permission}
              command={command}
              actsWithoutAsking={workspace?.actsWithoutAsking === true}
            />
          ) : (
            <PermissionCard key={permission.requestId} request={permission} command={command} />
          )
        ) : null}
        {/* 데스크톱과 같은 순서다 — 상태줄은 입력창 위, 권한 모드는 입력창 아래.
            무엇을 보내려는 순간에 "어떤 모델로, 얼마나 생각하며, 얼마나 남은 맥락으로,
            그리고 물어보긴 하는지"가 한눈에 들어와야 한다.

            셋을 한 블록으로 묶고 경계선은 바깥에 둔다 — 선이 입력창에 붙어 있으면 상태줄이
            대화 쪽에 딸린 것처럼 읽히고, 상태줄을 못 받는 옛 랩탑에서는 선이 통째로 사라진다. */}
        <View style={styles.dock}>
          <WorkspaceStatusBar status={statusLine} />
          {attachments.length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.trayRow}
              style={styles.tray}
            >
              {attachments.map((attachment) => (
                <AttachmentChip
                  key={attachment.id}
                  attachment={attachment}
                  disabled={sending}
                  onRemove={() =>
                    setAttachments((current) =>
                      current.filter((item) => item.id !== attachment.id)
                    )
                  }
                />
              ))}
            </ScrollView>
          ) : null}
          <View style={styles.composer}>
            <Pressable
              style={[styles.attachButton, (sending || picking) && styles.disabled]}
              disabled={sending || picking}
              onPress={attach}
              accessibilityLabel="Attach a photo or file"
            >
              {picking ? (
                <ActivityIndicator color={theme.textMuted} size="small" />
              ) : (
                <Paperclip color={theme.textMuted} size={18} />
              )}
            </Pressable>
            <TextInput
              style={styles.input}
              value={text}
              onChangeText={setText}
              editable={!sending}
              multiline
              maxLength={32 * 1024}
              placeholder="Follow up…"
              placeholderTextColor={theme.textFaint}
            />
            <Pressable
              style={[
                styles.sendButton,
                (sending || (text.trim().length === 0 && attachments.length === 0)) &&
                  styles.disabled
              ]}
              disabled={sending || (text.trim().length === 0 && attachments.length === 0)}
              onPress={() => void send()}
            >
              <Text style={styles.sendText}>
                {uploaded !== null
                  ? `${Math.round((uploaded.done / Math.max(1, uploaded.total)) * 100)}%`
                  : sending
                    ? 'Sending…'
                    : 'Send'}
              </Text>
            </Pressable>
          </View>
          {/* 띄울 것이 없는 모드(Claude 의 'default')에서는 데스크톱처럼 아무것도 띄우지 않는다. */}
          {modeFooter !== null && modeFooter !== undefined ? (
            <PermissionModeFooter footer={modeFooter} />
          ) : null}
        </View>
        {/* 네이티브 Modal 이 아니라 화면 안의 겹침이다 — iOS 에서 모달이 닫히는 도중에 사진
            선택기를 띄우면 표시 자체가 실패한다. 겹침에는 그 타이밍 문제가 없다. */}
        {menuOpen ? (
          <Pressable style={styles.sheetBackdrop} onPress={() => setMenuOpen(false)}>
            <View style={styles.sheet}>
              <SheetRow
                icon={Images}
                label="Photo library"
                onPress={() => chooseSource('library')}
              />
              <SheetRow icon={Camera} label="Take a photo" onPress={() => chooseSource('camera')} />
              <SheetRow icon={FolderOpen} label="Files" onPress={() => chooseSource('files')} />
            </View>
          </Pressable>
        ) : null}
      </View>
    </SafeAreaView>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { backgroundColor: theme.bg, flex: 1 },
    header: {
      alignItems: 'flex-start',
      borderBottomColor: theme.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      minHeight: 54,
      paddingBottom: 10,
      paddingHorizontal: 14,
      paddingTop: 8
    },
    back: { color: theme.accent, fontSize: 15, marginTop: 13, width: 68 },
    headerTitle: { alignItems: 'center', flex: 1 },
    headerRepo: { color: theme.textDim, fontSize: 10, fontWeight: '700', letterSpacing: 0.8 },
    headerMetaLine: { alignItems: 'center', flexDirection: 'row', gap: 5, marginTop: 2 },
    headerMeta: { color: theme.textDim, fontSize: 11 },
    headerPrRow: { alignItems: 'center', flexDirection: 'row', gap: 2 },
    headerPr: { fontSize: 11, marginTop: 2 },
    headerPrPressed: { opacity: 0.55 },
    headerLimit: { color: theme.warningFg, fontSize: 11, marginTop: 2 },
    title: { color: theme.text, fontSize: 15, fontWeight: '600', maxWidth: '100%' },
    connection: { color: theme.textDim, fontSize: 10, marginTop: 2, textTransform: 'capitalize' },
    headerSpacer: { width: 68 },
    stopButton: {
      alignItems: 'center',
      borderColor: theme.dangerBorder,
      borderRadius: 6,
      borderWidth: 1,
      marginTop: 9,
      paddingVertical: 6,
      width: 68
    },
    stopText: { color: theme.danger, fontSize: 12, fontWeight: '600' },
    offline: {
      backgroundColor: theme.border,
      color: theme.textMuted,
      fontSize: 11,
      lineHeight: 16,
      paddingHorizontal: 14,
      paddingVertical: 7
    },
    errorBanner: {
      backgroundColor: theme.dangerSurface,
      color: theme.dangerFg,
      fontSize: 12,
      lineHeight: 17,
      paddingHorizontal: 14,
      paddingVertical: 8
    },
    list: { paddingHorizontal: 14, paddingVertical: 12 },
    message: {
      borderBottomColor: theme.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      paddingVertical: 14
    },
    userMessage: {
      backgroundColor: theme.surface,
      borderRadius: 7,
      marginVertical: 5,
      paddingHorizontal: 11
    },
    label: {
      color: theme.textDim,
      fontSize: 9,
      fontWeight: '700',
      letterSpacing: 1,
      marginBottom: 6
    },
    bodyText: { fontSize: 14, lineHeight: 21 },
    moreButton: {
      color: theme.accent,
      fontSize: 12,
      fontWeight: '600',
      paddingVertical: 8
    },
    compactCard: {
      backgroundColor: theme.bg2,
      borderColor: theme.border,
      borderRadius: 6,
      borderWidth: StyleSheet.hairlineWidth,
      marginVertical: 3,
      paddingHorizontal: 10,
      paddingVertical: 7
    },
    cardHead: { alignItems: 'center', flexDirection: 'row', gap: 8 },
    cardTitle: { color: theme.textDim, flex: 1, fontSize: 12, fontWeight: '600' },
    cardSubtitle: { color: theme.textFaint, fontSize: 11, marginLeft: 21, marginTop: 4 },
    groupBody: { marginTop: 4 },
    truncated: { color: theme.textFaint, fontSize: 10, marginTop: 6 },
    codeScroll: { backgroundColor: theme.bg, borderRadius: 5, marginVertical: 7, padding: 10 },
    code: {
      color: theme.textMuted,
      fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
      fontSize: 12,
      lineHeight: 18
    },
    footer: {
      borderBottomColor: theme.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      color: theme.textDim,
      fontSize: 10,
      paddingVertical: 7,
      textAlign: 'center'
    },
    errorText: { color: theme.dangerFg },
    errorCard: {
      backgroundColor: theme.dangerSurface,
      borderColor: theme.dangerBorder,
      borderRadius: 6,
      borderWidth: 1,
      marginVertical: 4,
      padding: 10
    },
    loading: { paddingVertical: 40 },
    empty: { color: theme.textDim, paddingVertical: 40, textAlign: 'center' },
    permissionCard: {
      backgroundColor: theme.surface,
      borderColor: theme.accentStrong,
      borderTopWidth: 2,
      padding: 12
    },
    permissionHeading: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between'
    },
    permissionEyebrow: { color: theme.accent, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
    permissionTitle: {
      color: theme.text,
      fontSize: 15,
      fontWeight: '600',
      lineHeight: 20,
      marginTop: 7
    },
    permissionTool: { color: theme.textDim, fontSize: 11, marginTop: 3 },
    permissionSubstance: {
      backgroundColor: theme.bg,
      borderColor: theme.surface2,
      borderRadius: 5,
      borderWidth: 1,
      marginTop: 9,
      maxHeight: 150
    },
    permissionTextScroll: { maxHeight: 145, padding: 9 },
    permissionCodeScroll: { maxHeight: 145, paddingVertical: 7 },
    permissionCode: {
      color: theme.textMuted,
      fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
      fontSize: 11,
      lineHeight: 17
    },
    diffLine: { paddingHorizontal: 9 },
    diffAdded: { backgroundColor: theme.diffAddSurface },
    diffRemoved: { backgroundColor: theme.diffRemoveSurface },
    permissionError: { color: theme.dangerFg, fontSize: 11, lineHeight: 15, marginTop: 8 },
    permissionScope: { color: theme.textFaint, fontSize: 11, lineHeight: 15, marginTop: 10 },
    permissionActions: { flexDirection: 'row', gap: 8, marginTop: 8 },
    permissionButton: {
      alignItems: 'center',
      borderColor: theme.border2,
      borderRadius: 8,
      borderWidth: 1,
      flex: 1,
      justifyContent: 'center',
      minHeight: 44,
      paddingHorizontal: 5
    },
    denyButtonText: { color: theme.textMuted, fontSize: 12, fontWeight: '600', textAlign: 'center' },
    sessionButton: { borderColor: theme.warningBorder },
    sessionButtonText: { color: theme.warningFg, fontSize: 12, fontWeight: '600', textAlign: 'center' },
    allowButton: { backgroundColor: theme.warning, borderColor: theme.warning },
    allowButtonText: { color: theme.onWarning, fontSize: 13, fontWeight: '700', textAlign: 'center' },
    ruleBox: {
      backgroundColor: theme.bg3,
      borderRadius: 4,
      marginTop: 8,
      paddingHorizontal: 8,
      paddingVertical: 6
    },
    ruleLabel: { color: theme.textDim, fontSize: 8, fontWeight: '700', letterSpacing: 0.8 },
    permissionRule: {
      color: theme.textMuted,
      fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
      fontSize: 10,
      marginTop: 3
    },
    dock: {
      borderTopColor: theme.border,
      borderTopWidth: StyleSheet.hairlineWidth,
      paddingTop: 8
    },
    composer: {
      alignItems: 'flex-end',
      flexDirection: 'row',
      gap: 9,
      paddingBottom: 10,
      paddingHorizontal: 10
    },
    attachButton: {
      alignItems: 'center',
      backgroundColor: theme.bg2,
      borderColor: theme.surface2,
      borderRadius: 8,
      borderWidth: 1,
      height: 42,
      justifyContent: 'center',
      width: 40
    },
    sheetBackdrop: {
      // 스크림은 테마 토큰을 쓰지 않는다 — 라이트에서도 시트를 띄우는 것은 검은 반투명이다.
      backgroundColor: 'rgba(0, 0, 0, 0.45)',
      bottom: 0,
      justifyContent: 'flex-end',
      left: 0,
      padding: 14,
      position: 'absolute',
      right: 0,
      top: 0,
      zIndex: 10
    },
    sheet: {
      backgroundColor: theme.bg2,
      borderColor: theme.border,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      overflow: 'hidden'
    },
    sheetRow: {
      alignItems: 'center',
      borderBottomColor: theme.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: 11,
      paddingHorizontal: 16,
      paddingVertical: 15
    },
    sheetLabel: { color: theme.text, fontSize: 15 },
    tray: { maxHeight: 60 },
    trayRow: { gap: 8, paddingBottom: 8, paddingHorizontal: 10 },
    chip: {
      alignItems: 'center',
      backgroundColor: theme.bg2,
      borderColor: theme.surface2,
      borderRadius: 8,
      borderWidth: 1,
      flexDirection: 'row',
      gap: 7,
      maxWidth: 210,
      paddingLeft: 4,
      paddingRight: 6,
      paddingVertical: 4
    },
    chipThumb: {
      alignItems: 'center',
      backgroundColor: theme.bg3,
      borderRadius: 5,
      height: 30,
      justifyContent: 'center',
      width: 30
    },
    chipText: { flexShrink: 1 },
    chipName: { color: theme.text, fontSize: 11, fontWeight: '600' },
    chipSize: { color: theme.textFaint, fontSize: 9, marginTop: 1 },
    chipRemove: { alignItems: 'center', height: 22, justifyContent: 'center', width: 22 },
    sentRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
    sentChip: {
      alignItems: 'center',
      backgroundColor: theme.bg3,
      borderRadius: 4,
      flexDirection: 'row',
      gap: 4,
      maxWidth: 200,
      paddingHorizontal: 6,
      paddingVertical: 3
    },
    sentName: { color: theme.textMuted, fontSize: 10, flexShrink: 1 },
    input: {
      backgroundColor: theme.bg2,
      borderColor: theme.surface2,
      borderRadius: 8,
      borderWidth: 1,
      color: theme.text,
      flex: 1,
      fontSize: 14,
      maxHeight: 120,
      minHeight: 42,
      paddingHorizontal: 11,
      paddingVertical: 10
    },
    sendButton: {
      backgroundColor: theme.accentStrong,
      borderRadius: 7,
      justifyContent: 'center',
      minHeight: 42,
      paddingHorizontal: 14
    },
    sendText: { color: theme.onAccentStrong, fontSize: 13, fontWeight: '700' },
    disabled: { opacity: 0.45 }
  })
