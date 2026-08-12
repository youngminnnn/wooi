import { useMemo } from 'react'
import { StatusBar } from 'expo-status-bar'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
// 데스크톱과 **같은 파일**을 참조한다 — 복사본이 아니다.
// (metro.config.js 의 watchFolder + resolver.alias 가 `src/shared` 를 가리킨다.)
import { REMOTE_PROTOCOL_VERSION, REMOTE_IPC } from '@shared/remote'
import type { RemoteWorkspace } from '@shared/remote'
import { workspaceDisplayName } from '@shared/types'
import {
  computeSas,
  deriveDirectionKeys,
  derivePairingKek,
  generateKeyPair,
  generatePairingCode,
  generateSessionKey,
  open,
  openJson,
  seal,
  sealJson,
  sharedSecret,
  toBase64Url,
  type RemoteHeader
} from '@shared/crypto'

/**
 * M3 스켈레톤. 지금 이 화면의 유일한 목적은 **공유 배선이 기기에서 실제로 도는지** 보이는 것이다.
 *
 * 번들에 심볼이 들어갔다는 것과, 그 코드가 기기에서 실행된다는 것은 다른 얘기다.
 * 특히 @noble 은 `crypto.getRandomValues` 를 요구하는데 React Native 에는 그게 없어서
 * `react-native-get-random-values` 폴리필이 index.ts 맨 앞에 있어야 한다 —
 * 그게 빠졌는지는 오직 실행해 봐야 안다. 그래서 여기서 실제로 키를 만들고 봉인·해제한다.
 */

const HEADER: RemoteHeader = {
  v: REMOTE_PROTOCOL_VERSION,
  machineId: '11111111-1111-1111-1111-111111111111',
  deviceId: '22222222-2222-2222-2222-222222222222',
  kind: 'command'
}

interface Line {
  label: string
  value: string
  ok: boolean
}

function runSharedCryptoProof(): Line[] {
  const lines: Line[] = []
  const add = (label: string, ok: boolean, value: string): void => {
    lines.push({ label, value, ok })
  }

  try {
    // 1) CSPRNG — 폴리필이 없으면 여기서 터진다.
    const key = generateSessionKey()
    add('CSPRNG', key.length === 32, `${key.length} bytes`)

    // 2) AEAD 왕복 (한글·이모지 포함 — UTF-8 처리까지 확인)
    const payload = { channel: 'chat:send', args: ['ws-1', '안녕 🎉'], seq: 1, ts: 0 }
    const box = sealJson(key, HEADER, payload)
    const opened = JSON.stringify(openJson(key, HEADER, box))
    add('AEAD 왕복', opened === JSON.stringify(payload), `${box.ct.length} bytes ct`)

    // 3) 변조 거부
    box.ct[0] ^= 1
    let rejected = false
    try {
      openJson(key, HEADER, box)
    } catch {
      rejected = true
    }
    add('변조 거부', rejected, rejected ? 'tampered ciphertext refused' : 'ACCEPTED (버그)')

    // 4) 방향 분리 — 랩탑발 암호문이 폰발 키로 열리면 안 된다
    const dirs = deriveDirectionKeys(key, HEADER.deviceId)
    const fromLaptop = seal(dirs.laptopToPhone, HEADER, new TextEncoder().encode('to phone'))
    let reflected = false
    try {
      open(dirs.phoneToLaptop, HEADER, fromLaptop)
      reflected = true
    } catch {
      /* 기대한 실패 */
    }
    add('방향 분리', !reflected, reflected ? 'REFLECTED (버그)' : 'reflection refused')

    // 5) X25519 + SAS — 양쪽이 같은 6자리에 도달하는가
    const laptop = generateKeyPair()
    const phone = generateKeyPair()
    const code = generatePairingCode()
    const a = computeSas(sharedSecret(laptop.secretKey, phone.publicKey), code)
    const b = computeSas(sharedSecret(phone.secretKey, laptop.publicKey), code)
    add('X25519 + SAS', a === b && /^\d{6}$/.test(a), a === b ? a : `${a} ≠ ${b}`)

    // 6) 페어링 KEK 언랩 — 실제 페어링이 하는 일 그대로
    const shared = sharedSecret(phone.secretKey, laptop.publicKey)
    const wrapped = seal(derivePairingKek(shared, code), HEADER, key)
    const unwrapped = open(
      derivePairingKek(sharedSecret(laptop.secretKey, phone.publicKey), code),
      HEADER,
      wrapped
    )
    add('KEK 언랩', toBase64Url(unwrapped) === toBase64Url(key), 'session key recovered')
  } catch (err) {
    add('실패', false, err instanceof Error ? err.message : String(err))
  }
  return lines
}

const SAMPLE: RemoteWorkspace = {
  id: 'ws-1',
  repoId: 'repo-1',
  name: 'wiggly-orca',
  displayName: null,
  branch: 'wiggly-orca',
  status: 'idle',
  permissionMode: 'default',
  model: null,
  effort: null,
  archived: false,
  muted: false,
  prNumber: null,
  lastActiveAt: 0,
  attention: null
}

export default function App(): React.JSX.Element {
  const lines = useMemo(runSharedCryptoProof, [])
  const allOk = lines.every((l) => l.ok)

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Wooi Remote</Text>
        <Text style={styles.subtitle}>
          protocol v{REMOTE_PROTOCOL_VERSION} · {REMOTE_IPC.transcript}
        </Text>
        <Text style={styles.subtitle}>workspace: {workspaceDisplayName(SAMPLE)}</Text>

        <Text style={[styles.verdict, allOk ? styles.pass : styles.fail]}>
          {allOk ? '공유 암호 모듈 정상' : '공유 암호 모듈 실패'}
        </Text>

        {lines.map((line) => (
          <View key={line.label} style={styles.row}>
            <Text style={[styles.mark, line.ok ? styles.pass : styles.fail]}>
              {line.ok ? '✓' : '✗'}
            </Text>
            <Text style={styles.label}>{line.label}</Text>
            <Text style={styles.value}>{line.value}</Text>
          </View>
        ))}
      </ScrollView>
      <StatusBar style="light" />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#111' },
  content: { padding: 24, paddingTop: 72 },
  title: { color: '#eee', fontSize: 22, fontWeight: '600' },
  subtitle: { color: '#777', fontSize: 12, marginTop: 4 },
  verdict: { fontSize: 15, fontWeight: '600', marginTop: 20, marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 5 },
  mark: { width: 18, fontSize: 13 },
  label: { color: '#ccc', fontSize: 13, width: 110 },
  value: { color: '#777', fontSize: 12, flex: 1 },
  pass: { color: '#4ade80' },
  fail: { color: '#f87171' }
})
