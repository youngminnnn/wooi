import { useCallback, useEffect, useState } from 'react'
import {
  ActivityIndicator,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import {
  CheckCircle2,
  ChevronLeft,
  CircleDashed,
  CircleDot,
  ExternalLink,
  GitPullRequest,
  MinusCircle,
  XCircle
} from 'lucide-react-native'
import { REMOTE_COMMAND_FAILED } from '@shared/remote'
import type { PrCheck, PrCheckState, PrChecks } from '@shared/types'
import { SettingsSection } from '../../../src/components/settings/SettingsSection'
import { usePrColors } from '../../../src/state/prColors'
import { isLaptopAway, useRemoteStore } from '../../../src/state/store'
import { useTheme, useThemedStyles } from '../../../src/state/theme'
import { agoLabel, useNow } from '../../../src/state/useNow'
import type { Theme } from '../../../src/theme'

/**
 * PR 화면. 워크스페이스 헤더의 PR 줄을 누르면 오른쪽에서 밀려 들어온다.
 *
 * 데스크톱 우측 패널의 Check 탭과 **같은 데이터**를 본다(`pr:checks` → `gh pr view`). 폰에
 * 이게 있어야 하는 이유는 데스크톱과 같다 — 상태 라벨 한 줄은 "무엇이 막고 있는지"를 말하지
 * 못한다. 다만 폰에서는 그걸 확인하러 랩탑으로 돌아가는 비용이 훨씬 크다.
 *
 * **체크는 폴링하지 않는다.** 한 번 부를 때마다 랩탑이 GitHub 를 때리므로, 화면을 열 때와
 * 사용자가 당겨 새로고침할 때만 부른다(그리고 랩탑이 PR 상태가 바뀌었다고 알려 올 때).
 */
export default function PrScreen(): React.JSX.Element {
  const router = useRouter()
  const theme = useTheme()
  const styles = useThemedStyles(makeStyles)
  const prColors = usePrColors()
  const { id } = useLocalSearchParams<{ id: string }>()
  const workspaceId = typeof id === 'string' ? id : undefined
  const command = useRemoteStore((store) => store.command)
  const workspace = useRemoteStore((store) =>
    store.state?.workspaces.find((item) => item.id === workspaceId)
  )
  const laptopSeenAt = useRemoteStore((store) => store.laptopSeenAt)
  const now = useNow()
  const laptopAway = isLaptopAway(laptopSeenAt, now)

  const [checks, setChecks] = useState<PrChecks | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const pr = workspace?.pr ?? null
  // 상태가 바뀌면(체크가 끝나 ci_pending → ci_failed 로 넘어가는 식) 목록도 따라가야 한다 —
  // 랩탑이 이미 다시 조회한 뒤라 여기서 한 번 더 부르는 값이 있다.
  const prNumber = pr?.number ?? null
  const prState = pr?.state ?? null

  const load = useCallback(async (): Promise<boolean> => {
    if (command === null || workspaceId === undefined) return false
    try {
      const result = await command('pr:checks', [workspaceId])
      setChecks(asPrChecks(result))
      setError(null)
    } catch (loadError) {
      setError(describeError(loadError))
    }
    return true
  }, [command, workspaceId])

  useEffect(() => {
    // PR 이 없으면 물어볼 것도 없다. 아직 모르는 것(undefined)도 마찬가지로 기다린다 —
    // 랩탑이 한 번도 조회하지 않았다면 체크만 따로 아는 일은 없다.
    if (prNumber === null) {
      setChecks(null)
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    void load().then(() => {
      if (alive) setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [load, prNumber, prState])

  const [refreshing, setRefreshing] = useState(false)
  const refresh = useCallback((): void => {
    setRefreshing(true)
    void load().finally(() => setRefreshing(false))
  }, [load])

  // 랩탑에서 온 주소만 연다. 미러된 상태에 실려 오는 값이라 https 가 아닌 것은 열지 않는다 —
  // 데모의 `demo://` 도 이 규칙에 걸려 자연히 버튼이 사라진다.
  const url = pr?.url ?? checks?.prUrl
  const openable = typeof url === 'string' && url.startsWith('https://')

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      {/* 오른쪽에서 밀려 들어온다. iOS 는 push 의 기본값이지만 안드로이드는 아니라 명시한다. */}
      <Stack.Screen options={{ animation: 'slide_from_right' }} />
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Back"
          accessibilityRole="button"
          hitSlop={12}
          onPress={() => router.back()}
          style={({ pressed }) => [styles.back, pressed && styles.pressed]}
        >
          <ChevronLeft color={theme.text} size={24} />
        </Pressable>
        <Text style={styles.headerTitle}>Pull request</Text>
        <View style={styles.headerSpacer} />
      </View>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          prNumber === null ? undefined : (
            <RefreshControl onRefresh={refresh} refreshing={refreshing} tintColor={theme.textDim} />
          )
        }
      >
        {pr === null ? (
          <Text style={styles.empty}>
            {workspace === undefined
              ? 'This workspace is no longer on your laptop.'
              : 'No pull request for this branch yet.'}
          </Text>
        ) : (
          <>
            <View style={styles.summary}>
              {pr.title !== undefined ? <Text style={styles.title}>{pr.title}</Text> : null}
              <View style={styles.stateLine}>
                <GitPullRequest color={prColors[pr.state] ?? theme.textDim} size={14} />
                <Text style={[styles.state, { color: prColors[pr.state] ?? theme.textDim }]}>
                  #{pr.number} · {pr.label}
                </Text>
              </View>
              {/* 라벨과 겹치지 않는 정보다 — 'Ready to merge' 인데도 머지가 막혀 있는 이유. */}
              {pr.needsBaseUpdate === true ? (
                <Text style={styles.note}>
                  The base branch has moved ahead. Update this branch on your laptop before merging.
                </Text>
              ) : null}
            </View>

            {/* 랩탑이 자면 체크는 못 가져온다. 위의 PR 요약은 미러된 값이라 그대로 보인다. */}
            {laptopAway && laptopSeenAt !== null ? (
              <Text style={styles.offline}>
                Your laptop is asleep or offline — last seen {agoLabel(laptopSeenAt, now)}. Checks
                are read live, so they may be out of date.
              </Text>
            ) : null}
            {error !== null ? <Text style={styles.errorBanner}>{error}</Text> : null}

            {loading ? (
              <ActivityIndicator color={theme.accent} style={styles.loading} />
            ) : checks === null ? (
              error === null ? (
                <Text style={styles.empty}>
                  Your laptop could not read the checks for this pull request.
                </Text>
              ) : null
            ) : checks.checks.length === 0 ? (
              <Text style={styles.empty}>No checks reported on this pull request.</Text>
            ) : (
              <SettingsSection title={`${checks.checks.length} checks`}>
                {checks.checks.map((check) => (
                  <CheckRow key={check.name} check={check} />
                ))}
              </SettingsSection>
            )}

            {openable ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => void Linking.openURL(url).catch(() => undefined)}
                style={({ pressed }) => [styles.link, pressed && styles.pressed]}
              >
                <Text style={styles.linkText}>Open on GitHub</Text>
                <ExternalLink color={theme.textDim} size={13} />
              </Pressable>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}

/** 체크 한 줄. 색만으로 구분하지 않는다 — 모양이 다르면 밝은 데서 색을 못 봐도 읽힌다. */
function CheckRow({ check }: { check: PrCheck }): React.JSX.Element {
  const theme = useTheme()
  const styles = useThemedStyles(makeStyles)
  const openable = typeof check.url === 'string' && check.url.startsWith('https://')
  return (
    <Pressable
      accessibilityRole={openable ? 'button' : undefined}
      disabled={!openable}
      onPress={() => {
        if (openable) void Linking.openURL(check.url as string).catch(() => undefined)
      }}
      style={({ pressed }) => [styles.checkRow, pressed && openable && styles.rowPressed]}
    >
      <CheckIcon state={check.state} />
      <Text numberOfLines={1} style={styles.checkName}>
        {check.name}
      </Text>
      {/* 상태말은 흐린 회색으로 둔다. 색은 아이콘이 이미 말하고 있고, 라이트 테마에서 상태색을
          작은 글자에 그대로 쓰면 대비가 무너진다(theme.ts 의 PR 색 주석과 같은 이유). */}
      <Text style={styles.checkState}>{check.state}</Text>
      {openable ? <ExternalLink color={theme.textFaint} size={11} /> : null}
    </Pressable>
  )
}

function CheckIcon({ state }: { state: PrCheckState }): React.JSX.Element {
  const theme = useTheme()
  switch (state) {
    case 'success':
      return <CheckCircle2 color={theme.success} size={15} />
    case 'failure':
      return <XCircle color={theme.danger} size={15} />
    case 'pending':
      // 데스크톱은 여기서 스피너를 돌리지만, 목록의 여러 줄이 동시에 도는 것은 폰에서 시끄럽다.
      return <CircleDashed color={theme.warningFg} size={15} />
    case 'skipped':
      return <MinusCircle color={theme.textFaint} size={15} />
    default:
      return <CircleDot color={theme.textFaint} size={15} />
  }
}

const CHECK_STATES: PrCheckState[] = ['success', 'failure', 'pending', 'skipped', 'neutral']

/**
 * 랩탑이 보낸 값을 폰이 믿을 수 있는 모양으로 좁힌다. 이 화면은 `unknown` 을 받는 명령
 * 경로 위에 있고, 형태가 어긋난 값을 그대로 그리면 화면이 죽는다.
 */
function asPrChecks(value: unknown): PrChecks | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.prNumber !== 'number' || typeof record.prUrl !== 'string') return null
  if (!Array.isArray(record.checks)) return null
  const checks: PrCheck[] = []
  for (const item of record.checks) {
    if (typeof item !== 'object' || item === null) continue
    const check = item as Record<string, unknown>
    if (typeof check.name !== 'string') continue
    const state = CHECK_STATES.includes(check.state as PrCheckState)
      ? (check.state as PrCheckState)
      : 'neutral'
    checks.push({
      name: check.name,
      state,
      url: typeof check.url === 'string' ? check.url : undefined
    })
  }
  return { prNumber: record.prNumber, prUrl: record.prUrl, checks }
}

/**
 * 랩탑에서 실패한 것과 전송이 실패한 것은 사용자가 할 일이 다르다.
 *
 * 앞의 것은 사유를 알 수 없다 — 브리지가 일부러 한 문장으로 뭉개서 보내기 때문이다
 * (`REMOTE_COMMAND_FAILED`). 그래서 **추측해서 단정하지 않고** 가장 흔한 원인을 짚어 준다:
 * 폰이 랩탑보다 앞서 있을 수 있다(스토어 업데이트는 폰에 먼저 닿고 랩탑은 사람이 갱신해야
 * 한다). 그 경우 이 명령은 허용목록에 없어 거절되고, 랩탑을 올리면 그대로 풀린다.
 */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Something went wrong'
  if (message === REMOTE_COMMAND_FAILED) {
    return 'Your laptop could not read the checks. Older versions of Wooi cannot send them to this phone — updating the laptop may fix it.'
  }
  return message
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { backgroundColor: theme.bg, flex: 1 },
    header: {
      alignItems: 'center',
      borderBottomColor: theme.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      minHeight: 48,
      paddingHorizontal: 8
    },
    back: { alignItems: 'center', height: 40, justifyContent: 'center', width: 40 },
    headerTitle: { color: theme.text, flex: 1, fontSize: 16, fontWeight: '600' },
    headerSpacer: { width: 40 },
    pressed: { backgroundColor: theme.pressed, borderRadius: 8 },
    content: { gap: 18, padding: 16 },
    summary: { gap: 7 },
    title: { color: theme.text, fontSize: 18, fontWeight: '600', lineHeight: 24 },
    stateLine: { alignItems: 'center', flexDirection: 'row', gap: 6 },
    state: { fontSize: 13.5, fontWeight: '600' },
    note: { color: theme.textMuted, fontSize: 13, lineHeight: 18 },
    offline: {
      backgroundColor: theme.warningSurface,
      borderColor: theme.warningBorder,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      color: theme.warningFg,
      fontSize: 12.5,
      lineHeight: 17,
      padding: 10
    },
    errorBanner: {
      backgroundColor: theme.dangerSurface,
      borderColor: theme.dangerBorder,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      color: theme.dangerFg,
      fontSize: 12.5,
      lineHeight: 17,
      padding: 10
    },
    loading: { paddingVertical: 32 },
    empty: {
      color: theme.textDim,
      fontSize: 13.5,
      lineHeight: 19,
      paddingVertical: 24,
      textAlign: 'center'
    },
    checkRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 9,
      minHeight: 44,
      paddingHorizontal: 14,
      paddingVertical: 10
    },
    rowPressed: { backgroundColor: theme.surface2 },
    checkName: { color: theme.text, flex: 1, fontSize: 14 },
    checkState: { color: theme.textDim, fontSize: 12 },
    link: {
      alignItems: 'center',
      alignSelf: 'flex-start',
      flexDirection: 'row',
      gap: 6,
      paddingHorizontal: 4,
      paddingVertical: 8
    },
    linkText: { color: theme.textMuted, fontSize: 13.5 }
  })
