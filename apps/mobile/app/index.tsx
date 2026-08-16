import { useCallback, useMemo, useState } from 'react'
import { Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import type { RemoteWorkspace } from '@shared/remote'
import { AGENT_BACKEND_LABELS, workspaceDisplayName } from '@shared/types'
import { isLaptopAway, useRemoteStore } from '../src/state/store'
import { agoLabel, untilLabel, useNow } from '../src/state/useNow'

const STATUS_COLORS: Record<string, string> = {
  idle: '#676771',
  running: '#8b7cf6',
  error: '#e36d6d'
}

/**
 * 에이전트 표시 이름. 값은 **다른 기기에서 온 문자열**이라 이 앱이 모르는 백엔드일 수 있다
 * (랩탑이 더 새 버전이면 늘 그렇다). 모르면 원문을 그대로 보여 준다 — 빈칸보다 낫고,
 * 무엇보다 화면이 죽지 않는다.
 */
function agentLabel(backend: string): string {
  const labels: Record<string, string | undefined> = AGENT_BACKEND_LABELS
  return labels[backend] ?? backend
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
  const limit = workspace.rateLimit
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
  const meta = [
    showAgent ? agentLabel(workspace.agentBackend) : null,
    workspace.multiAgent ? '+ subagents' : null,
    workspace.branch
  ].filter((part): part is string => part !== null)

  return (
    <Pressable style={[styles.row, needsPermission && styles.permissionRow]} onPress={onPress}>
      <View
        style={[
          styles.dot,
          {
            backgroundColor: needsPermission
              ? '#8b7cf6'
              : limit !== null
                ? '#d0a24c'
                : (STATUS_COLORS[workspace.status] ?? '#676771')
          },
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
        <Text style={styles.branch} numberOfLines={1}>
          {meta.join(' · ')}
        </Text>
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
    if (pairing === null || refreshState === null) return
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
  }, [pairing, refreshState])

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
              { backgroundColor: status === 'online' ? '#6fb38b' : '#676771' }
            ]}
          />
          <Text style={styles.connectionText}>{status}</Text>
        </View>
      </View>
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
              item.parentWorkspaceId === null
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
  screen: { flex: 1, backgroundColor: '#0b0b0d' },
  header: {
    alignItems: 'flex-start',
    borderBottomColor: '#202024',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: 18,
    paddingHorizontal: 18,
    paddingTop: 18
  },
  eyebrow: { color: '#777680', fontSize: 10, fontWeight: '700', letterSpacing: 1.5 },
  title: { color: '#ededf0', fontSize: 22, fontWeight: '600', marginTop: 5 },
  updated: { color: '#6f6f77', fontSize: 12, marginTop: 5 },
  connection: { alignItems: 'center', flexDirection: 'row', gap: 6, marginTop: 4 },
  connectionDot: { borderRadius: 4, height: 7, width: 7 },
  connectionText: { color: '#777780', fontSize: 11, textTransform: 'capitalize' },
  banner: { backgroundColor: '#2a1719', color: '#e69393', fontSize: 12, padding: 10 },
  list: { paddingBottom: 24 },
  sectionHeader: {
    alignItems: 'center',
    backgroundColor: '#0b0b0d',
    borderBottomColor: '#1d1d21',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 18,
    paddingVertical: 8
  },
  sectionName: { color: '#a9a9b3', flex: 1, fontSize: 12, fontWeight: '700', letterSpacing: 0.3 },
  sectionCount: { color: '#8b7cf6', fontSize: 11 },
  row: {
    alignItems: 'flex-start',
    borderBottomColor: '#1d1d21',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    minHeight: 66,
    paddingHorizontal: 18,
    paddingVertical: 13
  },
  permissionRow: {
    backgroundColor: '#171426',
    borderBottomColor: '#51478a',
    borderLeftColor: '#8b7cf6',
    borderLeftWidth: 3
  },
  dot: { borderRadius: 5, height: 9, marginRight: 12, marginTop: 5, width: 9 },
  permissionDot: { height: 10, width: 10 },
  rowContent: { flex: 1 },
  nameLine: { alignItems: 'center', flexDirection: 'row', gap: 6 },
  stacked: { color: '#6f6f77', fontSize: 13 },
  name: { color: '#ededf0', flexShrink: 1, fontSize: 15, fontWeight: '500' },
  muted: { color: '#6f6f77', fontSize: 10 },
  permissionBadge: {
    backgroundColor: '#8b7cf6',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1
  },
  permissionText: { color: '#12101f', fontSize: 9, fontWeight: '800', letterSpacing: 0.6 },
  branch: { color: '#77767f', fontSize: 12, marginTop: 3 },
  limit: { color: '#d0a24c', fontSize: 11, marginTop: 3 },
  parent: { color: '#5f5f68', fontSize: 11, marginTop: 2 },
  emptyList: { flexGrow: 1, justifyContent: 'center' },
  empty: { alignItems: 'center', paddingHorizontal: 32 },
  emptyTitle: { color: '#9a9aa3', fontSize: 15, fontWeight: '500' },
  emptyBody: {
    color: '#6a6a73',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 8,
    textAlign: 'center'
  }
})
