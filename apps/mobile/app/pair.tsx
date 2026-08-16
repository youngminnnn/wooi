import { useCallback, useState, type ReactNode } from 'react'
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import Constants from 'expo-constants'
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera'
import { SafeAreaView } from 'react-native-safe-area-context'
import { claimPairing, type ClaimedPairing } from '../src/relay/pairing'
import { useRemoteStore } from '../src/state/store'
import { theme } from '../src/theme'

type Phase = 'scan' | 'paste' | 'claiming' | 'verify' | 'error'

function deviceName(): string {
  if (Constants.deviceName?.trim()) return Constants.deviceName.trim()
  return Platform.OS === 'ios' ? 'iPhone' : 'Android phone'
}

/**
 * 페어링 화면들의 공통 틀.
 *
 * 이 앱을 처음 켜면 나오는 화면이라, 여기서 받는 인상이 제품의 인상이 된다. 세 덩이로
 * 나눈다 — 위에 정체(마크·이름·한 줄 설명), 가운데에 지금 할 일, 아래에 행동. 가운데
 * 하나만 두고 세로 가운데정렬을 하면 위아래가 크게 비어 화면이 미완성으로 읽힌다.
 *
 * 마크는 **앱 아이콘 그 파일**을 그린다. 별도 로고를 두면 홈 화면의 아이콘과 여기가
 * 조금씩 달라지고, 방금 누른 그 앱이 맞는지 확인해 주는 역할을 못 한다.
 */
function PairShell({
  children,
  footer
}: {
  children: ReactNode
  footer?: ReactNode
}): React.JSX.Element {
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.shell}>
        <View style={styles.hero}>
          <Image source={require('../assets/icon.png')} style={styles.mark} />
          <View style={styles.heroText}>
            <Text style={styles.wordmark}>Wooi</Text>
            <Text style={styles.tagline}>Your laptop&apos;s coding sessions, on your phone.</Text>
          </View>
        </View>
        <ScrollView
          style={styles.content}
          contentContainerStyle={styles.contentInner}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </ScrollView>
        {footer !== undefined ? <View style={styles.footer}>{footer}</View> : null}
      </View>
    </SafeAreaView>
  )
}

/** 페어링이 어떻게 흘러가는지 세 줄. 첫 화면에서 가장 자주 막히는 곳이 "코드가 어디 있나"다. */
function Steps(): React.JSX.Element {
  const steps = [
    'Open Wooi on your laptop',
    'Settings → Integrations → Remote access',
    'Scan the code, then check the six digits match'
  ]
  return (
    <View style={styles.steps}>
      {steps.map((step, index) => (
        <View key={step} style={styles.step}>
          <View style={styles.stepBadge}>
            <Text style={styles.stepNumber}>{index + 1}</Text>
          </View>
          <Text style={styles.stepText}>{step}</Text>
        </View>
      ))}
    </View>
  )
}

/** 되돌아온 이유(연결 해제·만료)는 본문에 섞으면 안 읽힌다 — 색과 테두리로 분리한다. */
function Notice({ text }: { text: string | null }): React.JSX.Element | null {
  if (text === null) return null
  return (
    <View style={styles.notice}>
      <Text style={styles.noticeText}>{text}</Text>
    </View>
  )
}

function PrimaryButton({
  label,
  onPress,
  disabled = false
}: {
  label: string
  onPress: () => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.primary,
        disabled && styles.primaryDisabled,
        pressed && !disabled && styles.pressed
      ]}
    >
      <Text style={styles.primaryText}>{label}</Text>
    </Pressable>
  )
}

function LinkButton({ label, onPress }: { label: string; onPress: () => void }): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      hitSlop={10}
      style={({ pressed }) => [styles.link, pressed && styles.pressed]}
    >
      <Text style={styles.linkText}>{label}</Text>
    </Pressable>
  )
}

