/**
 * Wooi Remote — 헤드리스 페어링 프로브.
 *
 * 랩탑과 폰을 **한 프로세스 안에서 동시에 연기**해서 릴레이 전체를 왕복시킨다.
 * M0 의 완료 조건이자, 그 뒤로도 남는 회귀 하네스다 — 실기기로 같은 것을 확인하는 데
 * 몇 분이 걸리는 반면 이건 몇 초다.
 *
 * 실행:
 *   supabase start && supabase functions serve      # 다른 터미널
 *   eval "$(supabase status -o env | sed 's/^/export /')"
 *   npm run remote:probe
 *
 * 클라우드를 겨냥하려면 API_URL / ANON_KEY 를 그 프로젝트 값으로 넘기면 된다.
 *
 * Node 24 가 TypeScript 를 직접 실행하므로 `src/main/remote/crypto.ts` 를 **그대로** 쓴다.
 * 암호 구현을 복사하지 않는 것이 이 프로브의 핵심이다: 복사하면 프로브가 통과해도
 * 실제 앱이 통과한다는 보장이 사라진다.
 */

import { randomUUID } from 'node:crypto'
import { PairingManager } from '../src/main/remote/pairing.ts'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  computeSas,
  derivePairingKek,
  deriveDirectionKeys,
  fromBase64Url,
  generateKeyPair,
  generatePairingCode,
  generateSessionKey,
  open,
  seal,
  sealJson,
  openJson,
  sharedSecret,
  toBase64Url,
  type RemoteHeader
} from '../src/shared/crypto.ts'

const URL = process.env.API_URL ?? process.env.WOOI_SUPABASE_URL ?? 'http://127.0.0.1:54321'
const ANON = process.env.ANON_KEY ?? process.env.WOOI_SUPABASE_ANON_KEY ?? ''

if (!ANON) {
  fatal('ANON_KEY(또는 WOOI_SUPABASE_ANON_KEY)가 필요합니다. `supabase status -o env` 를 보세요.')
}

let failures = 0

await main()
process.exit(failures === 0 ? 0 : 1)

