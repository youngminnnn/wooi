import { useCallback, useState } from 'react'
import { Alert, Linking, ScrollView, StyleSheet, Text, Pressable, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useFocusEffect, useRouter } from 'expo-router'
import Constants from 'expo-constants'
import * as Notifications from 'expo-notifications'
import { ChevronLeft } from 'lucide-react-native'
import { SettingsRow } from '../src/components/settings/SettingsRow'
import { SettingsSection } from '../src/components/settings/SettingsSection'
import { isLaptopAway, useRemoteStore } from '../src/state/store'
import { agoLabel, useNow } from '../src/state/useNow'
import { unpairThisPhone } from '../src/state/unpair'
import { theme } from '../src/theme'

type NotificationLabel = 'Enabled' | 'Blocked' | 'Not asked yet' | '—'

/**
 * 업데이트 정보는 네이티브 모듈이 있어야 읽을 수 있고, 없으면 **import 하는 것만으로** 터진다
 * (`Cannot find native module 'ExpoUpdates'`). 실제로 expo-updates 가 없는 dev client 에서
 * 이 화면이 통째로 뜨지 않았다. 앱 정보 두 줄 때문에 설정 화면을 잃을 이유가 없으므로,
 * 모듈 접근을 감싸고 없으면 값만 비운다.
 */
function updateInfo(): { channel: string; id: string } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Updates = require('expo-updates') as typeof import('expo-updates')
    return {
      channel: Updates.channel ?? (Updates.isEmbeddedLaunch ? 'Embedded' : '—'),
      id: Updates.isEmbeddedLaunch ? 'Embedded' : (Updates.updateId ?? '—')
    }
  } catch {
    return { channel: '—', id: '—' }
  }
}

export default function SettingsScreen(): React.JSX.Element {
  const router = useRouter()
  const demo = useRemoteStore((store) => store.demo)
  const pairing = useRemoteStore((store) => store.pairing)
  const state = useRemoteStore((store) => store.state)
  const status = useRemoteStore((store) => store.status)
  const updatedAt = useRemoteStore((store) => store.updatedAt)
  const laptopSeenAt = useRemoteStore((store) => store.laptopSeenAt)
  const leaveDemo = useRemoteStore((store) => store.leaveDemo)
  const now = useNow()
  const [notificationPermission, setNotificationPermission] = useState<NotificationLabel>('—')
  const [unpairing, setUnpairing] = useState(false)

  useFocusEffect(
    useCallback(() => {
      let active = true
      void Notifications.getPermissionsAsync()
        .then((permission) => {
          if (!active) return
          const provisional =
            permission.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL
          setNotificationPermission(
            permission.granted || provisional
              ? 'Enabled'
              : permission.status === Notifications.PermissionStatus.UNDETERMINED
                ? 'Not asked yet'
                : 'Blocked'
          )
        })
        .catch(() => active && setNotificationPermission('—'))
      return () => {
        active = false
      }
    }, [])
  )

  /**
   * 기기 인증을 걸지 않는다. 권한 승인·프롬프트 전송은 **랩탑에 일을 시키는** 동작이라 잠금
   * 해제된 폰을 주운 사람을 막아야 하지만, 해제는 이 폰의 접근을 **없애는** 동작이다 — 그 사람이
   * 눌러 봐야 자기 접근만 잃는다. 막아 주는 것에 비해 마찰이 크다(생체 미등록 기기에서는
   * 기기 암호까지 물린다). 되돌릴 수 없다는 사실은 확인 다이얼로그가 말한다.
   */
  const confirmUnpair = useCallback((): void => {
    Alert.alert(
      'Unpair this phone?',
      'This phone will stop receiving sessions and notifications. To reconnect, get a new pairing code from your laptop.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unpair',
          style: 'destructive',
          onPress: () => {
            setUnpairing(true)
            void unpairThisPhone().finally(() => {
              // 첫 화면까지 비운 뒤 교체해야 죽은 워크스페이스 화면이 뒤로 가기에 남지 않는다.
              router.dismissAll()
              router.replace('/pair')
            })
          }
        }
      ]
    )
  }, [router])

  const away = isLaptopAway(laptopSeenAt, now)
  const connectionStatus = away
    ? `Asleep or offline${laptopSeenAt === null ? '' : ` · ${agoLabel(laptopSeenAt, now)}`}`
    : status === 'online'
      ? 'Connected'
      : status === 'connecting'
        ? 'Connecting…'
        : 'Phone offline'
  const update = updateInfo()

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
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
        <Text style={styles.headerTitle}>Settings</Text>
        <View style={styles.headerSpacer} />
      </View>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {demo && pairing === null ? (
          <SettingsSection title="Connection">
            <SettingsRow label="Mode" value="Demo data" />
            <SettingsRow label="Exit demo" accessory="chevron" onPress={leaveDemo} />
          </SettingsSection>
        ) : (
          <SettingsSection title="Connection">
            <SettingsRow label="Laptop" value={state?.machine.name ?? pairing?.machineName ?? '—'} />
            <SettingsRow label="Status" value={connectionStatus} />
            <SettingsRow
              label="Last update"
              value={updatedAt === null ? '—' : agoLabel(updatedAt, now)}
            />
            <SettingsRow label="This phone" value={Constants.deviceName ?? '—'} />
            <SettingsRow
              destructive
              disabled={unpairing}
              label="Unpair this phone"
              loading={unpairing}
              onPress={confirmUnpair}
            />
          </SettingsSection>
        )}

        <SettingsSection title="Notifications">
          <SettingsRow label="Permission" value={notificationPermission} />
          <SettingsRow
            label="Open system settings"
            accessory="chevron"
            onPress={() => void Linking.openSettings()}
          />
        </SettingsSection>

        <SettingsSection title="About">
          <SettingsRow label="Version" value={Constants.expoConfig?.version ?? '—'} />
          <SettingsRow label="Update channel" value={update.channel} />
          <SettingsRow label="Update ID" value={update.id} />
        </SettingsSection>
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { backgroundColor: theme.bg, flex: 1 },
  header: {
    alignItems: 'center',
    borderBottomColor: theme.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    height: 58,
    paddingHorizontal: 14
  },
  back: { alignItems: 'center', borderRadius: 18, height: 36, justifyContent: 'center', width: 36 },
  pressed: { backgroundColor: theme.surface2 },
  headerTitle: { color: theme.text, flex: 1, fontSize: 18, fontWeight: '600', textAlign: 'center' },
  headerSpacer: { width: 36 },
  content: { gap: 24, paddingBottom: 40, paddingHorizontal: 18, paddingTop: 22 }
})
