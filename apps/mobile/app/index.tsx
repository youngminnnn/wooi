import { useCallback, useMemo, useState } from 'react'
import { Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import type { RemoteWorkspace } from '@shared/remote'
import { workspaceDisplayName } from '@shared/types'
import { BrandMark } from '../src/components/BrandMark'
import { DemoBanner } from '../src/components/DemoBanner'
import { PR_COLORS } from '../src/state/prColors'
import { isLaptopAway, useRemoteStore } from '../src/state/store'
import { agoLabel, untilLabel, useNow } from '../src/state/useNow'
import { theme } from '../src/theme'

const STATUS_COLORS: Record<string, string> = {
  idle: theme.textFaint,
  running: theme.accent,
  error: theme.danger
}

/**
 * 점 하나가 말할 것을 고른다. 우선순위는 데스크톱 StatusDot 과 같다 —
 * 권한 대기 > 실행 중 > 사용량 제한 > 에러 > PR 상태 > idle.
 * 지금 행동할 수 있는 것이 앞이고, PR 은 아무 일도 일어나지 않을 때에야 말한다.
 */
function dotColor(workspace: RemoteWorkspace, hasLimit: boolean): string {
  if (workspace.attention === 'permission') return theme.accent
  if (workspace.status === 'running') return STATUS_COLORS.running
  if (hasLimit) return theme.warning
  if (workspace.status === 'error') return STATUS_COLORS.error
  const pr = workspace.pr
  if (pr) return PR_COLORS[pr.state] ?? STATUS_COLORS.idle
  return STATUS_COLORS.idle
}

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
  const needsPermission = workspace.attention === 'permission'
  const limit = rateLimitLabel(workspace, now)
  // 한 줄에 다 넣지 않고 우선순위대로 자른다. 폰 폭에서는 브랜치 이름만으로도 줄이 찬다.
  const meta = [workspace.multiAgent ? '+ subagents' : null, workspace.branch].filter(
    (part): part is string => part !== null
  )

  return (
    <Pressable style={[styles.row, needsPermission && styles.permissionRow]} onPress={onPress}>
      <View
        style={[
          styles.dot,
          { backgroundColor: dotColor(workspace, limit !== null) },
          needsPermission && styles.permissionDot
        ]}
      />
      <View style={styles.rowContent}>
        <View style={styles.nameLine}>
          {/* 스택된 워크스페이스임을 한 글자로 알린다. 폰 폭에서 트리 들여쓰기는 이름을
              잘라먹기만 하고 계층을 읽히게 하지 못한다. */}
          {parentName !== null ? <Text style={styles.stacked}>↳</Text> : null}
          <Text style={styles.name} numberOfLines={1}>
            {workspaceDisplayName(workspace)}
          </Text>
          {workspace.muted ? <Text style={styles.muted}>muted</Text> : null}
          {needsPermission ? (
            <View style={styles.permissionBadge}>
              <Text style={styles.permissionText}>PERMISSION</Text>
            </View>
          ) : null}
        </View>
        <View style={styles.metaLine}>
          {showAgent ? <BrandMark backend={workspace.agentBackend} size={11} /> : null}
          <Text style={styles.branch} numberOfLines={1}>
            {meta.join(' · ')}
          </Text>
        </View>
        {workspace.pr ? (
          <Text style={[styles.pr, { color: PR_COLORS[workspace.pr.state] ?? theme.textDim }]}>
            #{workspace.pr.number} · {workspace.pr.label}
          </Text>
        ) : null}
        {limit !== null ? <Text style={styles.limit}>{limit}</Text> : null}
        {parentName !== null ? (
          <Text style={styles.parent} numberOfLines={1}>
            stacked on {parentName}
          </Text>
        ) : null}
      </View>
    </Pressable>
  )
}

export default function WorkspaceListScreen(): React.JSX.Element {
  const router = useRouter()
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
    () => new Map((state?.workspaces ?? []).map((item) => [item.id, workspaceDisplayName(item)])),
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
        <View>
          <Text style={styles.eyebrow}>WOOI REMOTE</Text>
          <Text style={styles.title}>{machineName}</Text>
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
          return (
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionName} numberOfLines={1}>
                {section.repo.name}
              </Text>
              {running > 0 ? <Text style={styles.sectionCount}>{running} running</Text> : null}
            </View>
          )
        }}
        renderItem={({ item }) => (
          <WorkspaceRow
            workspace={item}
            parentName={
              item.parentWorkspaceId == null
                ? null
                : (nameById.get(item.parentWorkspaceId) ?? null)
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
            tintColor="#8b7cf6"
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

const styles = StyleSheet.create({
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
  eyebrow: { color: theme.textDim, fontSize: 10, fontWeight: '700', letterSpacing: 1.5 },
  title: { color: theme.text, fontSize: 22, fontWeight: '600', marginTop: 5 },
  updated: { color: theme.textDim, fontSize: 12, marginTop: 5 },
  connection: { alignItems: 'center', flexDirection: 'row', gap: 6, marginTop: 4 },
  connectionDot: { borderRadius: 4, height: 7, width: 7 },
  connectionText: { color: theme.textDim, fontSize: 11, textTransform: 'capitalize' },
  banner: { backgroundColor: '#2a1719', color: '#e69393', fontSize: 12, padding: 10 },
  list: { paddingBottom: 24 },
  sectionHeader: {
    alignItems: 'center',
    backgroundColor: theme.bg,
    borderBottomColor: theme.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 18,
    paddingVertical: 8
  },
  sectionName: { color: theme.textMuted, flex: 1, fontSize: 12, fontWeight: '700', letterSpacing: 0.3 },
  sectionCount: { color: theme.accent, fontSize: 11 },
  row: {
    alignItems: 'flex-start',
    borderBottomColor: theme.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    minHeight: 66,
    paddingHorizontal: 18,
    paddingVertical: 13
  },
  permissionRow: {
    backgroundColor: theme.surface2,
    borderBottomColor: theme.accentStrong,
    borderLeftColor: theme.accent,
    borderLeftWidth: 3
  },
  dot: { borderRadius: 5, height: 9, marginRight: 12, marginTop: 5, width: 9 },
  permissionDot: { height: 10, width: 10 },
  rowContent: { flex: 1 },
  nameLine: { alignItems: 'center', flexDirection: 'row', gap: 6 },
  stacked: { color: theme.textDim, fontSize: 13 },
  name: { color: theme.text, flexShrink: 1, fontSize: 15, fontWeight: '500' },
  muted: { color: theme.textDim, fontSize: 10 },
  permissionBadge: {
    backgroundColor: theme.accent,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1
  },
  permissionText: { color: '#12101f', fontSize: 9, fontWeight: '800', letterSpacing: 0.6 },
  metaLine: { alignItems: 'center', flexDirection: 'row', gap: 5, marginTop: 3 },
  branch: { color: theme.textDim, flexShrink: 1, fontSize: 12 },
  pr: { fontSize: 11, marginTop: 3 },
  limit: { color: theme.warning, fontSize: 11, marginTop: 3 },
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
