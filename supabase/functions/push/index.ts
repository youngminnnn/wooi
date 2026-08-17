import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'

// 배너 본문의 계약. 랩탑은 `<워크스페이스 이름> <접미사>` 로만 보내고, 여기서 그 형태를
// 강제한다 — 워크스페이스 이름은 평문 통과를 허용하지만(PRIVACY.md 참고) 프롬프트나
// 트랜스크립트가 버그로 본문에 실리는 일은 릴레이에서 막는다.
// 단일 소스는 `src/main/remote/push.ts` 이고, 고칠 때는 양쪽을 같이 고친다.
// 종류를 더할 때는 **이쪽을 먼저 배포한다** — 모르는 kind 는 400 이라 알림이 통째로 사라진다.
const SUFFIXES = {
  needsInput: 'needs your permission',
  question: 'needs your answer',
  completed: 'finished',
  error: 'encountered an error'
} as const

const SUMMARY_BODY = 'Several workspaces need your attention'

/** 랩탑의 `REMOTE_PUSH_NAME_MAX`. 넘는 이름은 랩탑이 이미 잘라서 보낸다. */
const NAME_MAX = 48

type PushKind = keyof typeof SUFFIXES | 'summary'

interface PushMessageInput {
  deviceId: string
  n: string
  p: string
}

interface DeviceRow {
  id: string
  expo_push_token: string
}

interface ExpoTicket {
  status?: string
  id?: string
  message?: string
  details?: { error?: string }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return fail(405, 'method not allowed')

  const authorization = req.headers.get('Authorization')
  if (!authorization) return fail(401, 'missing Authorization header')

  let raw: Record<string, unknown>
  try {
    raw = await req.json()
  } catch {
    return fail(400, 'body must be JSON')
  }

  const machineId = uuid(raw.machineId)
  const kind = pushKind(raw.kind)
  const dedupeKey = str(raw.dedupeKey, 256)
  const messages = pushMessages(raw.messages)
  if (!machineId || !kind || !dedupeKey || !messages || !pushBody(raw.body, kind)) {
    return fail(400, 'invalid push')
  }
  const body = raw.body as string

  const asCaller = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false }
  })
  const { data: userData, error: userError } = await asCaller.auth.getUser()
  if (userError || !userData.user) return fail(401, 'invalid session')
  if (!(await ownsMachine(asCaller, machineId, userData.user.id))) {
    return fail(403, 'not your machine')
  }

  const asService = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false }
  })

  try {
    const { error: insertError } = await asService.from('push_events').insert({
      machine_id: machineId,
      kind,
      dedupe_key: dedupeKey
    })
    if (insertError?.code === '23505') return ok({ duplicate: true, results: [] })
    if (insertError) throw insertError

    const messageByDevice = new Map(messages.map((message) => [message.deviceId, message]))
    const { data, error: devicesError } = await asService
      .from('devices')
      .select('id,expo_push_token')
      .eq('machine_id', machineId)
      .is('revoked_at', null)
      .not('expo_push_token', 'is', null)
      .in('id', [...messageByDevice.keys()])
    if (devicesError) throw devicesError

    const devices = (data ?? []) as DeviceRow[]
    if (devices.length === 0) return ok({ duplicate: false, results: [] })

    const expoMessages = devices.map((device) => {
      const sealed = messageByDevice.get(device.id)
      if (!sealed) throw new Error('missing sealed payload')
      return {
        to: device.expo_push_token,
        title: 'Wooi',
        body,
        data: { m: machineId, k: kind, n: sealed.n, p: sealed.p }
      }
    })
    const expoResponse = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(expoMessages)
    })
    if (!expoResponse.ok) throw new Error(`Expo push returned ${expoResponse.status}`)

    const expoJson = (await expoResponse.json()) as { data?: ExpoTicket[] | ExpoTicket }
    const tickets = Array.isArray(expoJson.data)
      ? expoJson.data
      : expoJson.data
        ? [expoJson.data]
        : []
    const results = devices.map((device, index) => ({ deviceId: device.id, ...tickets[index] }))
    const deadDeviceIds = results
      .filter((result) => result.details?.error === 'DeviceNotRegistered')
      .map((result) => result.deviceId)
    if (deadDeviceIds.length > 0) {
      const { error: cleanupError } = await asService
        .from('devices')
        .update({ expo_push_token: null })
        .eq('machine_id', machineId)
        .in('id', deadDeviceIds)
      if (cleanupError) throw cleanupError
    }

    return ok({ duplicate: false, results })
  } catch (err) {
    // 토큰이나 암호문을 로그에 넣지 않고 오류 종류만 남긴다.
    console.error('push failed', errorText(err))
    return fail(500, 'internal error')
  }
})

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

function pushMessages(value: unknown): PushMessageInput[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return null
  const messages: PushMessageInput[] = []
  const ids = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object') return null
    const row = item as Record<string, unknown>
    const deviceId = uuid(row.deviceId)
    const n = base64url(row.n, 128)
    const p = base64url(row.p, 4096)
    if (!deviceId || !n || !p || ids.has(deviceId)) return null
    ids.add(deviceId)
    messages.push({ deviceId, n, p })
  }
  return messages
}

function pushKind(value: unknown): PushKind | null {
  if (typeof value !== 'string') return null
  return value === 'summary' || Object.hasOwn(SUFFIXES, value) ? (value as PushKind) : null
}

/**
 * 본문은 요약이면 고정 문구, 아니면 `<이름> <접미사>` 여야 한다. 이름 자리에는
 * 제어문자가 올 수 없고 길이도 랩탑과 같은 상한을 받는다.
 */
function pushBody(value: unknown, kind: PushKind): boolean {
  if (typeof value !== 'string') return false
  if (kind === 'summary') return value === SUMMARY_BODY
  const suffix = ` ${SUFFIXES[kind]}`
  if (!value.endsWith(suffix)) return false
  const name = value.slice(0, -suffix.length)
  return name.length > 0 && name.length <= NAME_MAX && printable(name)
}

/** 제어문자는 배너를 깨뜨리거나 지우므로 이름 자리에 올 수 없다. */
function printable(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

function base64url(value: unknown, max: number): string | null {
  const valueString = str(value, max)
  return valueString && /^[A-Za-z0-9_-]+$/.test(valueString) ? valueString : null
}

function uuid(value: unknown): string | null {
  const valueString = str(value, 36)
  return valueString &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(valueString)
    ? valueString
    : null
}

function str(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed && trimmed.length <= max ? trimmed : null
}

function env(name: string): string {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`missing env ${name}`)
  return value
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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
