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
  View
} from 'react-native'
import {
  ArrowRightLeft,
  Brain,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  CornerDownRight,
  ListTodo,
  Terminal,
  Wrench,
  type LucideIcon
} from 'lucide-react-native'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import type { ChatItem, PermissionRequest } from '@shared/types'
import { workspaceDisplayName } from '@shared/types'
import { formatToolGroup } from '@shared/toolGroups'
import { BrandMark } from '../../src/components/BrandMark'
import { DemoBanner } from '../../src/components/DemoBanner'
import { PR_COLORS } from '../../src/state/prColors'
import { isLaptopAway, useRemoteStore } from '../../src/state/store'
import { agoLabel, untilLabel, useNow } from '../../src/state/useNow'
import { useDeviceAuthentication } from '../../src/state/useDeviceAuth'
import { theme } from '../../src/theme'
import { buildChatRows, type ChatRowModel, type ToolCardModel } from '../../src/chat/rows'

const PAGE_SIZE = 100
const WATCH_REFRESH_MS = 40_000
const MAX_PROMPT_BYTES = 32 * 1024

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function modeToneColor(tone: 'readOnly' | 'caution'): string {
  return tone === 'readOnly' ? theme.readonly : theme.warning
}

function isPermissionRequest(value: unknown): value is PermissionRequest {
  return (
    isRecord(value) &&
    typeof value.requestId === 'string' &&
    typeof value.workspaceId === 'string' &&
    typeof value.toolName === 'string' &&
    isRecord(value.input)
  )
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
      if (!demo && behavior === 'allow' && !(await authenticate('Approve action on your laptop'))) {
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
        {responding ? <ActivityIndicator color="#8b7cf6" size="small" /> : null}
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
  if (!Array.isArray(value)) throw new Error('The laptop returned an invalid transcript')
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
  color = theme.text
}: {
  text: string
  color?: string
}): React.JSX.Element {
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
            <Text key={index} style={[styles.bodyText, { color }]} selectable>
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

function ChatRow({ row }: { row: ChatRowModel }): React.JSX.Element | null {
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
          <RichText text={item.text} color="#ef8d8d" />
        </View>
      )
    case 'system':
      return (
        <View style={styles.compactCard}>
          <RichText text={item.text} color="#91919a" />
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
        <Text style={styles.footer}>Unsupported item — open this workspace on your laptop</Text>
      )
  }
}

export default function WorkspaceScreen(): React.JSX.Element {
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
      if (!(await authenticate('Send this to your laptop'))) {
        setError('Device authentication was cancelled or unsuccessful. Nothing was sent.')
        return
      }
    }
    setSending(true)
    setError(null)
    try {
      await command('chat:send', [workspaceId, prompt])
      setText('')
      await loadLatest()
    } catch (sendError) {
      setError(errorMessage(sendError))
    } finally {
      setSending(false)
    }
  }, [authenticate, command, loadLatest, sending, text, workspace, workspaceId])

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
    // 에이전트는 이제 마크로 보여 준다(데스크톱과 같은 그림) — 여기서는 글자를 빼고
    // 마크가 답하지 못하는 것만 남긴다.
    // 폰 헤더는 한 줄이다. 모델 이름까지 넣으면 브랜치가 잘리는데, 지금 어느 브랜치를 보고
    // 있는지가 어느 모델인지보다 훨씬 자주 필요하다.
    return [workspace.multiAgent ? '+ subagents' : null, workspace.branch]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(' · ')
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
              <Text style={styles.headerMeta} numberOfLines={1}>
                {headerMeta}
              </Text>
            </View>
            {workspace?.pr ? (
              <Text
                style={[styles.headerPr, { color: PR_COLORS[workspace.pr.state] ?? theme.textDim }]}
                numberOfLines={1}
              >
                #{workspace.pr.number} · {workspace.pr.label}
              </Text>
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
          ListFooterComponent={loadingOlder ? <ActivityIndicator color="#8b7cf6" /> : null}
          ListEmptyComponent={
            loading ? (
              <ActivityIndicator style={styles.loading} color={theme.accent} />
            ) : (
              <Text style={styles.empty}>No conversation yet</Text>
            )
          }
        />
        {permission !== undefined && command !== null ? (
          <PermissionCard key={permission.requestId} request={permission} command={command} />
        ) : null}
        <View style={styles.composer}>
          <TextInput
            style={styles.input}
            value={text}
            onChangeText={setText}
            editable={!sending}
            multiline
            maxLength={32 * 1024}
            placeholder="Follow up…"
            placeholderTextColor="#66666f"
          />
          <Pressable
            style={[styles.sendButton, (sending || text.trim().length === 0) && styles.disabled]}
            disabled={sending || text.trim().length === 0}
            onPress={() => void send()}
          >
            <Text style={styles.sendText}>{sending ? 'Sending…' : 'Send'}</Text>
          </Pressable>
        </View>
        {/* 데스크톱과 같은 자리에 둔다 — 무엇을 보내려는 순간 그 모드가 눈에 들어와야 한다.
            헤더에 있으면 스크롤과 함께 시야에서 사라지고, 정작 필요한 때 보이지 않는다.
            띄울 것이 없는 모드(Claude 의 'default')에서는 데스크톱처럼 아무것도 띄우지 않는다. */}
        {modeFooter !== null && modeFooter !== undefined ? (
          <View style={styles.modeFooter}>
            {/* 색은 데스크톱 컴포저와 같은 두 갈래다 — 읽기 전용은 '멈춤' 색, 스스로 실행하는
                모드는 경고 색. 어느 쪽인지는 랩탑이 정해서 보낸다(모드 의미에 달린 판단이다). */}
            <Text style={[styles.modeText, { color: modeToneColor(modeFooter.tone) }]}>
              {modeFooter.symbol} {modeFooter.text}
            </Text>
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
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
  headerPr: { fontSize: 11, marginTop: 2 },
  headerLimit: { color: theme.warning, fontSize: 11, marginTop: 2 },
  title: { color: theme.text, fontSize: 15, fontWeight: '600', maxWidth: '100%' },
  connection: { color: theme.textDim, fontSize: 10, marginTop: 2, textTransform: 'capitalize' },
  headerSpacer: { width: 68 },
  stopButton: {
    alignItems: 'center',
    borderColor: 'rgba(255,100,103,0.42)',
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
    backgroundColor: '#2a1719',
    color: '#ef8d8d',
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
  errorText: { color: '#ef8d8d' },
  errorCard: {
    backgroundColor: '#251719',
    borderColor: '#5c3036',
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
  diffAdded: { backgroundColor: '#14251c' },
  diffRemoved: { backgroundColor: '#2b171a' },
  permissionError: { color: '#ef8d8d', fontSize: 11, lineHeight: 15, marginTop: 8 },
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
  sessionButton: { borderColor: 'rgba(255,185,0,0.35)' },
  sessionButtonText: { color: theme.warning, fontSize: 12, fontWeight: '600', textAlign: 'center' },
  allowButton: { backgroundColor: theme.warning, borderColor: theme.warning },
  allowButtonText: { color: theme.bg, fontSize: 13, fontWeight: '700', textAlign: 'center' },
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
  modeFooter: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    paddingBottom: 8,
    paddingHorizontal: 14
  },
  modeText: { fontSize: 11 },
  composer: {
    alignItems: 'flex-end',
    borderTopColor: theme.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 9,
    padding: 10
  },
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
  sendText: { color: '#ffffff', fontSize: 13, fontWeight: '700' },
  disabled: { opacity: 0.45 }
})
