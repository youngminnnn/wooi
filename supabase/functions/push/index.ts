import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'

const BODIES = {
  needsInput: 'A workspace needs your permission',
  completed: 'A workspace finished',
  error: 'A workspace encountered an error',
  summary: 'Several workspaces need your attention'
} as const

type PushKind = keyof typeof BODIES

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
  if (!machineId || !kind || !dedupeKey || !messages || raw.body !== BODIES[kind]) {
    return fail(400, 'invalid push')
  }

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
        body: BODIES[kind],
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
  return typeof value === 'string' && value in BODIES ? (value as PushKind) : null
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
