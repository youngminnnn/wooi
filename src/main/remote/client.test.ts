import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * `@supabase/supabase-js` 를 통째로 목킹한다 — 여기서 검증하려는 것은 라이브러리가 아니라
 * **우리 쪽 결정들**이다: 세션이 없을 때만 익명 로그인하는가, 실패를 상태로 보고하는가,
 * CAPTCHA 실패를 백오프 루프에 넣지 않는가, heartbeat 실패가 재연결로 이어지는가.
 */
const supa = {
  session: null as { user: { id: string } } | null,
  signInError: null as { message: string } | null,
  upsertError: null as { message: string } | null,
  updateError: null as { message: string } | null,
  signInCalls: 0,
  upserts: [] as unknown[],
  updates: [] as unknown[],
  createdWith: [] as unknown[],
  removeAllChannels: vi.fn(async () => {})
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: (url: string, key: string, options: unknown) => {
    supa.createdWith.push({ url, key, options })
    return {
      auth: {
        getSession: async () => ({ data: { session: supa.session }, error: null }),
        signInAnonymously: async () => {
          supa.signInCalls++
          if (supa.signInError) return { data: { session: null }, error: supa.signInError }
          supa.session = { user: { id: 'anon-uid' } }
          return { data: { session: supa.session }, error: null }
        }
      },
      from: (table: string) => ({
        upsert: async (row: unknown) => {
          supa.upserts.push({ table, row })
          return { error: supa.upsertError }
        },
        update: (row: unknown) => ({
          eq: async (column: string, value: unknown) => {
            supa.updates.push({ table, row, column, value })
            return { error: supa.updateError }
          }
        })
      }),
      removeAllChannels: supa.removeAllChannels
    }
  }
}))

const storage = { available: true }
vi.mock('electron', () => ({
  app: { getPath: () => '/unused' },
  safeStorage: {
    isEncryptionAvailable: () => storage.available,
    encryptString: (t: string) => Buffer.from(t, 'utf-8'),
    decryptString: (b: Buffer) => b.toString('utf-8')
  }
}))

const { RemoteClient, backoffDelay, resolveRemoteConfig, HEARTBEAT_INTERVAL_MS } =
  await import('./client')

/** 디스크를 건드리지 않는 최소 키스토어. RemoteClient 가 실제로 쓰는 것만 구현한다. */
function fakeKeystore(): {
  identity: () => { machineId: string; createdAt: number }
  getAuthSession: () => string | null
  setAuthSession: (v: string | null) => void
  session: string | null
} {
  const box = {
    session: null as string | null,
    identity: () => ({ machineId: 'machine-uuid', createdAt: 0 }),
    getAuthSession: () => box.session,
    setAuthSession: (v: string | null) => {
      box.session = v
    }
  }
  return box
}

const newClient = (keystore = fakeKeystore()): InstanceType<typeof RemoteClient> =>
  new RemoteClient({
    config: { url: 'http://localhost:54321', anonKey: 'anon-key' },
    // 테스트가 필요로 하는 표면만 갖춘 대역이다.
    keystore: keystore as never,
    appVersion: '1.2.3',
    machineName: 'test-laptop',
    // 지터를 최대로 고정한다. 실제 동작에서는 첫 재시도가 0~1000ms 사이 아무 때나 일어나는데,
    // 그대로 두면 "heartbeat 실패 직후" 를 관찰하려는 테스트가 재연결까지 지나쳐 버린다.
    random: () => 1
  })

beforeEach(() => {
  supa.session = null
  supa.signInError = null
  supa.upsertError = null
  supa.updateError = null
  supa.signInCalls = 0
  supa.upserts = []
  supa.updates = []
  supa.createdWith = []
  supa.removeAllChannels.mockClear()
  storage.available = true
})

afterEach(() => {
  vi.useRealTimers()
})

