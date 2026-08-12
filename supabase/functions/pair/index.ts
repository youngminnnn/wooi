// Wooi Remote — 페어링 중개.
//
// `pairings` 테이블은 클라이언트 정책이 **하나도 없어서** RLS 가 전면 거부한다.
// 즉 이 함수만이 그 테이블에 닿을 수 있고, 그래서 페어링의 모든 단계가 여기를 지난다.
//
// 함수 하나에 action 을 두는 이유(Supabase 가 권장하는 "fat function"):
// 다섯 단계가 같은 인증 요구(JWT 필수)와 같은 테이블, 같은 검증 코드를 공유한다.
// 다섯 개로 쪼개면 CORS·인증·해싱 코드를 다섯 벌 유지하게 되고 배포와 콜드스타트만 늘어난다.
//
// 흐름:
//   begin    (랩탑) QR 을 띄우기 직전. pairings 행 생성.
//   claim    (폰)   QR 을 읽은 직후. 공개키 교환 — 여기서 양쪽 SAS 가 결정된다.
//   status   (랩탑) claim 을 기다리는 폴링. 기기 이름과 SAS 계산에 필요한 값을 받는다.
//   complete (랩탑) 사용자가 SAS 를 확인한 뒤. devices 행 생성 + 봉인된 세션키 보관.
//   finish   (폰)   세션키 수령 후 pairings 행 삭제.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'

// ── 상수 ──────────────────────────────────────────────────────────────────

/** 기기 이름 상한. 랩탑의 확인 화면에 그대로 뜨므로 UI 를 깨뜨릴 길이를 막는다. */
const MAX_NAME = 64
/** X25519 공개키(32바이트)의 base64url 길이. */
const PUB_KEY_LENGTH = 43
/** 봉인된 세션키/nonce 의 바이트 상한. 실제로는 48/24 바이트다. */
const MAX_WRAPPED_BYTES = 128

const PLATFORMS = new Set(['ios', 'android'])

// ── 진입점 ────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method !== 'POST') return fail(405, 'method not allowed')

  const authorization = req.headers.get('Authorization')
  if (!authorization) return fail(401, 'missing Authorization header')

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return fail(400, 'body must be JSON')
  }

  // 호출자의 JWT 로 만든 클라이언트. 이걸로 읽는 것은 전부 RLS 를 통과한 것이다 —
  // 즉 "이 사람이 이 머신의 주인인가" 같은 판정을 우리가 직접 구현하지 않는다.
  const asCaller = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false }
  })

  const { data: userData, error: userError } = await asCaller.auth.getUser()
  if (userError || !userData.user) return fail(401, 'invalid session')
  const uid = userData.user.id

  // pairings 전용. RLS 를 우회하므로 **이 클라이언트로 하는 모든 접근은 위에서 이미
  // 소유권을 확인한 뒤여야 한다.**
  const asService = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false }
  })

  try {
    switch (body.action) {
      case 'begin':
        return await begin(body, uid, asCaller, asService)
      case 'claim':
        return await claim(body, uid, asService)
      case 'status':
        return await status(body, uid, asCaller, asService)
      case 'complete':
        return await complete(body, uid, asCaller, asService)
      case 'finish':
        return await finish(body, uid, asService)
      default:
        return fail(400, 'unknown action')
    }
  } catch (err) {
    console.error('pair failed', err)
    return fail(500, 'internal error')
  }
})

// ── begin (랩탑) ──────────────────────────────────────────────────────────

async function begin(
  body: Record<string, unknown>,
  uid: string,
  asCaller: SupabaseClient,
  asService: SupabaseClient
): Promise<Response> {
  const machineId = str(body.machineId)
  const machineName = str(body.machineName, MAX_NAME)
  const machinePubKey = pubKey(body.machinePubKey)
  const code = str(body.code)
  if (!machineId || !machineName || !machinePubKey || !code) return fail(400, 'invalid begin')

  if (!(await ownsMachine(asCaller, machineId, uid))) return fail(403, 'not your machine')

  // 새 QR 은 이전 QR 을 **무효화한다**. 안 그러면 화면에서 사라진 옛 코드가 5분 동안
  // 살아 있어, 그 사이 촬영본으로 페어링될 수 있다.
  await asService.from('pairings').delete().eq('machine_id', machineId)

  const { error } = await asService.from('pairings').insert({
    code_hash: await hashCode(code),
    machine_id: machineId,
    machine_name: machineName,
    machine_pub_key: machinePubKey
  })
  if (error) return fail(400, error.message)

  return ok({ ok: true })
}

// ── claim (폰) ────────────────────────────────────────────────────────────