async function main(): Promise<void> {
  step('랩탑과 폰이 각각 익명 로그인한다')
  const laptop = await signIn('laptop')
  const phone = await signIn('phone')
  ok(`laptop uid=${short(laptop.uid)} phone uid=${short(phone.uid)}`)
  check('두 익명 사용자는 서로 다르다', laptop.uid !== phone.uid)

  step('랩탑이 machines 행을 만든다')
  const machineId = randomUUID()
  const machineName = 'probe-laptop'
  const inserted = await laptop.client
    .from('machines')
    .insert({ id: machineId, name: machineName, platform: 'darwin', app_version: '0.0.0-probe' })
  if (inserted.error) fatal(`machines insert 실패: ${inserted.error.message}`)
  ok(`machine ${short(machineId)}`)

  step('무관한 익명 사용자에게는 아무것도 보이지 않는다')
  const stranger = await signIn('stranger')
  const seen = await stranger.client.from('machines').select('id')
  check('낯선 사용자가 보는 머신 0개', (seen.data?.length ?? 0) === 0)

  step('랩탑: pair-begin')
  const laptopKeys = generateKeyPair()
  const code = generatePairingCode()
  await call(laptop, {
    action: 'begin',
    machineId,
    machineName,
    machinePubKey: toBase64Url(laptopKeys.publicKey),
    code
  })
  ok('QR 에 실릴 코드가 발급되었다')

  step('낯선 사용자는 남의 페어링을 폴링할 수 없다')
  const denied = await callRaw(stranger, { action: 'status', code })
  check(`status 가 403 이다 (실제 ${denied.status})`, denied.status === 403)

  step('폰: pair-claim')
  const phoneKeys = generateKeyPair()
  const claimed = (await call(phone, {
    action: 'claim',
    code,
    devicePubKey: toBase64Url(phoneKeys.publicKey),
    deviceName: 'probe-phone',
    devicePlatform: 'ios'
  })) as { machineId: string; machineName: string; machinePubKey: string }
  check('폰이 받은 machineId 가 맞다', claimed.machineId === machineId)

  step('두 번째 claim 은 거부된다 (선착순 잠금)')
  const second = await callRaw(stranger, {
    action: 'claim',
    code,
    devicePubKey: toBase64Url(generateKeyPair().publicKey),
    deviceName: 'attacker-phone',
    devicePlatform: 'android'
  })
  check(`두 번째 claim 이 404 다 (실제 ${second.status})`, second.status === 404)

  step('양쪽이 같은 SAS 에 도달한다')
  const phoneShared = sharedSecret(phoneKeys.secretKey, fromBase64Url(claimed.machinePubKey))
  const state = (await call(laptop, { action: 'status', code })) as {
    claimed: boolean
    devicePubKey: string
    deviceName: string
  }
  check('랩탑이 claim 을 관측했다', state.claimed)
  const laptopShared = sharedSecret(laptopKeys.secretKey, fromBase64Url(state.devicePubKey))
  const phoneSas = computeSas(phoneShared, code)
  const laptopSas = computeSas(laptopShared, code)
  ok(`SAS 랩탑=${laptopSas} 폰=${phoneSas} (기기 "${state.deviceName}")`)
  check('SAS 가 일치한다 — 사용자가 승인할 수 있다', laptopSas === phoneSas)

  step('랩탑: 세션키를 KEK 로 봉인하고 pair-complete')
  const deviceId = randomUUID()
  const sessionKey = generateSessionKey()
  const wrapHeader: RemoteHeader = { v: 1, machineId, deviceId, kind: 'result' }
  const wrapped = seal(derivePairingKek(laptopShared, code), wrapHeader, sessionKey)
  const completed = (await call(laptop, {
    action: 'complete',
    code,
    deviceId,
    wrappedKey: toBase64Url(wrapped.ct),
    wrappedNonce: toBase64Url(wrapped.nonce)
  })) as { deviceId: string }
  check('deviceId 가 랩탑이 정한 값이다', completed.deviceId === deviceId)

  step('폰: pair-finish 로 세션키를 언랩한다')
  const finished = (await call(phone, { action: 'finish', code })) as {
    deviceId: string
    wrappedKey: string
    wrappedNonce: string
  }
  const phoneSessionKey = open(
    derivePairingKek(phoneShared, code),
    { v: 1, machineId, deviceId: finished.deviceId, kind: 'result' },
    { nonce: fromBase64Url(finished.wrappedNonce), ct: fromBase64Url(finished.wrappedKey) }
  )
  check(
    '폰이 랩탑과 같은 세션키를 얻었다',
    toBase64Url(phoneSessionKey) === toBase64Url(sessionKey)
  )

  step('페어링 행은 소모되었다')
  const reuse = await callRaw(phone, { action: 'finish', code })
  check(`같은 코드를 다시 쓰면 404 다 (실제 ${reuse.status})`, reuse.status === 404)

  step('페어링된 폰이 릴레이를 쓸 수 있다')
  const phoneSees = await phone.client.from('machines').select('id, name')
  check('폰에게 머신이 보인다', phoneSees.data?.length === 1)
  check(
    '낯선 사용자에게는 여전히 안 보인다',
    (await stranger.client.from('machines').select('id')).data?.length === 0
  )

  step('종단 간 암호가 실제로 왕복한다')
  const laptopKeysDir = deriveDirectionKeys(sessionKey, deviceId)
  const phoneKeysDir = deriveDirectionKeys(phoneSessionKey, deviceId)
  const header: RemoteHeader = { v: 1, machineId, deviceId, kind: 'command' }
  const payload = { channel: 'app:getState', args: [], seq: 1, ts: Date.now() }
  const box = sealJson(phoneKeysDir.phoneToLaptop, header, payload)
  check(
    '랩탑이 폰의 커맨드를 연다',
    JSON.stringify(openJson(laptopKeysDir.phoneToLaptop, header, box)) === JSON.stringify(payload)
  )
  let reflected = false
  try {
    openJson(laptopKeysDir.laptopToPhone, header, box)
    reflected = true
  } catch {
    /* 기대한 실패 */
  }
  check('반대 방향 키로는 열리지 않는다 (반사 공격 방지)', !reflected)

  step('폰이 commands 행을 넣을 수 있다')
  const cmd = await phone.client.from('commands').insert({
    machine_id: machineId,
    device_id: deviceId,
    nonce: toPgBytea(box.nonce),
    payload_ct: toPgBytea(box.ct)
  })
  check(`commands insert 성공 (${cmd.error?.message ?? 'ok'})`, !cmd.error)

  step('랩탑이 기기를 revoke 하면 즉시 끊긴다')
  const revoked = await laptop.client
    .from('devices')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', deviceId)
  if (revoked.error) fatal(`revoke 실패: ${revoked.error.message}`)
  check(
    'revoke 된 폰에게 머신이 보이지 않는다',
    (await phone.client.from('machines').select('id')).data?.length === 0
  )

  await probeDesktopPairing(laptop, phone, machineId, machineName)

  step('정리')
  await laptop.client.from('machines').delete().eq('id', machineId)

  console.log(failures === 0 ? '\n✅ 릴레이 왕복 전부 통과' : `\n❌ 실패 ${failures}건`)
}

