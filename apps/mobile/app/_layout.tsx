import { useEffect, useRef } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { Stack, usePathname, useRouter } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { RelayClient } from '../src/relay/client'
import { useRemoteStore } from '../src/state/store'
import { loadPairing } from '../src/storage/secure'

export default function RootLayout(): React.JSX.Element {
  const router = useRouter()
  const pathname = usePathname()
  const client = useRef<RelayClient | null>(null)
  const hydrated = useRemoteStore((store) => store.hydrated)
  const pairing = useRemoteStore((store) => store.pairing)

  useEffect(() => {
    void loadPairing().then((stored) => {
      const store = useRemoteStore.getState()
      store.setPairing(stored)
      store.setHydrated(true)
    })
  }, [])

  useEffect(() => {
    if (!hydrated) return
    if (pairing === null) {
      if (pathname !== '/pair') router.replace('/pair')
      return
    }
    if (pathname === '/pair') router.replace('/')
  }, [hydrated, pairing, pathname, router])

  useEffect(() => {
    if (!hydrated || pairing === null) return
    const relay = new RelayClient(pairing, {
      onStatus: useRemoteStore.getState().setStatus,
      onState: useRemoteStore.getState().setState,
      onUpdatedAt: useRemoteStore.getState().setUpdatedAt,
      onError: useRemoteStore.getState().setLastError,
      onActivity: useRemoteStore.getState().bumpActivity
    })
    client.current = relay
    useRemoteStore.getState().setRefresh(() => relay.refresh())
    useRemoteStore.getState().setCommand((channel, args) => relay.command(channel, args))
    void relay.connect()
    return () => {
      useRemoteStore.getState().setRefresh(null)
      useRemoteStore.getState().setCommand(null)
      relay.disconnect()
      client.current = null
    }
  }, [hydrated, pairing])

  if (!hydrated) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color="#8b7cf6" />
        <StatusBar style="light" />
      </View>
    )
  }

  return (
    <>
      <Stack screenOptions={{ headerShown: false, contentStyle: styles.content }} />
      <StatusBar style="light" />
    </>
  )
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0b0b0d' },
  content: { backgroundColor: '#0b0b0d' }
})