async function claim(
  body: Record<string, unknown>,
  uid: string,
  asService: SupabaseClient
): Promise<Response> {
  const code = str(body.code)
  const devicePubKey = pubKey(body.devicePubKey)
  const deviceName = str(body.deviceName, MAX_NAME)
  const platform = str(body.devicePlatform)
  if (!code || !devicePubKey || !deviceName || !PLATFORMS.has(platform ?? '')) {
    return fail(400, 'invalid claim')
  }

  // `device_pub_key is null` 조건이 곧 선착순 잠금이다.
  // 두 번째 claim 을 받아 주면 QR 을 촬영한 공격자가 정당한 폰의 claim 을 덮어쓸 수 있다.
  // (선점당한 경우는 랩탑에 뜨는 SAS 와 기기 이름이 달라져 사용자가 거부한다 — 그게 설계다.)
  const { data, error } = await asService
    .from('pairings')
    .update({
      device_pub_key: devicePubKey,
      device_uid: uid,
      device_name: deviceName,
      device_platform: platform,
      claimed_at: new Date().toISOString()
    })
    .eq('code_hash', await hashCode(code))
    .is('device_pub_key', null)
    .gt('expires_at', new Date().toISOString())
    .select('machine_id, machine_name, machine_pub_key')
    .maybeSingle()

  if (error) return fail(400, error.message)
  // 없는 코드·만료된 코드·이미 claim 된 코드를 **구분하지 않는다** — 구분하면 코드 추측에
  // 대한 오라클이 된다.
  if (!data) return fail(404, 'pairing code is not available')

  return ok({
    machineId: data.machine_id,
    machineName: data.machine_name,
    machinePubKey: data.machine_pub_key
  })
}

// ── status (랩탑) ─────────────────────────────────────────────────────────

async function status(
  body: Record<string, unknown>,
  uid: string,
  asCaller: SupabaseClient,
  asService: SupabaseClient
): Promise<Response> {
  const code = str(body.code)
  if (!code) return fail(400, 'invalid status')

  const row = await loadPairing(asService, code)
  if (!row) return fail(404, 'pairing not found')
  // 소유자만 폴링할 수 있다 — 코드를 아는 것만으로 기기 이름이 새면 안 된다.
  if (!(await ownsMachine(asCaller, row.machine_id, uid))) return fail(403, 'not your machine')

  return ok({
    claimed: row.device_pub_key !== null,
    completed: row.completed_at !== null,
    devicePubKey: row.device_pub_key,
    deviceName: row.device_name,
    devicePlatform: row.device_platform,
    expiresAt: row.expires_at
  })
}

// ── complete (랩탑) ───────────────────────────────────────────────────────

async function complete(
  body: Record<string, unknown>,
  uid: string,
  asCaller: SupabaseClient,
  asService: SupabaseClient
): Promise<Response> {
  const code = str(body.code)
  const wrappedKey = b64(body.wrappedKey)
  const wrappedNonce = b64(body.wrappedNonce)
  // deviceId 를 **랩탑이 정해서 보낸다.** 세션키를 봉인하는 AAD 헤더에 deviceId 가 들어가는데,
  // 서버가 생성하면 랩탑은 봉인 시점에 그 값을 알 수 없다(닭과 달걀). 순서를 뒤집는 편이
  // 왕복을 하나 더 만들거나 AAD 결속을 약화시키는 것보다 낫다.
  const deviceId = uuid(body.deviceId)
  if (!code || !wrappedKey || !wrappedNonce || !deviceId) return fail(400, 'invalid complete')

  const row = await loadPairing(asService, code)
  if (!row) return fail(404, 'pairing not found')
  if (!(await ownsMachine(asCaller, row.machine_id, uid))) return fail(403, 'not your machine')
  if (!row.device_pub_key || !row.device_uid) return fail(409, 'pairing has not been claimed yet')
  if (new Date(row.expires_at).getTime() < Date.now()) return fail(410, 'pairing expired')

  // 이미 완료된 페어링을 다시 완료하지 않는다(중복 클릭·재시도). 같은 결과를 그대로 돌려준다.
  if (row.completed_at && row.device_id) return ok({ deviceId: row.device_id })

  // 같은 폰을 다시 페어링하는 경우(revoke 후 재연결, 앱 재설치) 이전 행이
  // `unique (machine_id, user_uid)` 를 점유하고 있어 insert 가 실패한다.
  //
  // 갱신이 아니라 **삭제 후 재삽입**인 이유: 랩탑은 이미 자기가 정한 deviceId 를 AAD 에 넣어
  // 세션키를 봉인했다. 기존 행의 id 를 재사용하면 폰이 다른 AAD 로 언랩을 시도해 실패한다.
  // 옛 행에 딸린 commands 는 어차피 옛 세션키로 봉인되어 있어 아무도 열 수 없다.
  const { data: replaced } = await asCaller
    .from('devices')
    .delete()
    .eq('machine_id', row.machine_id)
    .eq('user_uid', row.device_uid)
    .select('id')
    .maybeSingle()

  // devices 행은 **랩탑 자격으로** 만든다 — RLS 의 `devices_owner_all` 과 머신당 기기 수
  // 제한 트리거를 그대로 통과해야 하기 때문이다. service role 로 만들면 두 방어를 모두 건너뛴다.
  const { data: device, error: deviceError } = await asCaller
    .from('devices')
    .insert({
      id: deviceId,
      machine_id: row.machine_id,
      user_uid: row.device_uid,
      name: row.device_name,
      platform: row.device_platform,
      pub_key: row.device_pub_key
    })
    .select('id')
    .single()
  if (deviceError) return fail(400, deviceError.message)

  const { error } = await asService
    .from('pairings')
    .update({
      device_id: device.id,
      wrapped_key: toBytea(wrappedKey),
      wrapped_nonce: toBytea(wrappedNonce),
      completed_at: new Date().toISOString()
    })
    .eq('code_hash', row.code_hash)
  if (error) return fail(400, error.message)

  // 대체된 기기 id 를 알려 주면 랩탑이 로컬 키스토어에서 죽은 항목을 지울 수 있다.
  return ok({ deviceId: device.id, replacedDeviceId: replaced?.id ?? null })
}

