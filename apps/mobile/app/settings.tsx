import { useCallback, useState } from 'react'
import { Alert, Linking, ScrollView, StyleSheet, Text, Pressable, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useFocusEffect, useRouter } from 'expo-router'
import Constants from 'expo-constants'
import * as Notifications from 'expo-notifications'
import { ChevronLeft } from 'lucide-react-native'
import { SettingsRow } from '../src/components/settings/SettingsRow'
import { SettingsSection } from '../src/components/settings/SettingsSection'
import { UsageRow } from '../src/components/settings/UsageRow'
import { ThemeRow } from '../src/components/settings/ThemeRow'
import { isLaptopAway, useRemoteStore } from '../src/state/store'
import { agoLabel, useNow } from '../src/state/useNow'
import { unpairThisPhone } from '../src/state/unpair'
import { useTheme, useThemedStyles } from '../src/state/theme'
import type { Theme } from '../src/theme'

type NotificationLabel = 'Enabled' | 'Blocked' | 'Not asked yet' | '—'

export default function SettingsScreen(): React.JSX.Element {
  const router = useRouter()
  const theme = useTheme()
  const styles = useThemedStyles(makeStyles)
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

  // 보여 줄 것이 없으면(요금제 한도 미적용 계정, 아직 한 번도 조회 못 함, 이 필드를 모르는
  // 예전 랩탑) 랩탑이 빈 목록을 준다 — 그때는 섹션 자체가 나타나지 않는다.
  const planUsage = state?.planUsage ?? []
  const away = isLaptopAway(laptopSeenAt, now)
  const connectionStatus = away
    ? `Asleep or offline${laptopSeenAt === null ? '' : ` · ${agoLabel(laptopSeenAt, now)}`}`
    : status === 'online'
      ? 'Connected'
      : status === 'connecting'
        ? 'Connecting…'
        : 'Phone offline'

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
            <SettingsRow
              destructive
              disabled={unpairing}
              label="Unpair this phone"
              loading={unpairing}
              onPress={confirmUnpair}
            />
          </SettingsSection>
        )}

        {planUsage.map((account) => (
          <SettingsSection
            key={account.agent}
            title={planUsage.length > 1 ? `Plan usage · ${account.agentLabel}` : 'Plan usage'}
          >
            {account.windows.map((usage) => (
              <UsageRow key={usage.label} now={now} usage={usage} />
            ))}
            {account.plan === null ? null : <SettingsRow label="Plan" value={account.plan} />}
            {/* 랩탑은 세션이 도는 동안에만 한도를 다시 조회한다 — 폰이 보는 값은 몇 시간 묵었을
                수 있고, 그걸 말하지 않으면 지금 수치로 읽힌다. */}
            <SettingsRow label="Checked" value={agoLabel(account.fetchedAt, now)} />
          </SettingsSection>
        ))}

        <SettingsSection title="Appearance">
          <ThemeRow />
        </SettingsSection>

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
        </SettingsSection>
      </ScrollView>
    </SafeAreaView>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
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
    pressed: { backgroundColor: theme.pressed },
    headerTitle: { color: theme.text, flex: 1, fontSize: 18, fontWeight: '600', textAlign: 'center' },
    headerSpacer: { width: 36 },
    content: { gap: 24, paddingBottom: 40, paddingHorizontal: 18, paddingTop: 22 }
  })
