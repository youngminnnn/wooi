import { useEffect, useRef } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { Stack, usePathname, useRouter } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import * as Notifications from 'expo-notifications'
import { RelayClient } from '../src/relay/client'
import { openPushPayload } from '../src/notifications/payload'
import { requestPushToken } from '../src/notifications/register'
import { useRemoteStore } from '../src/state/store'
import { clearCommandSequence, clearPairing, loadPairing } from '../src/storage/secure'
import { theme } from '../src/theme'

// 배너는 내용이 없다(고정 문구). 소리는 울리되 배지는 건드리지 않는다 —
// 읽음 계산은 폰이 로컬로 하고, 서버가 준 숫자가 아니다.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false
  })
})

export default function RootLayout(): React.JSX.Element {
  const router = useRouter()
  const pathname = usePathname()
  const client = useRef<RelayClient | null>(null)
  const pushRegistered = useRef(false)
  // 콜드스타트 응답은 앱이 살아 있는 동안 계속 같은 값을 돌려준다. 한 번 처리한
  // 알림 id 를 기억하지 않으면 실행할 때마다 같은 워크스페이스로 튕긴다.
  const handledResponses = useRef(new Set<string>())
  const hydrated = useRemoteStore((store) => store.hydrated)
  const demo = useRemoteStore((store) => store.demo)
  const pairing = useRemoteStore((store) => store.pairing)
  const status = useRemoteStore((store) => store.status)

  useEffect(() => {
    void loadPairing().then((stored) => {
      const store = useRemoteStore.getState()
      store.setPairing(stored)
      store.setHydrated(true)
    })
  }, [])

  useEffect(() => {
    if (!hydrated) return
    if (pairing === null && !demo) {
      if (pathname !== '/pair') router.replace('/pair')
      return
    }
    if ((pairing !== null || demo) && pathname === '/pair') router.replace('/')
  }, [demo, hydrated, pairing, pathname, router])

  useEffect(() => {
    // 데모는 자격 증명이 없는 별도 실행 모드다. 여기서 먼저 끊어야 Supabase 클라이언트와
    // SecureStore 기반 인증 저장소가 생성조차 되지 않는다.
    if (!hydrated || pairing === null || demo) return
    pushRegistered.current = false
    const relay = new RelayClient(pairing, {
      onStatus: useRemoteStore.getState().setStatus,
      onState: useRemoteStore.getState().setState,
      onUpdatedAt: useRemoteStore.getState().setUpdatedAt,
      onLaptopSeen: useRemoteStore.getState().setLaptopSeenAt,
      // 랩탑이 끊었다면 저장된 키를 붙들고 있을 이유가 없다 — 그 키로는 아무것도 열리지
      // 않는다. 지우고 페어링 화면으로 돌려보내되, 왜 돌아왔는지는 말해 준다.
      onRevoked: () => {
        void Promise.allSettled([clearPairing(), clearCommandSequence(pairing.deviceId)]).finally(
          () => {
            useRemoteStore
              .getState()
              .unpaired('Your laptop disconnected this phone. Pair again to reconnect.')
          }
        )
      },
      onError: useRemoteStore.getState().setLastError,
      onActivity: useRemoteStore.getState().bumpActivity
    })
    client.current = relay
    useRemoteStore.getState().setRefresh(() => relay.refresh())
    useRemoteStore.getState().setCommand((channel, args) => relay.command(channel, args))
    useRemoteStore.getState().setUnpair(() => relay.unpairSelf())
    void relay.connect()
    return () => {
      useRemoteStore.getState().setRefresh(null)
      useRemoteStore.getState().setCommand(null)
      useRemoteStore.getState().setUnpair(null)
      relay.disconnect()
      client.current = null
    }
  }, [demo, hydrated, pairing])

  // 토큰 등록은 **온라인이 된 뒤** 한 번. 오프라인에서 시도하면 실패만 하고,
  // 재시도는 다음 온라인 전이가 공짜로 준다.
  useEffect(() => {
    const relay = client.current
    if (status !== 'online' || relay === null || pushRegistered.current) return
    pushRegistered.current = true
    void (async () => {
      try {
        const token = await requestPushToken()
        if (token === null) return
        await relay.savePushToken(token)
      } catch (error) {
        pushRegistered.current = false
        console.warn('푸시 등록 실패', error)
      }
    })()
  }, [status])

  // 알림 탭 → 봉인된 페이로드를 열어 해당 워크스페이스로. 열 수 없으면 아무 일도 하지 않는다.
  useEffect(() => {
    if (pairing === null) return
    let cancelled = false
    const handle = (response: Notifications.NotificationResponse | null): void => {
      if (response === null || cancelled) return
      const id = response.notification.request.identifier
      if (handledResponses.current.has(id)) return
      handledResponses.current.add(id)
      const target = openPushPayload(pairing, response.notification.request.content.data)
      if (target !== null) router.push(`/workspace/${target.workspaceId}`)
    }
    void Notifications.getLastNotificationResponseAsync().then(handle)
    const subscription = Notifications.addNotificationResponseReceivedListener(handle)
    return () => {
      cancelled = true
      subscription.remove()
    }
  }, [pairing, router])

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
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.bg },
  content: { backgroundColor: theme.bg }
})