describe('설정 해석', () => {
  it('두 환경변수가 모두 있으면 그것을 쓴다', () => {
    expect(
      resolveRemoteConfig({ WOOI_SUPABASE_URL: 'http://x', WOOI_SUPABASE_ANON_KEY: 'k' })
    ).toEqual({ url: 'http://x', anonKey: 'k' })
  })

  it('아무것도 없으면 null 이다 (원격 비활성)', () => {
    expect(resolveRemoteConfig({})).toBeNull()
  })

  it('한쪽만 준 것은 실수로 보고 거부한다', () => {
    // 조용히 구워 넣은 값으로 떨어지면 로컬 스택을 겨냥한 줄 알고 클라우드에 붙는 사고가 난다.
    expect(resolveRemoteConfig({ WOOI_SUPABASE_URL: 'http://x' })).toBeNull()
    expect(resolveRemoteConfig({ WOOI_SUPABASE_ANON_KEY: 'k' })).toBeNull()
  })

  it('공백만 있는 값은 없는 것으로 본다', () => {
    expect(
      resolveRemoteConfig({ WOOI_SUPABASE_URL: '  ', WOOI_SUPABASE_ANON_KEY: '  ' })
    ).toBeNull()
  })
})

describe('백오프', () => {
  it('상한까지 지수적으로 자라고 상한을 넘지 않는다', () => {
    const max = (attempt: number): number => backoffDelay(attempt, () => 1)
    expect(max(0)).toBe(1000)
    expect(max(1)).toBe(2000)
    expect(max(4)).toBe(16000)
    expect(max(10)).toBe(30000)
    expect(max(100)).toBe(30000)
  })

  it('전폭 지터를 적용한다', () => {
    // 지터가 없으면 릴레이가 살아날 때 모든 설치본이 같은 순간에 몰려든다.
    expect(backoffDelay(3, () => 0)).toBe(0)
    expect(backoffDelay(3, () => 0.5)).toBe(4000)
  })

  it('음수 시도 횟수에도 안전하다', () => {
    expect(backoffDelay(-5, () => 1)).toBe(1000)
  })
})

describe('연결', () => {
  it('세션이 없으면 익명 로그인하고 machines 를 upsert 한다', async () => {
    const client = newClient()
    await client.connect()

    expect(supa.signInCalls).toBe(1)
    expect(client.getState()).toMatchObject({ status: 'online', machineId: 'machine-uuid' })
    expect(supa.upserts).toEqual([
      {
        table: 'machines',
        row: expect.objectContaining({
          id: 'machine-uuid',
          name: 'test-laptop',
          app_version: '1.2.3'
        })
      }
    ])
    await client.dispose()
  })

  it('세션이 이미 있으면 익명 로그인을 하지 않는다', async () => {
    // 매번 새 익명 사용자를 만들면 auth.users 가 무한히 쌓이고 MAU 도 같이 샌다.
    supa.session = { user: { id: 'existing' } }
    const client = newClient()
    await client.connect()
    expect(supa.signInCalls).toBe(0)
    await client.dispose()
  })

  it('세션 blob 을 키스토어에 넣도록 storage 어댑터를 넘긴다', async () => {
    const keystore = fakeKeystore()
    const client = newClient(keystore)
    await client.connect()

    const options = (supa.createdWith[0] as { options: { auth: { storage: Storage } } }).options
    options.auth.storage.setItem('sb-x-auth-token', 'session-blob')
    expect(keystore.session).toBe('session-blob')
    expect(options.auth.storage.getItem('sb-x-auth-token')).toBe('session-blob')
    options.auth.storage.removeItem('sb-x-auth-token')
    expect(keystore.session).toBeNull()
    await client.dispose()
  })

  it('이미 online 이면 다시 붙지 않는다', async () => {
    const client = newClient()
    await client.connect()
    await client.connect()
    expect(supa.upserts).toHaveLength(1)
    await client.dispose()
  })

  it('OS 암호화 저장소가 없으면 unavailable 이고 네트워크를 건드리지 않는다', async () => {
    storage.available = false
    const client = newClient()
    await client.connect()
    expect(client.getState().status).toBe('unavailable')
    expect(supa.createdWith).toHaveLength(0)
    await client.dispose()
  })

  it('연결 전에는 supabase() 가 던진다', () => {
    expect(() => newClient().supabase()).toThrow(/not connected/)
  })
})

