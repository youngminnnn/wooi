import { useCallback, useState, type ReactNode } from 'react'
import {
  ActivityIndicator,
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
import { WooiLogo } from '../src/components/WooiLogo'
import { claimPairing, type ClaimedPairing } from '../src/relay/pairing'
import { useRemoteStore } from '../src/state/store'
import { FixedTheme, useTheme, useThemedStyles } from '../src/state/theme'
import type { Theme } from '../src/theme'

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
 * 마크는 데스크톱 앱이 화면 안에서 쓰는 W 모노그램이다. 랩탑과 짝을 짓는 화면이라, 여기서
 * 보이는 마크가 랩탑에서 보던 그 마크여야 "이 앱이 맞다"가 성립한다.
 */
function PairShell({
  children,
  footer
}: {
  children: ReactNode
  footer?: ReactNode
}): React.JSX.Element {
  const styles = useThemedStyles(makeStyles)
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.shell}>
        <View style={styles.hero}>
          <WooiLogo size={46} />
          <View style={styles.heroText}>
            <Text style={styles.wordmark}>Wooi</Text>
            {/* 이 앱이 단독 제품이 아니라 Mac 앱 Wooi 의 원격이라는 것을 여기서 못 박는다.
                아래 단계 설명은 "컴퓨터에서 Wooi 를 연다"로 시작하는데, 스토어에서 이것만 받아
                처음 켠 사람에게는 그 전제가 없다 — 무엇을 먼저 깔아야 하는지부터 모른다. */}
            <Text style={styles.tagline}>
              Remote for Wooi on your Mac — your coding sessions, on your phone.
            </Text>
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
  const styles = useThemedStyles(makeStyles)
  const steps = [
    'Open Wooi on your computer',
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
  const styles = useThemedStyles(makeStyles)
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
  const styles = useThemedStyles(makeStyles)
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
  const styles = useThemedStyles(makeStyles)
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

/**
 * 데모는 페어링의 대안이지 경쟁자가 아니다. 주 행동(카메라 허용·페어링)보다 조용하되,
 * 구분선 아래 자기 자리를 갖는다 — 랩탑이 없는 사람(심사자를 포함해)이 이 화면에서
 * 막히면 앱은 아무것도 보여주지 못한 채로 끝난다.
 */
function DemoOption(): React.JSX.Element {
  const styles = useThemedStyles(makeStyles)
  return (
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
}

export default function PairScreen(): React.JSX.Element {
  const theme = useTheme()
  const styles = useThemedStyles(makeStyles)
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
            Continue only if your computer shows exactly these six digits. If they differ, reject the
            request on your computer — someone else may have claimed the code.
          </Text>
          <View style={styles.waitingRow}>
            <ActivityIndicator color={theme.accent} size="small" />
            <Text style={styles.waiting}>Waiting for confirmation on your computer…</Text>
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
            <DemoOption />
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
            <DemoOption />
          </>
        }
      >
        <Text style={styles.title}>Paste the pairing code</Text>
        <Notice text={unpairedReason} />
        <Text style={styles.body}>
          On your computer, open Settings → Integrations → Remote access → Pair a phone, then copy the
          code shown under the QR.
        </Text>
        <TextInput
          style={styles.input}
          value={pasted}
          onChangeText={setPasted}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          placeholder="Code copied from your computer"
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
            <DemoOption />
          </>
        }
      >
        <Text style={styles.title}>Pair this phone</Text>
        <Notice text={unpairedReason} />
        <Text style={styles.body}>
          Wooi shows a one-time code on your computer. Scan it to set up an end-to-end encrypted link
          — the relay in between never sees your sessions.
        </Text>
        <Steps />
      </PairShell>
    )
  }

  // 스캐너는 앱 배경이 아니라 **카메라 영상 위**에 얹힌다. 그 위는 앱 테마와 무관하게 늘
  // 어두우므로 이 화면만 다크로 고정한다 — 라이트에서 흰 글자가 흰 글자 위에 놓이는 일을
  // 막고, 귀퉁이 표식과 링크도 영상 위에서 읽히는 밝은 값을 유지한다.
  return (
    <FixedTheme name="dark">
      <Scanner
        onPaste={() => setPhase('paste')}
        onScan={scan}
        unpairedReason={unpairedReason}
      />
    </FixedTheme>
  )
}

function Scanner({
  onPaste,
  onScan,
  unpairedReason
}: {
  onPaste: () => void
  onScan: (result: BarcodeScanningResult) => void
  unpairedReason: string | null
}): React.JSX.Element {
  const styles = useThemedStyles(makeStyles)
  return (
    <View style={styles.screen}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={onScan}
      />
      <SafeAreaView style={styles.cameraOverlay}>
        <View style={styles.cameraHeader}>
          <Text style={styles.cameraTitle}>Scan the code on your computer</Text>
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
          <LinkButton label="Can't scan? Paste the code" onPress={onPaste} />
          <DemoOption />
        </View>
      </SafeAreaView>
    </View>
  )
}

function PairLoading({ label }: { label: string }): React.JSX.Element {
  const theme = useTheme()
  const styles = useThemedStyles(makeStyles)
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.focus}>
        <ActivityIndicator color={theme.accent} />
        <Text style={styles.waiting}>{label}</Text>
      </View>
    </SafeAreaView>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.bg },
    shell: { flex: 1, paddingHorizontal: 24, paddingBottom: 16 },
    focus: { flex: 1, justifyContent: 'center', paddingHorizontal: 28 },

    // ── 정체 ────────────────────────────────────────────────────────────────
    // 마크와 이름을 가로로 눕힌다. 세로로 쌓으면 이름이 제목만큼 커 보여서, 화면에 큰 글씨
    // 두 개가 무엇이 먼저인지 다투게 된다.
    hero: { alignItems: 'center', flexDirection: 'row', gap: 13, paddingTop: 26 },
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
      backgroundColor: theme.warningSurface,
      borderColor: theme.warningBorder,
      borderRadius: 10,
      borderWidth: 1,
      marginTop: 14,
      paddingHorizontal: 12,
      paddingVertical: 10
    },
    noticeText: { color: theme.warningFg, fontSize: 13, lineHeight: 19 },
    errorBox: {
      backgroundColor: theme.dangerSurface,
      borderColor: theme.dangerBorder,
      borderRadius: 10,
      borderWidth: 1,
      marginTop: 14,
      paddingHorizontal: 12,
      paddingVertical: 10
    },
    errorText: { color: theme.dangerFg, fontSize: 14, lineHeight: 20 },

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
    primaryText: { color: theme.onAccentStrong, fontSize: 16, fontWeight: '600' },
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
    // 영상 위 글자는 테마 토큰이 아니다 — 이 subtree 는 다크로 고정돼 있고, 순백과 검은
    // 스크림은 어떤 피사체 위에서도 읽히라고 고른 값이다(--text 보다 한 단계 더 밝다).
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
