import { useCallback, useMemo, useState } from 'react'
import { Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { Settings, Users } from 'lucide-react-native'
import type { RemoteWorkspace } from '@shared/remote'
import { workspaceDisplayName } from '@shared/types'
import { BrandMark } from '../src/components/BrandMark'
import { WooiLogo } from '../src/components/WooiLogo'
import { StatusIcon } from '../src/components/StatusIcon'
import { DemoBanner } from '../src/components/DemoBanner'
import { usePrColors } from '../src/state/prColors'
import { isLaptopAway, useRemoteStore } from '../src/state/store'
import { agoLabel, untilLabel, useNow } from '../src/state/useNow'
import { useTheme, useThemedStyles } from '../src/state/theme'
import type { Theme } from '../src/theme'

function updatedLabel(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp)
  if (elapsed < 60_000) return 'Updated just now'
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 60) return `Updated ${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Updated ${hours}h ago`
  return `Updated ${Math.floor(hours / 24)}d ago`
}

/**
 * 사용량 제한 표시. 데스크톱 사이드바와 같은 규칙이다 — 자동 이어가기가 예약돼 있으면 그것을
 * 먼저 말한다. 이게 없으면 워크스페이스가 그냥 idle 로 보여서, 왜 멈췄는지 알려면 들어가 봐야
 * 한다. 폰에서는 그 왕복이 데스크톱보다 훨씬 비싸다.
 */
function rateLimitLabel(workspace: RemoteWorkspace, now: number): string | null {
  // 오래된 랩탑은 이 필드를 아예 보내지 않는다(undefined). null 만 걸러내면 그 경우가 그대로
  // 통과해 `limit.kind` 에서 죽는다 — 실제로 그렇게 죽었다.
  const limit = workspace.rateLimit ?? null
  if (limit === null) return null
  if (limit.kind === 'resuming') {
    return limit.at === null ? 'rate limit' : `rate limit · resumes in ${untilLabel(limit.at, now)}`
  }
  return limit.at === null ? 'rate limit' : `rate limit · resets in ${untilLabel(limit.at, now)}`
}

function WorkspaceRow({
  workspace,
  parentName,
  showAgent,
  now,
  onPress
}: {
  workspace: RemoteWorkspace
  parentName: string | null
  showAgent: boolean
  now: number
  onPress: () => void
}): React.JSX.Element {
  const theme = useTheme()
  const styles = useThemedStyles(makeStyles)
  const prColors = usePrColors()
  const needsPermission = workspace.attention === 'permission'
  // 구형 랩탑은 이 필드를 아예 보내지 않는다(undefined) — 그때는 점을 그리지 않는다.
  // 모르는 것을 "안 읽음"으로 칠하면 페어링 직후 목록 전체가 파란 점이 된다.
  const unread = workspace.unread === true
  const limit = rateLimitLabel(workspace, now)

  return (
    <Pressable style={[styles.row, needsPermission && styles.permissionRow]} onPress={onPress}>
      <View style={styles.statusSlot}>
        <StatusIcon workspace={workspace} hasLimit={limit !== null} />
      </View>
      <View style={styles.rowContent}>
        <View style={styles.nameLine}>
          {/* 스택된 워크스페이스임을 한 글자로 알린다. 폰 폭에서 트리 들여쓰기는 이름을
              잘라먹기만 하고 계층을 읽히게 하지 못한다. */}
          {parentName !== null ? <Text style={styles.stacked}>↳</Text> : null}
          <Text style={styles.name} numberOfLines={1}>
            {workspaceDisplayName(workspace, workspace.pr?.title)}
          </Text>
          {workspace.muted ? <Text style={styles.muted}>muted</Text> : null}
          {needsPermission ? (
            <View style={styles.permissionBadge}>
              <Text style={styles.permissionText}>PERMISSION</Text>
            </View>
          ) : null}
        </View>
        <View style={styles.metaLine}>
          {/* 마크는 14px 아래로 내리지 않는다 — Claude 선버스트는 살이 가늘어 그보다 작으면
              주황색 얼룩으로 뭉개진다(데스크톱이 같은 이유로 14px 를 하한으로 쓴다). */}
          {showAgent || workspace.multiAgent ? (
            <View style={styles.agentMarks}>
              {showAgent ? <BrandMark backend={workspace.agentBackend} size={14} /> : null}
              {/* 팀이면 사람 아이콘 하나를 붙인다 — 데스크톱 사이드바와 같은 그림이다.
                  글자('+ subagents')로 적으면 폰 폭에서 브랜치 이름을 밀어낸다. 개수와 무관한
                  단일 글리프인 이유, 파랑이 아니라 보라인 이유는 데스크톱 index.css 참고. */}
              {workspace.multiAgent ? (
                <View accessible accessibilityLabel="Agent team">
                  <Users size={13} color={theme.accent} />
                </View>
              ) : null}
            </View>
          ) : null}
          <Text style={styles.branch} numberOfLines={1}>
            {workspace.branch}
          </Text>
        </View>
        {workspace.pr !== null && workspace.pr !== undefined ? (
          <Text
            style={[styles.pr, { color: prColors[workspace.pr.state] ?? theme.textDim }]}
            numberOfLines={1}
          >
            #{workspace.pr.number} · {workspace.pr.label}
            {limit !== null ? <Text style={styles.limit}> · {limit}</Text> : null}
          </Text>
        ) : limit !== null ? (
          <Text style={styles.limit} numberOfLines={1}>
            {limit}
          </Text>
        ) : null}
      </View>
      {/* 미확인 완료. 데스크톱 사이드바의 파란 점과 같은 자리(줄 오른쪽 끝)·같은 색이다 —
          왼쪽 상태 아이콘이 "지금 무슨 일이 일어나는가"를 말하고, 이 점은 "내가 아직 안 봤다"를
          말한다. 둘은 겹칠 수 있으므로(에러로 끝난 턴) 자리를 나눈다. */}
      {unread ? (
        <View accessibilityLabel="Unread" style={styles.unreadDot} />
      ) : null}
    </Pressable>
  )
}