/**
 * 여기까지는 프로토콜을 손으로 왕복시켜 **서버**를 검증했다.
 * 이제 같은 흐름을 데스크톱의 실제 오케스트레이터(`PairingManager`)로 돌려 **앱 코드**를 검증한다.
 * 이 둘이 갈라지는 순간이 배선 실수가 드러나는 지점이다.
 */
async function probeDesktopPairing(
  laptop: Actor,
  phone: Actor,
  machineId: string,
  machineName: string
): Promise<void> {
  step('데스크톱 PairingManager 로 다시 페어링한다 (실제 앱 코드 경로)')

  const stored: Array<{ deviceId: string; name: string; sessionKey: string }> = []
  const removed: string[] = []
  const phases: string[] = []
  let latest: { phase: string; sas: string | null; qr: string | null; error: string | null } = {
    phase: 'idle',
    sas: null,
    qr: null,
    error: null
  }

  const manager = new PairingManager({
    call: (body) => callRaw(laptop, body),
    // 디스크·키체인을 건드리지 않는 대역. PairingManager 가 쓰는 것은 addDevice 뿐이다.
    keystore: {
      addDevice: (d: never) => stored.push(d),
      removeDevice: (id: string) => removed.push(id)
    } as never,
    relay: { url: URL, anonKey: ANON },
    machineId,
    machineName,
    onChange: (state) => {
      phases.push(state.phase)
      latest = state
    }
  })

  const started = await manager.start()
  check('QR 이 만들어졌다', started.phase === 'waiting' && started.qr !== null)

  // 폰이 QR 을 읽고 claim 한다.
  const qr = JSON.parse(started.qr as string) as { code: string; mpk: string }
  const phoneKeys = generateKeyPair()
  const claimed = (await call(phone, {
    action: 'claim',
    code: qr.code,
    devicePubKey: toBase64Url(phoneKeys.publicKey),
    deviceName: 'probe-phone-2',
    devicePlatform: 'android'
  })) as { machinePubKey: string }
  check('QR 의 공개키가 서버가 아는 것과 같다', claimed.machinePubKey === qr.mpk)

  // 폴링이 claim 을 관측할 때까지 기다린다(실제 타이머를 쓴다 — 목킹 없이 도는지 보는 것이 목적이다).
  const sawClaim = await waitFor(() => latest.phase === 'confirming', 15_000)
  check('폴링이 claim 을 관측했다', sawClaim)

  const phoneShared = sharedSecret(phoneKeys.secretKey, fromBase64Url(qr.mpk))
  check('SAS 가 폰과 일치한다', latest.sas === computeSas(phoneShared, qr.code))
  ok(`SAS ${latest.sas}`)

  check('확인 전에는 키를 저장하지 않는다', stored.length === 0)

  const done = await manager.confirm()
  check('페어링이 완료되었다', done.phase === 'done')
  check('세션키가 정확히 하나 저장되었다', stored.length === 1)

  // 폰 입장에서 언랩해 본다 — 상호운용의 실제 증명.
  const finished = (await call(phone, { action: 'finish', code: qr.code })) as {
    deviceId: string
    wrappedKey: string
    wrappedNonce: string
  }
  const phoneSessionKey = open(
    derivePairingKek(phoneShared, qr.code),
    { v: 1, machineId, deviceId: finished.deviceId, kind: 'result' },
    { nonce: fromBase64Url(finished.wrappedNonce), ct: fromBase64Url(finished.wrappedKey) }
  )
  check(
    '폰이 언랩한 키가 랩탑이 저장한 키와 같다',
    toBase64Url(phoneSessionKey) === stored[0]!.sessionKey
  )
  check('deviceId 도 일치한다', finished.deviceId === stored[0]!.deviceId)
  // 이 폰은 앞 단계에서 이미 한 번 페어링됐다가 revoke 되었다 — 재페어링이 옛 행을 대체해야 한다.
  check('재페어링이 옛 기기 행을 대체했다', removed.length === 1)
  check(
    '로컬 키스토어에 유령 기기가 남지 않는다',
    !stored.some((d) => removed.includes(d.deviceId))
  )
  check(
    'phase 전이가 순서대로 일어났다',
    phases.join(' → ') === 'waiting → confirming → completing → done'
  )

  manager.dispose()
}

