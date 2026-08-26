import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Dimensions,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent
} from 'react-native'
import {
  ArrowRightLeft,
  ArrowUp,
  Brain,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  CornerDownRight,
  ListTodo,
  Square,
  Terminal,
  Users,
  Wrench,
  type LucideIcon
} from 'lucide-react-native'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import type { ChatItem, PermissionRequest } from '@shared/types'
import { workspaceDisplayName } from '@shared/types'
import { formatToolGroup } from '@shared/toolGroups'
import { BrandMark } from '../../../src/components/BrandMark'
import { DemoBanner } from '../../../src/components/DemoBanner'
import { QuestionCard } from '../../../src/components/QuestionCard'
import { PlainText, RichText } from '../../../src/components/RichText'
import {
  ActivityPill,
  PermissionModeFooter,
  WorkspaceStatusBar
} from '../../../src/components/WorkspaceStatusBar'
import { usePrColors } from '../../../src/state/prColors'
import { isLaptopAway, useRemoteStore } from '../../../src/state/store'
import { agoLabel, untilLabel, useNow } from '../../../src/state/useNow'
import { useDeviceAuthentication } from '../../../src/state/useDeviceAuth'
import { useTheme, useThemedStyles } from '../../../src/state/theme'
import type { Theme } from '../../../src/theme'
import { activityLabel } from '../../../src/chat/activity'
import { buildChatRows, type ChatRowModel, type ToolCardModel } from '../../../src/chat/rows'
import { isPermissionRequest, isQuestionRequest } from '../../../src/chat/questions'

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