export default function WorkspaceListScreen(): React.JSX.Element {
  const router = useRouter()
  const theme = useTheme()
  const styles = useThemedStyles(makeStyles)
  const pairing = useRemoteStore((store) => store.pairing)
  const demo = useRemoteStore((store) => store.demo)
  const status = useRemoteStore((store) => store.status)
  const laptopSeenAt = useRemoteStore((store) => store.laptopSeenAt)
  const now = useNow()
  const laptopAway = isLaptopAway(laptopSeenAt, now)
  const state = useRemoteStore((store) => store.state)
  const updatedAt = useRemoteStore((store) => store.updatedAt)
  const lastError = useRemoteStore((store) => store.lastError)
  const refreshState = useRemoteStore((store) => store.refresh)
  const [refreshing, setRefreshing] = useState(false)

  const nameById = useMemo(
    () =>
      new Map(
        (state?.workspaces ?? []).map((item) => [
          item.id,
          workspaceDisplayName(item, item.pr?.title)
        ])
      ),
    [state?.workspaces]
  )

  /**
   * 에이전트 이름은 종류가 둘 이상일 때만 정보다. 하나뿐이면 모든 행에 같은 단어가 반복돼
   * 브랜치 이름 자리만 빼앗는다 — 데스크톱 사이드바가 쓰는 규칙과 같다.
   */
  const showAgent = useMemo(
    () => new Set((state?.workspaces ?? []).map((item) => item.agentBackend)).size > 1,
    [state?.workspaces]
  )

  /**
   * 리포별로 묶는다. 순서는 랩탑이 보낸 그대로 — 데스크톱에서 사용자가 끌어 정한 순서이므로
   * 폰이 다시 정렬하면 두 화면의 멘탈 모델이 갈린다.
   *
   * 아카이브된 워크스페이스는 뺀다. 데스크톱은 접힌 구역에 따로 두고, 폰에서 할 일은
   * "지금 돌아가는 것"을 보는 쪽에 훨씬 가깝다.
   */
  const sections = useMemo(() => {
    const workspaces = (state?.workspaces ?? []).filter((item) => !item.archived)
    return (state?.repos ?? [])
      .map((repo) => ({
        repo,
        data: workspaces
          .filter((item) => item.repoId === repo.id)
          .sort((left, right) => {
            const permission =
              Number(right.attention === 'permission') - Number(left.attention === 'permission')
            const attention = Number(right.attention !== null) - Number(left.attention !== null)
            return permission || attention || right.lastActiveAt - left.lastActiveAt
          })
      }))
      .filter((section) => section.data.length > 0)
  }, [state?.repos, state?.workspaces])

  const refresh = useCallback(async (): Promise<void> => {
    if ((!demo && pairing === null) || refreshState === null) return
    setRefreshing(true)
    try {
      await refreshState()
    } catch (error) {
      useRemoteStore
        .getState()
        .setLastError(error instanceof Error ? error.message : 'Refresh failed')
    } finally {
      setRefreshing(false)
    }
  }, [demo, pairing, refreshState])

  const machineName = state?.machine.name ?? pairing?.machineName ?? 'Laptop'
  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <View style={styles.headerMark}>
          <WooiLogo size={30} />
        </View>
        <View style={styles.headerText}>
          <Text style={styles.title} numberOfLines={1}>
            {machineName}
          </Text>
          <Text style={styles.updated}>
            {state === null
              ? status === 'connecting'
                ? 'Connecting…'
                : 'Waiting for your laptop…'
              : updatedAt === null
                ? 'Updated recently'
                : updatedLabel(updatedAt)}
          </Text>
        </View>
        <View style={styles.connection}>
          <View
            style={[
              styles.connectionDot,
              { backgroundColor: status === 'online' ? theme.success : theme.textFaint }
            ]}
          />
          <Text style={styles.connectionText}>{status}</Text>
        </View>
        <Pressable
          accessibilityLabel="Settings"
          accessibilityRole="button"
          hitSlop={10}
          onPress={() => router.push('/settings')}
          style={({ pressed }) => [styles.settingsButton, pressed && styles.settingsPressed]}
        >
          <Settings color={theme.textMuted} size={19} strokeWidth={1.8} />
        </Pressable>
      </View>
      <DemoBanner />
      {/* 폰이 끊긴 것과 랩탑이 자는 것을 섞어 말하지 않는다 — 사용자가 할 수 있는 일이 다르다. */}
      {laptopAway && laptopSeenAt !== null ? (
        <Text style={styles.banner}>
          Your laptop is asleep or offline — last seen {agoLabel(laptopSeenAt, now)}. Anything you
          send will run when it wakes.
        </Text>
      ) : null}
      {lastError ? <Text style={styles.banner}>{lastError}</Text> : null}
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        stickySectionHeadersEnabled
        renderSectionHeader={({ section }) => {
          const running = section.data.filter((item) => item.status === 'running').length
          // 접힌 리포는 없지만 헤더는 sticky 라, 스크롤로 행이 밀려 나가도 이 숫자는 남는다 —
          // "이 리포에 안 본 게 몇 개인가"를 목록을 되감지 않고 알 수 있는 유일한 자리다.
          const unread = section.data.filter((item) => item.unread === true).length
          return (
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionName} numberOfLines={1}>
                {section.repo.name}
              </Text>
              {unread > 0 ? <Text style={styles.sectionUnread}>{unread} unread</Text> : null}
              {running > 0 ? <Text style={styles.sectionCount}>{running} running</Text> : null}
            </View>
          )
        }}
        renderItem={({ item }) => (
          <WorkspaceRow
            workspace={item}
            parentName={
              item.parentWorkspaceId == null ? null : (nameById.get(item.parentWorkspaceId) ?? null)
            }
            showAgent={showAgent}
            now={now}
            onPress={() => router.push(`/workspace/${item.id}`)}
          />
        )}
        contentContainerStyle={sections.length === 0 ? styles.emptyList : styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            tintColor={theme.accent}
          />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>
              {state === null ? 'Waiting for your laptop…' : 'No active workspaces'}
            </Text>
            <Text style={styles.emptyBody}>
              {state === null
                ? 'Keep Wooi open on your paired laptop. State will appear here automatically.'
                : 'Workspaces opened in Wooi will appear here.'}
            </Text>
          </View>
        }
      />
    </SafeAreaView>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.bg },
    header: {
      alignItems: 'flex-start',
      borderBottomColor: theme.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingBottom: 18,
      paddingHorizontal: 18,
      paddingTop: 18
    },
    headerMark: { marginRight: 10, marginTop: 3 },
    headerText: { flex: 1, minWidth: 0 },
    title: { color: theme.text, fontSize: 21, fontWeight: '600', letterSpacing: -0.3 },
    updated: { color: theme.textDim, fontSize: 12, marginTop: 3 },
    connection: { alignItems: 'center', flexDirection: 'row', flexShrink: 0, gap: 6, marginLeft: 8, marginTop: 5 },
    connectionDot: { borderRadius: 4, height: 7, width: 7 },
    connectionText: { color: theme.textDim, fontSize: 11, textTransform: 'capitalize' },
    settingsButton: {
      alignItems: 'center',
      borderRadius: 17,
      height: 34,
      justifyContent: 'center',
      marginLeft: 5,
      width: 34
    },
    settingsPressed: { backgroundColor: theme.pressed },
    banner: { backgroundColor: theme.dangerSurface, color: theme.dangerFg, fontSize: 12, padding: 10 },
    list: { paddingBottom: 24 },
    sectionHeader: {
      alignItems: 'center',
      backgroundColor: theme.bg2,
      borderBottomColor: theme.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: 8,
      paddingHorizontal: 18,
      paddingVertical: 8
    },
    sectionName: { color: theme.text, flex: 1, fontSize: 12, fontWeight: '700', letterSpacing: 0.4 },
    sectionCount: { color: theme.accent, fontSize: 11 },
    sectionUnread: { color: theme.info, fontSize: 11 },
    row: {
      alignItems: 'flex-start',
      borderBottomColor: theme.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      minHeight: 62,
      paddingHorizontal: 18,
      paddingVertical: 12
    },
    permissionRow: {
      backgroundColor: theme.surface,
      borderBottomColor: theme.border,
      borderLeftColor: theme.accent,
      borderLeftWidth: 3,
      // 테두리는 폭을 더한다. 빼 주지 않으면 이 줄만 3px 밀려 왼쪽 아이콘 열이 어긋난다.
      paddingLeft: 15
    },
    statusSlot: { alignItems: 'center', marginRight: 11, marginTop: 3, width: 16 },
    unreadDot: {
      backgroundColor: theme.infoStrong,
      borderRadius: 4,
      flexShrink: 0,
      height: 8,
      marginLeft: 10,
      marginTop: 7,
      width: 8
    },
    rowContent: { flex: 1 },
    nameLine: { alignItems: 'center', flexDirection: 'row', gap: 7 },
    stacked: { color: theme.textDim, fontSize: 13 },
    name: {
      color: theme.text,
      flexShrink: 1,
      fontSize: 15.5,
      fontWeight: '600',
      letterSpacing: -0.2
    },
    muted: { color: theme.textDim, fontSize: 10 },
    permissionBadge: {
      backgroundColor: theme.accent,
      borderRadius: 4,
      paddingHorizontal: 5,
      paddingVertical: 1
    },
    permissionText: { color: theme.onAccent, fontSize: 9, fontWeight: '800', letterSpacing: 0.6 },
    metaLine: { alignItems: 'center', flexDirection: 'row', gap: 6, marginTop: 4 },
    // 마크와 팀 글리프는 한 덩어리로 읽혀야 한다 — 브랜치와의 간격보다 좁게 붙인다.
    agentMarks: { alignItems: 'center', flexDirection: 'row', gap: 3 },
    branch: { color: theme.textDim, flexShrink: 1, fontSize: 12.5 },
    pr: { fontSize: 11.5, marginTop: 4 },
    limit: { color: theme.warningFg, fontSize: 11.5, marginTop: 4 },
    parent: { color: theme.textFaint, fontSize: 11, marginTop: 2 },
    emptyList: { flexGrow: 1, justifyContent: 'center' },
    empty: { alignItems: 'center', paddingHorizontal: 32 },
    emptyTitle: { color: theme.textMuted, fontSize: 15, fontWeight: '500' },
    emptyBody: {
      color: theme.textFaint,
      fontSize: 13,
      lineHeight: 19,
      marginTop: 8,
      textAlign: 'center'
    }
  })