export default function PairScreen(): React.JSX.Element {
  const [permission, requestPermission] = useCameraPermissions()
  const [phase, setPhase] = useState<Phase>('scan')
  const [claim, setClaim] = useState<ClaimedPairing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pasted, setPasted] = useState('')
  const unpairedReason = useRemoteStore((store) => store.unpairedReason)

  /**
   * 데모는 페어링의 대안이지 경쟁자가 아니다. 주 행동(카메라 허용·페어링)보다 조용하되,
   * 구분선 아래 자기 자리를 갖는다 — 랩탑이 없는 사람(심사자를 포함해)이 이 화면에서
   * 막히면 앱은 아무것도 보여주지 못한 채로 끝난다.
   */
  const demoButton = (
    <View>
      <View style={styles.divider}>
        <View style={styles.rule} />
        <Text style={styles.dividerLabel}>or</Text>
        <View style={styles.rule} />
      </View>
      <Pressable
        accessibilityRole="button"
        style={({ pressed }) => [styles.demoButton, pressed && styles.pressed]}
        onPress={() => useRemoteStore.getState().enterDemo()}
      >
        <Text style={styles.demoButtonText}>Try the demo</Text>
        <Text style={styles.demoButtonHint}>Explore Wooi with sample sessions</Text>
      </Pressable>
    </View>
  )

  const finish = useCallback(async (pending: ClaimedPairing): Promise<void> => {
    setPhase('verify')
    setClaim(pending)
    try {
      const pairing = await pending.finish()
      useRemoteStore.getState().setUnpairedReason(null)
      useRemoteStore.getState().setPairing(pairing)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Pairing failed')
      setPhase('error')
    }
  }, [])

  /**
   * 붙여넣기로 페어링한다.
   *
   * 카메라가 유일한 경로면 막히는 경우가 실제로 있다 — 권한을 거부했거나, 기기에 카메라가
   * 없거나(시뮬레이터), 랩탑 화면을 카메라로 겨눌 수 없는 상황. QR 이 나르는 것은 문자열
   * 하나이므로 그것을 그대로 받으면 같은 경로를 탄다. 보안 성질도 같다 — 여전히 1회용
   * 코드이고, 여전히 여섯 자리 SAS 를 사람이 확인해야 키가 만들어진다.
   */
  const pair = useCallback(
    (payload: string): void => {
      const trimmed = payload.trim()
      if (trimmed.length === 0) return
      setPhase('claiming')
      setError(null)
      void claimPairing(trimmed, deviceName())
        .then(finish)
        .catch((caught: unknown) => {
          setError(caught instanceof Error ? caught.message : 'Pairing failed')
          setPhase('error')
        })
    },
    [finish]
  )

  const scan = useCallback(
    (result: BarcodeScanningResult): void => {
      if (phase !== 'scan') return
      pair(result.data)
    },
    [pair, phase]
  )

  const rescan = (): void => {
    setClaim(null)
    setError(null)
    setPasted('')
    setPhase('scan')
  }

  // 화면 선택은 **phase 가 먼저**다. 카메라 권한은 스캔 경로에만 필요한데, 그 검사가 앞에
  // 있으면 권한이 없는 동안 phase 가 무엇이든 권한 안내 화면이 그려진다. 그래서 붙여넣기로
  // 페어링했을 때 **여섯 자리 확인 화면이 통째로 건너뛰어졌다** — 사용자는 대조할 숫자를 보지
  // 못한 채 랩탑에서 승인 버튼만 누르게 되고, 페어링의 유일한 인증 단계가 사라진다.
  if (phase === 'claiming') return <PairLoading label="Claiming one-time code…" />

  if (phase === 'verify' && claim !== null) {
    // 확인 화면에는 마크를 두지 않는다. 대조할 여섯 자리 말고는 아무것도 보지 않아야 한다.
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.focus}>
          <Text style={styles.eyebrow}>VERIFY CONNECTION</Text>
          <Text style={styles.machine}>{claim.machineName}</Text>
          <Text style={styles.sas}>
            {claim.sas.slice(0, 3)} {claim.sas.slice(3)}
          </Text>
          <Text style={styles.warning}>
            Continue only if your laptop shows exactly these six digits. If they differ, reject the
            request on your laptop — someone else may have claimed the code.
          </Text>
          <View style={styles.waitingRow}>
            <ActivityIndicator color={theme.accent} size="small" />
            <Text style={styles.waiting}>Waiting for confirmation on your laptop…</Text>
          </View>
        </View>
      </SafeAreaView>
    )
  }

  if (phase === 'error') {
    return (
      <PairShell
        footer={
          <>
            <PrimaryButton label="Try again" onPress={rescan} />
            {demoButton}
          </>
        }
      >
        <Text style={styles.title}>Could not pair</Text>
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      </PairShell>
    )
  }

  if (phase === 'paste') {
    return (
      <PairShell
        footer={
          <>
            <PrimaryButton
              label="Pair"
              disabled={pasted.trim().length === 0}
              onPress={() => pair(pasted)}
            />
            <LinkButton label="Scan a QR code instead" onPress={rescan} />
            {demoButton}
          </>
        }
      >
        <Text style={styles.title}>Paste the pairing code</Text>
        <Notice text={unpairedReason} />
        <Text style={styles.body}>
          On your laptop, open Settings → Integrations → Remote access → Pair a phone, then copy the
          code shown under the QR.
        </Text>
        <TextInput
          style={styles.input}
          value={pasted}
          onChangeText={setPasted}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          placeholder="wooi://pair?…"
          placeholderTextColor={theme.textFaint}
        />
      </PairShell>
    )
  }

  // 여기부터는 스캔 경로다 — 이 아래에서만 카메라가 필요하다.
  if (permission === null) return <PairLoading label="Checking camera access…" />

  if (!permission.granted) {
    return (
      <PairShell
        footer={
          <>
            <PrimaryButton label="Allow camera" onPress={() => void requestPermission()} />
            <LinkButton label="Paste the code instead" onPress={() => setPhase('paste')} />
            {demoButton}
          </>
        }
      >
        <Text style={styles.title}>Pair this phone</Text>
        <Notice text={unpairedReason} />
        <Text style={styles.body}>
          Wooi shows a one-time code on your laptop. Scan it to set up an end-to-end encrypted link
          — the relay in between never sees your sessions.
        </Text>
        <Steps />
      </PairShell>
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
        <View style={styles.cameraHeader}>
          <Text style={styles.cameraTitle}>Scan the code on your laptop</Text>
          <Text style={styles.cameraHint}>Single-use, expires after five minutes.</Text>
          {unpairedReason !== null ? <Notice text={unpairedReason} /> : null}
        </View>
        {/* 네 귀퉁이만 그린다. 사각 테두리는 어디에 겨눠야 하는지를 말해 주지 않는다. */}
        <View style={styles.frameArea}>
          <View style={styles.frame}>
            <View style={[styles.corner, styles.cornerTopLeft]} />
            <View style={[styles.corner, styles.cornerTopRight]} />
            <View style={[styles.corner, styles.cornerBottomLeft]} />
            <View style={[styles.corner, styles.cornerBottomRight]} />
          </View>
        </View>
        <View style={styles.cameraFooter}>
          <LinkButton label="Can't scan? Paste the code" onPress={() => setPhase('paste')} />
          {demoButton}
        </View>
      </SafeAreaView>
    </View>
  )
}