function Collapsible({
  title,
  text,
  subtitle,
  icon: Icon,
  error = false,
  expandable = true,
  markdown = false,
  children
}: {
  title: string
  text?: string
  subtitle?: string
  icon: LucideIcon
  error?: boolean
  expandable?: boolean
  /** 본문이 **모델이 쓴 말**인가(생각·요약). 도구가 뱉은 것이면 글자 그대로 둔다. */
  markdown?: boolean
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
        ? children ??
          (markdown ? (
            <RichText text={text ?? ''} color={error ? theme.danger : theme.textMuted} />
          ) : (
            <PlainText text={text ?? ''} color={error ? theme.danger : theme.textMuted} compact />
          ))
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
        <PlainText text={card.body} color={card.error ? theme.danger : theme.textMuted} compact />
      ) : null}
      {card.omittedLines > 0 ? (
        <Text style={styles.truncated}>Output truncated · {card.omittedLines} lines omitted</Text>
      ) : null}
    </Collapsible>
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
    // 내가 한 말은 오른쪽 말풍선, 에이전트가 한 말은 폭을 다 쓰는 본문. 데스크톱
    // ChatPrimitives 의 UserMessage/AgentMessage 와 같은 규칙이다 — 대문자 라벨(YOU/AGENT)로
    // 가르던 것을 형태로 옮겼다. 라벨은 줄마다 세로 자리를 먹으면서, 정작 옆에 도구 카드가
    // 섞이면 그것들과 구별되지도 않았다.
    case 'user':
      return (
        <View style={styles.userRow}>
          <View style={styles.userBubble}>
            {/* 사용자가 친 글은 마크다운으로 읽지 않는다 — 별표나 밑줄을 적었으면 적은 그대로다. */}
            <PlainText text={item.text} />
          </View>
        </View>
      )
    case 'assistant':
      return (
        <View style={styles.agentMessage}>
          <RichText text={item.text} streaming={item.streaming === true} />
        </View>
      )
    case 'thinking':
      if (!item.text.trim()) return null
      return (
        <Collapsible
          icon={Brain}
          title={item.streaming ? 'Thinking…' : 'Thinking'}
          text={item.text}
          markdown
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
          <PlainText text={item.text} color={theme.dangerFg} compact />
        </View>
      )
    case 'system':
      return (
        <View style={styles.compactCard}>
          <PlainText text={item.text} color={theme.textDim} compact />
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
          markdown
        />
      )
    case 'handoff':
      return (
        <Collapsible
          icon={ArrowRightLeft}
          title={`Handoff · ${item.childName}`}
          text={item.summary}
          error={item.status === 'blocked'}
          markdown
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
  const [loading, setLoading] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [hasOlder, setHasOlder] = useState(true)
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rows = useMemo(() => buildChatRows(items), [items])
  const activity = useMemo(
    () => activityLabel(rows, workspace?.status === 'running'),
    [rows, workspace?.status]
  )
  const refreshing = useRef(false)
  const focused = useRef(false)
  const listRef = useRef<FlatList<ChatRowModel>>(null)
  const [scrolledUp, setScrolledUp] = useState(false)

  /**
   * 얼마나 올라가야 "돌아갈 길"이 필요한가. 한 화면 남짓(320dp)으로 둔다 — 이보다 짧으면
   * 손가락 한 번으로 닿는 거리라 버튼이 오히려 본문을 가린다.
   */
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>): void => {
    setScrolledUp(event.nativeEvent.contentOffset.y > 320)
  }, [])

  // inverted 리스트라 "맨 아래"(가장 최근)가 오프셋 0 이다.
  const jumpToLatest = useCallback((): void => {
    listRef.current?.scrollToOffset({ offset: 0, animated: true })
  }, [])

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

  const send = useCallback(async (): Promise<void> => {
    const prompt = text.trim()
    if (command === null || workspaceId === undefined || prompt.length === 0 || sending) return
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
      await command('chat:send', [workspaceId, prompt])
      setText('')
      // 위로 올려 읽던 중이었다면 방금 보낸 말이 화면 밖에 남는다. 보낸 사람은 그것부터 본다.
      jumpToLatest()
      await loadLatest()
    } catch (sendError) {
      setError(errorMessage(sendError))
    } finally {
      setSending(false)
    }
  }, [authenticate, command, jumpToLatest, loadLatest, sending, text, workspace, workspaceId])

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
          {/* 제목을 가운데 두려면 왼쪽 Back 과 같은 폭이 오른쪽에도 있어야 한다. Stop 은
              컴포저로 내려갔다 — 화면 반대편 끝에 두면 멈추려고 엄지가 화면을 가로질러야 했다. */}
          <View style={styles.headerSpacer} />
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
        <View style={styles.listWrap}>
          <FlatList
            ref={listRef}
            inverted
            style={styles.listFlex}
            data={rows}
            keyExtractor={(row) => row.id}
            renderItem={({ item: row }) => <ChatRow row={row} />}
            contentContainerStyle={styles.list}
            onEndReached={() => void loadOlder()}
            onEndReachedThreshold={0.3}
            onScroll={onScroll}
            scrollEventThrottle={32}
            ListFooterComponent={loadingOlder ? <ActivityIndicator color={theme.accent} /> : null}
            ListEmptyComponent={
              loading ? (
                <ActivityIndicator style={styles.loading} color={theme.accent} />
              ) : (
                <Text style={styles.empty}>No conversation yet</Text>
              )
            }
          />
          {/* 위로 올려 읽다가 돌아오는 길. inverted 라 "맨 아래" 는 오프셋 0 이다.
              이게 없으면 돌아오는 방법이 스와이프뿐인데, 긴 대화에서는 그게 여러 번이다. */}
          {scrolledUp ? (
            <Pressable
              accessibilityLabel="Jump to the latest message"
              accessibilityRole="button"
              hitSlop={6}
              onPress={jumpToLatest}
              style={({ pressed }) => [styles.jumpButton, pressed && styles.jumpPressed]}
            >
              <ChevronDown color={theme.text} size={20} strokeWidth={2.2} />
            </Pressable>
          ) : null}
        </View>
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
          <ActivityPill label={activity} />
          <WorkspaceStatusBar status={statusLine} />
          <View style={styles.composer}>
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
            {/* Stop 은 Send 를 대신하지 않고 **옆에 선다.** 데스크톱 컴포저와 같은 규칙이다 —
                돌고 있는 동안에도 다음 할 말을 보낼 수 있어야 하는데, 한 버튼을 토글로 만들면
                폰에서만 그 길이 막힌다. */}
            {workspace?.status === 'running' ? (
              <Pressable
                accessibilityLabel="Stop the current turn"
                accessibilityRole="button"
                disabled={stopping}
                onPress={() => void stop()}
                style={({ pressed }) => [
                  styles.circleButton,
                  styles.stopButton,
                  stopping && styles.disabled,
                  pressed && styles.buttonPressed
                ]}
              >
                {stopping ? (
                  <ActivityIndicator color={theme.danger} size="small" />
                ) : (
                  <Square color={theme.danger} fill={theme.danger} size={14} />
                )}
              </Pressable>
            ) : null}
            <Pressable
              accessibilityLabel="Send"
              accessibilityRole="button"
              disabled={sending || text.trim().length === 0}
              onPress={() => void send()}
              style={({ pressed }) => [
                styles.circleButton,
                styles.sendButton,
                (sending || text.trim().length === 0) && styles.disabled,
                pressed && styles.buttonPressed
              ]}
            >
              {sending ? (
                <ActivityIndicator color={theme.onAccentStrong} size="small" />
              ) : (
                <ArrowUp color={theme.onAccentStrong} size={20} strokeWidth={2.6} />
              )}
            </Pressable>
          </View>
          {/* 띄울 것이 없는 모드(Claude 의 'default')에서는 데스크톱처럼 아무것도 띄우지 않는다. */}
          {modeFooter !== null && modeFooter !== undefined ? (
            <PermissionModeFooter footer={modeFooter} />
          ) : null}
        </View>
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
    listWrap: { flex: 1 },
    listFlex: { flex: 1 },
    list: { paddingHorizontal: 16, paddingVertical: 12 },
    // 대화 위에 뜨지만 마지막 줄을 가리지 않을 만큼만 안쪽으로. 44dp 는 손가락 최소 크기다.
    jumpButton: {
      alignItems: 'center',
      backgroundColor: theme.surface2,
      borderColor: theme.border2,
      borderRadius: 22,
      borderWidth: StyleSheet.hairlineWidth,
      bottom: 10,
      height: 44,
      justifyContent: 'center',
      position: 'absolute',
      right: 12,
      width: 44
    },
    jumpPressed: { backgroundColor: theme.surface4 },
    userRow: { alignItems: 'flex-end', marginVertical: 6 },
    // 값은 데스크톱 UserMessage 그대로다 — surface-4, rounded-2xl 에 오른쪽 아래만 작게,
    // 최대 85%. 폰이 자기 말풍선을 따로 고르면 같은 대화가 두 화면에서 다르게 보인다.
    userBubble: {
      backgroundColor: theme.surface4,
      borderBottomRightRadius: 6,
      borderRadius: 16,
      maxWidth: '85%',
      paddingHorizontal: 14,
      paddingVertical: 9
    },
    // 에이전트 쪽은 면도 테두리도 주지 않는다. 폭을 다 쓰는 본문이 곧 "이건 답이다" 라는
    // 표시이고, 여백만으로 앞뒤 도구 카드와 갈린다.
    agentMessage: { marginVertical: 8 },
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
    input: {
      backgroundColor: theme.bg2,
      borderColor: theme.surface2,
      // 둥근 알약 모양. 옆의 두 버튼이 원이라 같은 곡률로 맞춘다.
      borderRadius: 22,
      borderWidth: 1,
      color: theme.text,
      flex: 1,
      // 본문과 같은 크기로 올린다 — 방금 읽은 글보다 내가 쓰는 글이 작을 이유가 없다.
      fontSize: 16,
      maxHeight: 120,
      minHeight: 44,
      paddingHorizontal: 16,
      paddingVertical: 11
    },
    /** 손가락 최소 크기(44dp)를 채운 원. 글자 대신 아이콘이라 폭을 뺏지 않는다. */
    circleButton: {
      alignItems: 'center',
      borderRadius: 22,
      height: 44,
      justifyContent: 'center',
      width: 44
    },
    sendButton: { backgroundColor: theme.accentStrong },
    // 멈춤은 파괴적이지 않다 — 솔리드 빨강은 과하다. 데스크톱과 같은 틴트 + 테두리로 둔다.
    stopButton: {
      backgroundColor: theme.dangerSurface,
      borderColor: theme.dangerBorder,
      borderWidth: 1
    },
    buttonPressed: { opacity: 0.7 },
    disabled: { opacity: 0.45 }
  })