// ── finish (폰) ───────────────────────────────────────────────────────────

async function finish(
  body: Record<string, unknown>,
  uid: string,
  asService: SupabaseClient
): Promise<Response> {
  const code = str(body.code)
  if (!code) return fail(400, 'invalid finish')

  const row = await loadPairing(asService, code)
  if (!row) return fail(404, 'pairing not found')
  // claim 한 그 기기만 세션키를 가져갈 수 있다.
  if (row.device_uid !== uid) return fail(403, 'not your pairing')
  if (!row.completed_at || !row.wrapped_key || !row.device_id) {
    return fail(409, 'waiting for the laptop to confirm')
  }

  const payload = {
    deviceId: row.device_id,
    machineId: row.machine_id,
    machineName: row.machine_name,
    wrappedKey: fromBytea(row.wrapped_key),
    wrappedNonce: fromBytea(row.wrapped_nonce)
  }

  // 봉인된 키를 넘겼으면 페어링 행은 즉시 사라져야 한다 — 재사용 창을 남기지 않는다.
  await asService.from('pairings').delete().eq('code_hash', row.code_hash)

  return ok(payload)
}

// ── 헬퍼 ──────────────────────────────────────────────────────────────────

interface PairingRow {
  code_hash: string
  machine_id: string
  machine_name: string
  machine_pub_key: string
  device_pub_key: string | null
  device_uid: string | null
  device_name: string | null
  device_platform: string | null
  device_id: string | null
  wrapped_key: string | null
  wrapped_nonce: string | null
  claimed_at: string | null
  completed_at: string | null
  expires_at: string
}

async function loadPairing(asService: SupabaseClient, code: string): Promise<PairingRow | null> {
  const { data } = await asService
    .from('pairings')
    .select('*')
    .eq('code_hash', await hashCode(code))
    .maybeSingle()
  return (data as PairingRow | null) ?? null
}

/** 호출자가 이 머신의 주인인가. RLS 가 답을 준다 — 우리는 행이 보이는지만 본다. */
async function ownsMachine(
  asCaller: SupabaseClient,
  machineId: string,
  uid: string
): Promise<boolean> {
  const { data } = await asCaller
    .from('machines')
    .select('id')
    .eq('id', machineId)
    .eq('owner_uid', uid)
    .maybeSingle()
  return data !== null
}

/**
 * 페어링 코드의 지문(소문자 hex).
 *
 * **`src/main/remote/crypto.ts` 의 `hashPairingCode()` 와 바이트 단위로 같아야 한다.**
 * 어긋나면 페어링은 예외가 아니라 "그런 코드 없음"으로 조용히 실패한다.
 * 계약 벡터: sha256("wooi-pairing-test") =
 *   0ec22b69c7d8b36447dad5b0c26b9c377aa9331277ba50d91a540fdeb0744c39
 * base64 계열을 쓰지 않는 이유도 이것이다 — 알파벳·패딩 변형이 없는 hex 만이 안전하다.
 */
async function hashCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** base64url 문자열을 PostgREST 가 bytea 로 받아들이는 hex 리터럴로. */
function toBytea(base64url: string): string {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  let hex = ''
  for (let i = 0; i < binary.length; i++) hex += binary.charCodeAt(i).toString(16).padStart(2, '0')
  return `\\x${hex}`
}

/** bytea(`\xdeadbeef`)를 base64url 로. */
function fromBytea(value: string | null): string | null {
  if (!value) return null
  const hex = value.startsWith('\\x') ? value.slice(2) : value
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function str(value: unknown, max = 256): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) return null
  return trimmed
}

function pubKey(value: unknown): string | null {
  const text = str(value, PUB_KEY_LENGTH)
  if (!text || text.length !== PUB_KEY_LENGTH || !/^[A-Za-z0-9_-]+$/.test(text)) return null
  return text
}

function uuid(value: unknown): string | null {
  const text = str(value, 36)
  if (!text || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(text)) {
    return null
  }
  return text
}

function b64(value: unknown): string | null {
  const text = str(value, MAX_WRAPPED_BYTES * 2)
  if (!text || !/^[A-Za-z0-9_-]+$/.test(text)) return null
  return text
}

function env(name: string): string {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`missing env ${name}`)
  return value
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

function fail(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}
