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
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import type { ChatItem, PermissionRequest } from '@shared/types'
import { workspaceDisplayName } from '@shared/types'
import { BrandMark } from '../../src/components/BrandMark'
import { PR_COLORS } from '../../src/state/prColors'
import { isLaptopAway, useRemoteStore } from '../../src/state/store'
import { agoLabel, untilLabel, useNow } from '../../src/state/useNow'
import { useDeviceAuthentication } from '../../src/state/useDeviceAuth'

const PAGE_SIZE = 100
const WATCH_REFRESH_MS = 40_000
const MAX_PROMPT_BYTES = 32 * 1024

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
            <Text style={styles.permissionCode} selectable>{line || ' '}</Text>
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
  const [responding, setResponding] = useState(false)
  const [responseError, setResponseError] = useState<string | null>(null)
  const authenticate = useDeviceAuthentication()

  const respond = useCallback(async (behavior: 'allow' | 'deny', rememberForSession = false): Promise<void> => {
    if (responding) return
    setResponseError(null)
    if (behavior === 'allow' && !(await authenticate('Approve action on your laptop'))) {
      setResponseError('Device authentication was cancelled or unsuccessful. Nothing was sent.')
      return
    }
    const stillPending = useRemoteStore.getState().state?.pendingPermissions.some(
      (item) => isPermissionRequest(item) && item.requestId === request.requestId
    )
    if (stillPending !== true) return
    setResponding(true)
    const decision = behavior === 'deny'
      ? { behavior: 'deny' as const }
      : rememberForSession
        ? { behavior: 'allow' as const, rememberForSession: true }
        : { behavior: 'allow' as const }
    try {
      await command('permission:respond', [request.requestId, decision])
    } catch (respondError) {
      setResponseError(errorMessage(respondError))
      setResponding(false)
    }
  }, [authenticate, command, request.requestId, responding])

  const substance = formatPermissionInput(request)
  return (
    <View style={styles.permissionCard}>
      <View style={styles.permissionHeading}>
        <Text style={styles.permissionEyebrow}>PERMISSION REQUIRED</Text>
        {responding ? <ActivityIndicator color="#8b7cf6" size="small" /> : null}
      </View>
      <Text style={styles.permissionTitle}>{request.title ?? request.displayName ?? 'Approve this action?'}</Text>
      <Text style={styles.permissionTool}>{request.toolName}</Text>
      <View style={styles.permissionSubstance}>
        {request.kind === 'fileChange' && request.diff !== undefined
          ? <Diff value={request.diff} />
          : <ScrollView style={styles.permissionTextScroll} nestedScrollEnabled>
              <Text style={styles.permissionCode} selectable>{substance}</Text>
            </ScrollView>}
      </View>
      {responseError ? <Text style={styles.permissionError}>{responseError}</Text> : null}
      {request.rule ? (
        <View style={styles.ruleBox}>
          <Text style={styles.ruleLabel}>SESSION RULE</Text>
          <Text style={styles.permissionRule}>{request.rule}</Text>
        </View>
      ) : null}
      <View style={styles.permissionActions}>
        <Pressable style={[styles.permissionButton, styles.denyButton, responding && styles.disabled]} disabled={responding} onPress={() => void respond('deny')}>
          <Text style={styles.denyButtonText}>{responding ? 'Sending…' : 'Deny'}</Text>
        </Pressable>
        <Pressable style={[styles.permissionButton, responding && styles.disabled]} disabled={responding} onPress={() => void respond('allow')}>
          <Text style={styles.allowButtonText}>Allow once</Text>
        </Pressable>
        <Pressable style={[styles.permissionButton, responding && styles.disabled]} disabled={responding} onPress={() => void respond('allow', true)}>
          <Text style={styles.allowButtonText}>Allow for session</Text>
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

function RichText({ text, color = '#d7d7dc' }: { text: string; color?: string }): React.JSX.Element {
  const parts = text.split(/(```[\s\S]*?```)/g).filter(Boolean)
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
    </View>
  )
}