/** 조건이 참이 될 때까지 기다린다(실제 시계). */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return predicate()
}

// ── 헬퍼 ──────────────────────────────────────────────────────────────────

interface Actor {
  label: string
  client: SupabaseClient
  uid: string
  token: string
}

async function signIn(label: string): Promise<Actor> {
  // persistSession=false 로 각 배우가 독립된 세션을 갖게 한다(한 프로세스에 셋이 산다).
  const client = createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false }
  })
  const { data, error } = await client.auth.signInAnonymously()
  if (error || !data.session) fatal(`${label} 익명 로그인 실패: ${error?.message}`)
  return {
    label,
    client,
    uid: data.session!.user.id,
    token: data.session!.access_token
  }
}

async function callRaw(
  actor: Actor,
  body: Record<string, unknown>
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${URL}/functions/v1/pair`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: ANON,
      Authorization: `Bearer ${actor.token}`
    },
    body: JSON.stringify(body)
  })
  let json: unknown = null
  try {
    json = await res.json()
  } catch {
    /* 본문 없음 */
  }
  return { status: res.status, json }
}

async function call(actor: Actor, body: Record<string, unknown>): Promise<unknown> {
  const { status, json } = await callRaw(actor, body)
  if (status !== 200) {
    fatal(`${actor.label} ${String(body.action)} 실패 (${status}): ${JSON.stringify(json)}`)
  }
  return json
}

/** PostgREST 가 bytea 로 받아 주는 hex 리터럴. */
function toPgBytea(bytes: Uint8Array): string {
  return `\\x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

function step(title: string): void {
  console.log(`\n▸ ${title}`)
}

function ok(message: string): void {
  console.log(`  · ${message}`)
}

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${label}`)
  } else {
    failures++
    console.log(`  ✗ ${label}`)
  }
}

function fatal(message: string): never {
  console.error(`\n💥 ${message}`)
  process.exit(1)
}

function short(id: string): string {
  return id.slice(0, 8)
}