describe('실패 처리', () => {
  it('로그인 실패를 예외가 아니라 상태로 보고한다', async () => {
    vi.useFakeTimers()
    supa.signInError = { message: 'network down' }
    const client = newClient()
    await expect(client.connect()).resolves.toBeUndefined()
    expect(client.getState()).toMatchObject({ status: 'offline', lastError: 'network down' })
    await client.dispose()
  })

  it('실패하면 백오프 재시도를 건다', async () => {
    vi.useFakeTimers()
    supa.signInError = { message: 'boom' }
    const client = newClient()
    await client.connect()
    expect(supa.signInCalls).toBe(1)

    supa.signInError = null
    await vi.advanceTimersByTimeAsync(31_000)
    expect(supa.signInCalls).toBe(2)
    expect(client.getState().status).toBe('online')
    await client.dispose()
  })

  it('CAPTCHA 실패는 재시도하지 않고 UI 로 넘긴다', async () => {
    // 위젯이 만든 토큰 없이는 몇 번을 시도해도 실패한다 — 무한 재시도는 쿼터만 태운다.
    vi.useFakeTimers()
    supa.signInError = { message: 'captcha protection: request disallowed' }
    const client = newClient()
    await client.connect()

    expect(client.getState()).toMatchObject({ status: 'offline', needsCaptcha: true })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(supa.signInCalls).toBe(1)
    await client.dispose()
  })

  it('machines upsert 실패도 상태로 보고한다', async () => {
    vi.useFakeTimers()
    supa.upsertError = { message: 'too many machines for this account (limit 10)' }
    const client = newClient()
    await client.connect()
    expect(client.getState()).toMatchObject({
      status: 'offline',
      lastError: expect.stringContaining('limit 10')
    })
    await client.dispose()
  })
})

describe('heartbeat', () => {
  it('주기적으로 last_seen_at 을 올린다', async () => {
    vi.useFakeTimers()
    const client = newClient()
    await client.connect()

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2 + 100)
    expect(supa.updates).toHaveLength(2)
    expect(supa.updates[0]).toMatchObject({
      table: 'machines',
      column: 'id',
      value: 'machine-uuid'
    })
    await client.dispose()
  })

  it('실패하면 offline 으로 내리고 재연결한다', async () => {
    // heartbeat 실패는 곧 "폰에게 죽은 것처럼 보인다" — 조용히 넘기면 안 된다.
    vi.useFakeTimers()
    const client = newClient()
    await client.connect()

    supa.updateError = { message: 'jwt expired' }
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS + 100)
    expect(client.getState()).toMatchObject({ status: 'offline', lastError: 'jwt expired' })

    supa.updateError = null
    await vi.advanceTimersByTimeAsync(31_000)
    expect(client.getState().status).toBe('online')
    await client.dispose()
  })

  it('disconnect 후에는 더 이상 뛰지 않는다', async () => {
    vi.useFakeTimers()
    const client = newClient()
    await client.connect()
    await client.disconnect()

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3)
    expect(supa.updates).toHaveLength(0)
    expect(supa.removeAllChannels).toHaveBeenCalled()
  })
})

describe('상태 구독', () => {
  it('변화할 때만 알린다', async () => {
    const seen: string[] = []
    const client = newClient()
    client.onChange((s) => seen.push(s.status))

    await client.connect()
    await client.connect() // 이미 online — 아무 일도 없어야 한다
    expect(seen).toEqual(['connecting', 'online'])
    await client.dispose()
  })

  it('해제하면 더 이상 받지 않는다', async () => {
    const seen: string[] = []
    const client = newClient()
    const off = client.onChange((s) => seen.push(s.status))
    off()
    await client.connect()
    expect(seen).toEqual([])
    await client.dispose()
  })
})