function Collapsible({
  title,
  text,
  error = false
}: {
  title: string
  text: string
  error?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <Pressable style={styles.compactCard} onPress={() => setOpen((value) => !value)}>
      <Text style={[styles.cardTitle, error && styles.errorText]}>{open ? '−' : '+'} {title}</Text>
      {open ? <RichText text={text} color={error ? '#ef8d8d' : '#9b9ba4'} /> : null}
    </Pressable>
  )
}

function ChatRow({ item }: { item: ChatItem }): React.JSX.Element {
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
      return <Collapsible title={item.streaming ? 'Thinking…' : 'Thinking'} text={item.text} />
    case 'tool_use':
      return <Collapsible title={`Tool · ${item.name}`} text={JSON.stringify(item.input, null, 2)} />
    case 'tool_result':
      return <Collapsible title={item.isError ? 'Tool error' : 'Tool result'} text={item.text} error={item.isError} />
    case 'result':
      return (
        <Text style={[styles.footer, item.isError && styles.errorText]}>
          {item.subtype} · {(item.durationMs / 1000).toFixed(1)}s · {item.numTurns} turns
        </Text>
      )
    case 'error':
      return <View style={styles.errorCard}><RichText text={item.text} color="#ef8d8d" /></View>
    case 'system':
      return <View style={styles.compactCard}><RichText text={item.text} color="#91919a" /></View>
    case 'unknown':
      return <Collapsible title={`Unsupported ${item.backend} item`} text={`${item.what}${item.hint ? `\n${item.hint}` : ''}`} />
    case 'bash':
      return <Collapsible title={`${item.running ? 'Running' : 'Command'} · ${item.command}`} text={item.output || 'No output'} error={item.exitCode !== null && item.exitCode !== 0} />
    case 'task':
      return <Collapsible title={`${item.name} · ${item.status}`} text={item.summary ?? item.description} error={item.status === 'failed'} />
    case 'handoff':
      return <Collapsible title={`Handoff · ${item.childName}`} text={item.summary} error={item.status === 'blocked'} />
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
      setHasOlder(page.length === PAGE_SIZE)
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
      setHasOlder(page.length === PAGE_SIZE)
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

  const title = useMemo(
    () => (workspace === undefined ? 'Workspace' : workspaceDisplayName(workspace)),
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
    return [
      workspace.multiAgent ? '+ subagents' : null,
      workspace.model,
      workspace.branch
    ]
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
          <Pressable onPress={() => router.back()} hitSlop={12}><Text style={styles.back}>‹ Back</Text></Pressable>
          <View style={styles.headerTitle}>
            {/* 목록에서 보던 정보를 그대로 가져온다. 워크스페이스에 들어온 순간 어느 리포의
                무엇을 보고 있는지 모르게 되면, 폰에서는 되돌아가 확인하는 비용이 크다. */}
            {repoName !== null ? <Text style={styles.headerRepo} numberOfLines={1}>{repoName}</Text> : null}
            <Text style={styles.title} numberOfLines={1}>{title}</Text>
            <View style={styles.headerMetaLine}>
              <BrandMark backend={workspace?.agentBackend} size={10} />
              <Text style={styles.headerMeta} numberOfLines={1}>{headerMeta}</Text>
            </View>
            {workspace?.pr ? (
              <Text style={[styles.headerPr, { color: PR_COLORS[workspace.pr.state] ?? '#77767f' }]} numberOfLines={1}>
                #{workspace.pr.number} · {workspace.pr.label}
              </Text>
            ) : null}
            {limitLabel !== null ? <Text style={styles.headerLimit} numberOfLines={1}>{limitLabel}</Text> : null}
          </View>
          {workspace?.status === 'running' ? (
            <Pressable style={styles.stopButton} disabled={stopping} onPress={() => void stop()}>
              <Text style={styles.stopText}>{stopping ? 'Stopping…' : 'Stop'}</Text>
            </Pressable>
          ) : <View style={styles.headerSpacer} />}
        </View>
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
          data={items}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <ChatRow item={item} />}
          contentContainerStyle={styles.list}
          onEndReached={() => void loadOlder()}
          onEndReachedThreshold={0.3}
          ListFooterComponent={loadingOlder ? <ActivityIndicator color="#8b7cf6" /> : null}
          ListEmptyComponent={loading ? <ActivityIndicator style={styles.loading} color="#8b7cf6" /> : <Text style={styles.empty}>No conversation yet</Text>}
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
          <Pressable style={[styles.sendButton, (sending || text.trim().length === 0) && styles.disabled]} disabled={sending || text.trim().length === 0} onPress={() => void send()}>
            <Text style={styles.sendText}>{sending ? 'Sending…' : 'Send'}</Text>
          </Pressable>
        </View>
        {/* 데스크톱과 같은 자리에 둔다 — 무엇을 보내려는 순간 그 모드가 눈에 들어와야 한다.
            헤더에 있으면 스크롤과 함께 시야에서 사라지고, 정작 필요한 때 보이지 않는다.
            띄울 것이 없는 모드(Claude 의 'default')에서는 데스크톱처럼 아무것도 띄우지 않는다. */}
        {modeFooter !== null && modeFooter !== undefined ? (
          <View style={styles.modeFooter}>
            <Text style={styles.modeSymbol}>{modeFooter.symbol}</Text>
            <Text style={styles.modeText}>{modeFooter.text}</Text>
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { backgroundColor: '#0b0b0d', flex: 1 },
  header: { alignItems: 'center', borderBottomColor: '#202024', borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', minHeight: 54, paddingHorizontal: 14 },
  back: { color: '#9b8df7', fontSize: 15, width: 68 },
  headerTitle: { alignItems: 'center', flex: 1 },
  headerRepo: { color: '#777680', fontSize: 10, fontWeight: '700', letterSpacing: 0.8 },
  headerMetaLine: { alignItems: 'center', flexDirection: 'row', gap: 5, marginTop: 2 },
  headerMeta: { color: '#77767f', fontSize: 11 },
  headerPr: { fontSize: 11, marginTop: 2 },
  headerLimit: { color: '#d0a24c', fontSize: 11, marginTop: 2 },
  title: { color: '#ededf0', fontSize: 15, fontWeight: '600', maxWidth: '100%' },
  connection: { color: '#6f6f77', fontSize: 10, marginTop: 2, textTransform: 'capitalize' },
  headerSpacer: { width: 68 },
  stopButton: { alignItems: 'center', borderColor: '#733b42', borderRadius: 5, borderWidth: 1, paddingVertical: 6, width: 68 },
  stopText: { color: '#ef8d8d', fontSize: 12, fontWeight: '600' },
  offline: { backgroundColor: '#202024', color: '#a4a4ad', fontSize: 11, lineHeight: 16, paddingHorizontal: 14, paddingVertical: 7 },
  errorBanner: { backgroundColor: '#2a1719', color: '#ef8d8d', fontSize: 12, lineHeight: 17, paddingHorizontal: 14, paddingVertical: 8 },
  list: { paddingHorizontal: 14, paddingVertical: 12 },
  message: { borderBottomColor: '#202024', borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 14 },
  userMessage: { backgroundColor: '#121217', borderRadius: 7, marginVertical: 5, paddingHorizontal: 11 },
  label: { color: '#767680', fontSize: 9, fontWeight: '700', letterSpacing: 1, marginBottom: 6 },
  bodyText: { fontSize: 14, lineHeight: 21 },
  compactCard: { backgroundColor: '#141417', borderColor: '#27272c', borderRadius: 6, borderWidth: 1, marginVertical: 4, padding: 10 },
  cardTitle: { color: '#a1a1aa', fontSize: 12, fontWeight: '600' },
  codeScroll: { backgroundColor: '#08080a', borderRadius: 5, marginVertical: 7, padding: 10 },
  code: { color: '#c7c7cf', fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }), fontSize: 12, lineHeight: 18 },
  footer: { borderBottomColor: '#202024', borderBottomWidth: StyleSheet.hairlineWidth, color: '#6f6f77', fontSize: 10, paddingVertical: 7, textAlign: 'center' },
  errorText: { color: '#ef8d8d' },
  errorCard: { backgroundColor: '#251719', borderColor: '#5c3036', borderRadius: 6, borderWidth: 1, marginVertical: 4, padding: 10 },
  loading: { paddingVertical: 40 },
  empty: { color: '#707078', paddingVertical: 40, textAlign: 'center' },
  permissionCard: { backgroundColor: '#121217', borderColor: '#51478a', borderTopWidth: 2, padding: 12 },
  permissionHeading: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  permissionEyebrow: { color: '#a99df4', fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  permissionTitle: { color: '#ededf0', fontSize: 15, fontWeight: '600', lineHeight: 20, marginTop: 7 },
  permissionTool: { color: '#83838d', fontSize: 11, marginTop: 3 },
  permissionSubstance: { backgroundColor: '#08080a', borderColor: '#29292f', borderRadius: 5, borderWidth: 1, marginTop: 9, maxHeight: 150 },
  permissionTextScroll: { maxHeight: 145, padding: 9 },
  permissionCodeScroll: { maxHeight: 145, paddingVertical: 7 },
  permissionCode: { color: '#c7c7cf', fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }), fontSize: 11, lineHeight: 17 },
  diffLine: { paddingHorizontal: 9 },
  diffAdded: { backgroundColor: '#14251c' },
  diffRemoved: { backgroundColor: '#2b171a' },
  permissionError: { color: '#ef8d8d', fontSize: 11, lineHeight: 15, marginTop: 8 },
  permissionActions: { flexDirection: 'row', gap: 8, marginTop: 10 },
  permissionButton: { alignItems: 'center', borderColor: '#4a4a53', borderRadius: 6, borderWidth: 1, flex: 1, justifyContent: 'center', minHeight: 44, paddingHorizontal: 5 },
  denyButton: { borderColor: '#8b4c54' },
  denyButtonText: { color: '#ef9a9a', fontSize: 12, fontWeight: '700' },
  allowButtonText: { color: '#d0d0d7', fontSize: 11, fontWeight: '600', textAlign: 'center' },
  ruleBox: { backgroundColor: '#19191e', borderRadius: 4, marginTop: 8, paddingHorizontal: 8, paddingVertical: 6 },
  ruleLabel: { color: '#777780', fontSize: 8, fontWeight: '700', letterSpacing: 0.8 },
  permissionRule: { color: '#b0b0b8', fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }), fontSize: 10, marginTop: 3 },
  modeFooter: { alignItems: 'center', flexDirection: 'row', gap: 6, paddingBottom: 8, paddingHorizontal: 14 },
  modeSymbol: { color: '#9b8df7', fontSize: 11 },
  modeText: { color: '#77767f', fontSize: 11 },
  composer: { alignItems: 'flex-end', borderTopColor: '#202024', borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 9, padding: 10 },
  input: { backgroundColor: '#151519', borderColor: '#29292f', borderRadius: 8, borderWidth: 1, color: '#ededf0', flex: 1, fontSize: 14, maxHeight: 120, minHeight: 42, paddingHorizontal: 11, paddingVertical: 10 },
  sendButton: { backgroundColor: '#7465db', borderRadius: 7, justifyContent: 'center', minHeight: 42, paddingHorizontal: 14 },
  sendText: { color: '#ffffff', fontSize: 13, fontWeight: '700' },
  disabled: { opacity: 0.45 }
})
