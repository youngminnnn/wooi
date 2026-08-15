import { useCallback, useMemo, useState } from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import type { RemoteWorkspace } from '@shared/remote'
import { workspaceDisplayName } from '@shared/types'
import { useRemoteStore } from '../src/state/store'

const STATUS_COLORS: Record<string, string> = {
  idle: '#676771',
  running: '#8b7cf6',
  error: '#e36d6d'
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

function WorkspaceRow({
  workspace,
  onPress
}: {
  workspace: RemoteWorkspace
  onPress: () => void
}): React.JSX.Element {
  const needsPermission = workspace.attention === 'permission'
  return (
    <Pressable style={[styles.row, needsPermission && styles.permissionRow]} onPress={onPress}>
      <View
        style={[
          styles.dot,
          { backgroundColor: needsPermission ? '#8b7cf6' : STATUS_COLORS[workspace.status] ?? '#676771' },
          needsPermission && styles.permissionDot
        ]}
      />
      <View style={styles.rowContent}>
        <View style={styles.nameLine}>
          <Text style={styles.name} numberOfLines={1}>
            {workspaceDisplayName(workspace)}
          </Text>
          {needsPermission ? (
            <View style={styles.permissionBadge}>
              <Text style={styles.permissionText}>PERMISSION</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.branch} numberOfLines={1}>
          {workspace.branch}
        </Text>
      </View>
    </Pressable>
  )
}

export default function WorkspaceListScreen(): React.JSX.Element {
  const router = useRouter()
  const pairing = useRemoteStore((store) => store.pairing)
  const status = useRemoteStore((store) => store.status)
  const state = useRemoteStore((store) => store.state)
  const updatedAt = useRemoteStore((store) => store.updatedAt)
  const lastError = useRemoteStore((store) => store.lastError)
  const refreshState = useRemoteStore((store) => store.refresh)
  const [refreshing, setRefreshing] = useState(false)
  const workspaces = useMemo(
    () =>
      [...(state?.workspaces ?? [])].sort((left, right) => {
        const permission =
          Number(right.attention === 'permission') - Number(left.attention === 'permission')
        const attention = Number(right.attention !== null) - Number(left.attention !== null)
        return permission || attention || right.lastActiveAt - left.lastActiveAt
      }),
    [state?.workspaces]
  )

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
      {lastError ? <Text style={styles.banner}>{lastError}</Text> : null}
      <FlatList
        data={workspaces}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <WorkspaceRow workspace={item} onPress={() => router.push(`/workspace/${item.id}`)} />
        )}
        contentContainerStyle={workspaces.length === 0 ? styles.emptyList : styles.list}
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
  permissionDot: { borderColor: '#c2b9ff', borderWidth: 2, height: 12, width: 12 },
  rowContent: { flex: 1 },
  nameLine: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  name: { color: '#dedee2', flexShrink: 1, fontSize: 15, fontWeight: '600' },
  branch: { color: '#73737c', fontSize: 12, marginTop: 5 },
  permissionBadge: {
    backgroundColor: '#30294f',
    borderColor: '#695cb2',
    borderRadius: 4,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2
  },
  permissionText: { color: '#b8acf9', fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },
  emptyList: { flexGrow: 1 },
  empty: { flex: 1, justifyContent: 'center', paddingHorizontal: 40, paddingBottom: 80 },
  emptyTitle: { color: '#d8d8dc', fontSize: 17, fontWeight: '600', textAlign: 'center' },
  emptyBody: { color: '#707078', fontSize: 13, lineHeight: 20, marginTop: 8, textAlign: 'center' }
})
