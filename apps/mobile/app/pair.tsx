import { useCallback, useState } from 'react'
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View
} from 'react-native'
import Constants from 'expo-constants'
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera'
import { SafeAreaView } from 'react-native-safe-area-context'
import { claimPairing, type ClaimedPairing } from '../src/relay/pairing'
import { useRemoteStore } from '../src/state/store'
import { theme } from '../src/theme'

type Phase = 'scan' | 'claiming' | 'verify' | 'error'

function deviceName(): string {
  if (Constants.deviceName?.trim()) return Constants.deviceName.trim()
  return Platform.OS === 'ios' ? 'iPhone' : 'Android phone'
}

export default function PairScreen(): React.JSX.Element {
  const [permission, requestPermission] = useCameraPermissions()
  const [phase, setPhase] = useState<Phase>('scan')
  const [claim, setClaim] = useState<ClaimedPairing | null>(null)
  const [error, setError] = useState<string | null>(null)

  const finish = useCallback(async (pending: ClaimedPairing): Promise<void> => {
    setPhase('verify')
    setClaim(pending)
    try {
      const pairing = await pending.finish()
      useRemoteStore.getState().setPairing(pairing)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Pairing failed')
      setPhase('error')
    }
  }, [])

  const scan = useCallback(
    (result: BarcodeScanningResult): void => {
      if (phase !== 'scan') return
      setPhase('claiming')
      setError(null)
      void claimPairing(result.data, deviceName())
        .then(finish)
        .catch((caught: unknown) => {
          setError(caught instanceof Error ? caught.message : 'Pairing failed')
          setPhase('error')
        })
    },
    [finish, phase]
  )

  const rescan = (): void => {
    setClaim(null)
    setError(null)
    setPhase('scan')
  }

  if (!permission) return <PairLoading label="Checking camera access…" />

  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.center}>
          <Text style={styles.eyebrow}>WOOI REMOTE</Text>
          <Text style={styles.title}>Pair this phone</Text>
          <Text style={styles.body}>
            Camera access is needed to scan the one-time pairing code shown by Wooi on your laptop.
          </Text>
          <Pressable style={styles.button} onPress={() => void requestPermission()}>
            <Text style={styles.buttonText}>Allow camera</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    )
  }

  if (phase === 'claiming') return <PairLoading label="Claiming one-time code…" />

  if (phase === 'verify' && claim !== null) {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.center}>
          <Text style={styles.eyebrow}>VERIFY CONNECTION</Text>
          <Text style={styles.machine}>{claim.machineName}</Text>
          <Text style={styles.sas}>{claim.sas.slice(0, 3)} {claim.sas.slice(3)}</Text>
          <Text style={styles.warning}>
            Continue only if your laptop shows exactly these six digits. If they differ, reject the
            request on your laptop — someone else may have claimed the code.
          </Text>
          <View style={styles.waitingRow}>
            <ActivityIndicator color="#8b7cf6" size="small" />
            <Text style={styles.waiting}>Waiting for confirmation on your laptop…</Text>
          </View>
        </View>
      </SafeAreaView>
    )
  }

  if (phase === 'error') {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.center}>
          <Text style={styles.eyebrow}>PAIRING FAILED</Text>
          <Text style={styles.title}>Could not pair</Text>
          <Text style={styles.error}>{error}</Text>
          <Pressable style={styles.button} onPress={rescan}>
            <Text style={styles.buttonText}>Scan again</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    )
  }

  return (
    <View style={styles.screen}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={scan}
      />
      <SafeAreaView style={styles.cameraOverlay}>
        <Text style={styles.eyebrow}>WOOI REMOTE</Text>
        <Text style={styles.cameraTitle}>Scan the code on your laptop</Text>
        <View style={styles.frame} />
        <Text style={styles.cameraHint}>The code is single-use and expires after five minutes.</Text>
      </SafeAreaView>
    </View>
  )
}

function PairLoading({ label }: { label: string }): React.JSX.Element {
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.center}>
        <ActivityIndicator color="#8b7cf6" />
        <Text style={styles.waiting}>{label}</Text>
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  center: { flex: 1, justifyContent: 'center', paddingHorizontal: 28 },
  eyebrow: { color: theme.accent, fontSize: 11, fontWeight: '700', letterSpacing: 1.8 },
  title: { color: theme.text, fontSize: 28, fontWeight: '600', marginTop: 10 },
  body: { color: theme.textMuted, fontSize: 15, lineHeight: 22, marginTop: 14 },
  machine: { color: theme.textMuted, fontSize: 16, marginTop: 14 },
  sas: {
    color: '#f5f4ff',
    fontSize: 48,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
    letterSpacing: 4,
    marginVertical: 28
  },
  warning: { color: theme.textMuted, fontSize: 15, lineHeight: 23 },
  waitingRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 28 },
  waiting: { color: theme.textDim, fontSize: 14, marginTop: 14 },
  error: { color: '#ef8585', fontSize: 15, lineHeight: 22, marginTop: 14 },
  button: {
    alignSelf: 'flex-start',
    backgroundColor: theme.accentStrong,
    borderRadius: 8,
    marginTop: 26,
    paddingHorizontal: 18,
    paddingVertical: 12
  },
  buttonText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  cameraOverlay: { flex: 1, alignItems: 'center', paddingHorizontal: 24, paddingTop: 32 },
  cameraTitle: { color: '#fff', fontSize: 20, fontWeight: '600', marginTop: 10 },
  frame: {
    borderColor: theme.accent,
    borderRadius: 18,
    borderWidth: 2,
    height: 260,
    marginTop: 72,
    width: 260
  },
  cameraHint: {
    backgroundColor: 'rgba(11,11,13,0.84)',
    borderRadius: 8,
    color: theme.textMuted,
    fontSize: 13,
    marginTop: 36,
    overflow: 'hidden',
    paddingHorizontal: 14,
    paddingVertical: 10
  }
})