function PairLoading({ label }: { label: string }): React.JSX.Element {
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.focus}>
        <ActivityIndicator color={theme.accent} />
        <Text style={styles.waiting}>{label}</Text>
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  shell: { flex: 1, paddingHorizontal: 24, paddingBottom: 16 },
  focus: { flex: 1, justifyContent: 'center', paddingHorizontal: 28 },

  // ── 정체 ────────────────────────────────────────────────────────────────
  // 마크와 이름을 가로로 눕힌다. 세로로 쌓으면 이름이 제목만큼 커 보여서, 화면에 큰 글씨
  // 두 개가 무엇이 먼저인지 다투게 된다.
  hero: { alignItems: 'center', flexDirection: 'row', gap: 13, paddingTop: 26 },
  mark: { borderRadius: 13, height: 54, width: 54 },
  heroText: { flex: 1 },
  wordmark: { color: theme.text, fontSize: 18, fontWeight: '600', letterSpacing: -0.2 },
  tagline: { color: theme.textDim, fontSize: 13, lineHeight: 18, marginTop: 2 },

  // ── 지금 할 일 ──────────────────────────────────────────────────────────
  content: { flex: 1 },
  contentInner: { flexGrow: 1, paddingBottom: 24, paddingTop: 44 },
  title: { color: theme.text, fontSize: 26, fontWeight: '600', letterSpacing: -0.4 },
  body: { color: theme.textMuted, fontSize: 15, lineHeight: 22, marginTop: 12 },
  steps: { gap: 14, marginTop: 28 },
  step: { alignItems: 'center', flexDirection: 'row', gap: 12 },
  stepBadge: {
    alignItems: 'center',
    borderColor: theme.border2,
    borderRadius: 11,
    borderWidth: 1,
    height: 22,
    justifyContent: 'center',
    width: 22
  },
  stepNumber: { color: theme.accent, fontSize: 12, fontWeight: '600' },
  stepText: { color: theme.textDim, flex: 1, fontSize: 14, lineHeight: 19 },
  input: {
    backgroundColor: theme.surface,
    borderColor: theme.border,
    borderRadius: 10,
    borderWidth: 1,
    color: theme.text,
    fontSize: 13,
    marginTop: 16,
    maxHeight: 140,
    minHeight: 88,
    padding: 12,
    textAlignVertical: 'top'
  },
  notice: {
    backgroundColor: 'rgba(255,185,0,0.09)',
    borderColor: 'rgba(255,185,0,0.32)',
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 14,
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  noticeText: { color: theme.warning, fontSize: 13, lineHeight: 19 },
  errorBox: {
    backgroundColor: 'rgba(255,100,103,0.09)',
    borderColor: 'rgba(255,100,103,0.32)',
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 14,
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  errorText: { color: theme.danger, fontSize: 14, lineHeight: 20 },

  // ── 행동 ────────────────────────────────────────────────────────────────
  // 너비를 통일한다. 주 버튼만 좁고 데모만 넓으면 위계가 뒤집혀 보인다.
  footer: { gap: 4 },
  primary: {
    alignItems: 'center',
    backgroundColor: theme.accentStrong,
    borderRadius: 12,
    paddingVertical: 15
  },
  primaryDisabled: { opacity: 0.35 },
  primaryText: { color: '#ffffff', fontSize: 16, fontWeight: '600' },
  link: { alignItems: 'center', paddingVertical: 12 },
  linkText: { color: theme.accent, fontSize: 14, fontWeight: '500' },
  pressed: { opacity: 0.7 },
  divider: { alignItems: 'center', flexDirection: 'row', gap: 12, marginBottom: 14, marginTop: 6 },
  rule: { backgroundColor: theme.border, flex: 1, height: StyleSheet.hairlineWidth },
  dividerLabel: { color: theme.textFaint, fontSize: 12 },
  demoButton: {
    alignItems: 'center',
    backgroundColor: theme.surface,
    borderColor: theme.border2,
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 13
  },
  demoButtonText: { color: theme.accent, fontSize: 15, fontWeight: '600' },
  demoButtonHint: { color: theme.textDim, fontSize: 12, marginTop: 3 },

  // ── 확인(SAS) ───────────────────────────────────────────────────────────
  eyebrow: { color: theme.accent, fontSize: 11, fontWeight: '700', letterSpacing: 1.8 },
  machine: { color: theme.textMuted, fontSize: 16, marginTop: 14 },
  sas: {
    color: theme.text,
    fontSize: 48,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
    letterSpacing: 4,
    marginVertical: 28
  },
  warning: { color: theme.textMuted, fontSize: 15, lineHeight: 23 },
  waitingRow: { alignItems: 'center', flexDirection: 'row', gap: 10, marginTop: 28 },
  waiting: { color: theme.textDim, fontSize: 14, marginTop: 14 },

  // ── 스캐너 ──────────────────────────────────────────────────────────────
  cameraOverlay: { flex: 1, alignItems: 'center', paddingHorizontal: 24 },
  cameraHeader: { alignItems: 'center', paddingTop: 24 },
  cameraTitle: { color: '#ffffff', fontSize: 20, fontWeight: '600', textAlign: 'center' },
  cameraHint: {
    backgroundColor: 'rgba(11,11,13,0.78)',
    borderRadius: 8,
    color: theme.textMuted,
    fontSize: 13,
    marginTop: 10,
    overflow: 'hidden',
    paddingHorizontal: 12,
    paddingVertical: 7
  },
  frameArea: {
    alignItems: 'center',
    alignSelf: 'stretch',
    flex: 1,
    justifyContent: 'center'
  },
  frame: { aspectRatio: 1, maxWidth: 300, width: '80%' },
  corner: {
    borderColor: theme.accent,
    height: 34,
    position: 'absolute',
    width: 34
  },
  cornerTopLeft: {
    borderLeftWidth: 3,
    borderTopLeftRadius: 14,
    borderTopWidth: 3,
    left: 0,
    top: 0
  },
  cornerTopRight: {
    borderRightWidth: 3,
    borderTopRightRadius: 14,
    borderTopWidth: 3,
    right: 0,
    top: 0
  },
  cornerBottomLeft: {
    borderBottomLeftRadius: 14,
    borderBottomWidth: 3,
    borderLeftWidth: 3,
    bottom: 0,
    left: 0
  },
  cornerBottomRight: {
    borderBottomRightRadius: 14,
    borderBottomWidth: 3,
    borderRightWidth: 3,
    bottom: 0,
    right: 0
  },
  cameraFooter: { alignSelf: 'stretch', paddingBottom: 8 }
})
