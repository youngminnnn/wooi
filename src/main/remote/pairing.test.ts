import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/unused' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (t: string) => Buffer.from(t, 'utf-8'),
    decryptString: (b: Buffer) => b.toString('utf-8')
  }
}))

const { PairingManager, PAIRING_POLL_INTERVAL_MS, PAIRING_TTL_MS } = await import('./pairing')
const {
  computeSas,
  derivePairingKek,
  fromBase64Url,
  generateKeyPair,
  open,
  sharedSecret,
  toBase64Url
} = await import('@shared/crypto')
const { decodeSessionKey } = await import('./keystore')

const MACHINE_ID = '11111111-1111-1111-1111-111111111111'

/**
 * 폰 역할을 하는 가짜 릴레이. `scripts/remote-probe.ts` 가 실제 서버로 하는 일을
 * 메모리에서 재현한다 — 여기서 검증하려는 것은 서버가 아니라 **데스크톱 쪽 상태 기계**다.
 */
function fakeRelay() {
  const relay = {
    /** begin 으로 등록된 코드. */
    code: null as string | null,
    machinePubKey: null as string | null,
    /** 폰이 claim 하면 채워진다. */
    devicePubKey: null as string | null,
    deviceName: null as string | null,
    devicePlatform: 'ios' as string | null,
    completed: null as { deviceId: string; wrappedKey: string; wrappedNonce: string } | null,
    /** 다음 호출에 강제로 돌려줄 응답. */
    override: null as { status: number; json: unknown } | null,
    /** 다음 호출에서 던질 오류(네트워크 단절 흉내). */
    throwOnce: false,
    calls: [] as string[],

    async call(body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
      relay.calls.push(String(body.action))
      if (relay.throwOnce) {
        relay.throwOnce = false
        throw new Error('network unreachable')
      }
      if (relay.override) {
        const out = relay.override
        relay.override = null
        return out
      }
      switch (body.action) {
        case 'begin':
          relay.code = String(body.code)
          relay.machinePubKey = String(body.machinePubKey)
          return { status: 200, json: { ok: true } }
        case 'status':
          if (body.code !== relay.code) return { status: 404, json: { error: 'not found' } }
          return {
            status: 200,
            json: {
              claimed: relay.devicePubKey !== null,
              devicePubKey: relay.devicePubKey,
              deviceName: relay.deviceName,
              devicePlatform: relay.devicePlatform
            }
          }
        case 'complete':
          relay.completed = {
            deviceId: String(body.deviceId),
            wrappedKey: String(body.wrappedKey),
            wrappedNonce: String(body.wrappedNonce)
          }
          return { status: 200, json: { deviceId: body.deviceId } }
        default:
          return { status: 400, json: { error: 'unknown action' } }
      }
    }
  }
  return relay
}

/** 키스토어 대역 — addDevice 만 쓴다. */
function fakeKeystore() {
  const devices: unknown[] = []
  return {
    devices,
    addDevice: (d: unknown) => devices.push(d)
  }
}

let relay: ReturnType<typeof fakeRelay>
let keystore: ReturnType<typeof fakeKeystore>
let clock: number
let states: Array<{ phase: string; sas: string | null; error: string | null }>

function newManager(): InstanceType<typeof PairingManager> {
  return new PairingManager({
    call: relay.call,
    keystore: keystore as never,
    relay: { url: 'http://localhost:54321', anonKey: 'anon' },
    machineId: MACHINE_ID,
    machineName: 'test-laptop',
    now: () => clock,
    onChange: (s) => states.push({ phase: s.phase, sas: s.sas, error: s.error })
  })
}

/** 폰이 QR 을 읽고 claim 한 상황을 만든다. 폰 쪽 키를 돌려준다. */
function phoneClaims(name = 'My iPhone'): ReturnType<typeof generateKeyPair> {
  const keys = generateKeyPair()
  relay.devicePubKey = toBase64Url(keys.publicKey)
  relay.deviceName = name
  return keys
}

beforeEach(() => {
  vi.useFakeTimers()
  relay = fakeRelay()
  keystore = fakeKeystore()
  clock = 1_000_000
  states = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('start()', () => {
  it('QR 을 만들고 claim 을 기다린다', async () => {
    const manager = newManager()
    const state = await manager.start()

    expect(state.phase).toBe('waiting')
    expect(state.expiresAt).toBe(clock + PAIRING_TTL_MS)
    const qr = JSON.parse(state.qr as string)
    expect(qr).toMatchObject({ v: 1, machineId: MACHINE_ID, machineName: 'test-laptop' })
    manager.dispose()
  })

  it('QR 에 세션키가 들어가지 않는다', async () => {
    // QR 은 화면에 뜨는 것이라 촬영·화면공유로 샌다. 사진 한 장이 영구 제어권이 되면 안 된다.
    const manager = newManager()
    const qr = JSON.parse((await manager.start()).qr as string)
    expect(Object.keys(qr).sort()).toEqual(
      ['anonKey', 'code', 'machineId', 'machineName', 'mpk', 'url', 'v'].sort()
    )
    expect(qr.mpk).toBe(relay.machinePubKey)
    manager.dispose()
  })

  it('begin 이 실패하면 error 로 간다', async () => {
    relay.override = { status: 403, json: { error: 'not your machine' } }
    const manager = newManager()
    const state = await manager.start()
    expect(state.phase).toBe('error')
    expect(state.error).toContain('not your machine')
    manager.dispose()
  })
})

describe('폴링과 SAS', () => {
  it('claim 을 관측하면 폰과 같은 SAS 를 보여 준다', async () => {
    const manager = newManager()
    await manager.start()
    const phoneKeys = phoneClaims('Youngmin 의 iPhone')

    await vi.advanceTimersByTimeAsync(PAIRING_POLL_INTERVAL_MS + 10)

    const state = manager.getState()
    expect(state.phase).toBe('confirming')
    expect(state.deviceName).toBe('Youngmin 의 iPhone')
    expect(state.qr).toBeNull() // QR 은 더 이상 유효하지 않다

    const phoneSas = computeSas(
      sharedSecret(phoneKeys.secretKey, fromBase64Url(relay.machinePubKey as string)),
      relay.code as string
    )
    expect(state.sas).toBe(phoneSas)
    expect(state.sas).toMatch(/^\d{6}$/)
    manager.dispose()
  })

  it('claim 이 없으면 계속 기다린다', async () => {
    const manager = newManager()
    await manager.start()
    await vi.advanceTimersByTimeAsync(PAIRING_POLL_INTERVAL_MS * 3 + 10)
    expect(manager.getState().phase).toBe('waiting')
    expect(relay.calls.filter((c) => c === 'status').length).toBe(3)
    manager.dispose()
  })

  it('네트워크가 잠깐 끊겨도 폴링을 포기하지 않는다', async () => {
    const manager = newManager()
    await manager.start()
    relay.throwOnce = true

    await vi.advanceTimersByTimeAsync(PAIRING_POLL_INTERVAL_MS + 10)
    expect(manager.getState().phase).toBe('waiting')

    phoneClaims()
    await vi.advanceTimersByTimeAsync(PAIRING_POLL_INTERVAL_MS + 10)
    expect(manager.getState().phase).toBe('confirming')
    manager.dispose()
  })

  it('만료되면 멈추고 다시 시작하라고 말한다', async () => {
    const manager = newManager()
    await manager.start()

    clock += PAIRING_TTL_MS + 1
    await vi.advanceTimersByTimeAsync(PAIRING_POLL_INTERVAL_MS + 10)

    expect(manager.getState().phase).toBe('error')
    expect(manager.getState().error).toMatch(/expired/)

    // 더 이상 서버를 두드리지 않는다.
    const before = relay.calls.length
    await vi.advanceTimersByTimeAsync(PAIRING_POLL_INTERVAL_MS * 5)
    expect(relay.calls.length).toBe(before)
    manager.dispose()
  })

  it('쓸 수 없는 공개키를 보내면 거부한다', async () => {
    // 저차 점으로 공유 비밀을 0 으로 강제하려는 시도. 정당한 폰은 이런 값을 보내지 않는다.
    const manager = newManager()
    await manager.start()
    relay.devicePubKey = toBase64Url(new Uint8Array(32))
    relay.deviceName = 'evil'

    await vi.advanceTimersByTimeAsync(PAIRING_POLL_INTERVAL_MS + 10)
    expect(manager.getState().phase).toBe('error')
    manager.dispose()
  })
})

describe('confirm()', () => {
  it('폰이 언랩할 수 있는 세션키를 전달하고 키스토어에 저장한다', async () => {
    const manager = newManager()
    await manager.start()
    const phoneKeys = phoneClaims('My iPhone')
    await vi.advanceTimersByTimeAsync(PAIRING_POLL_INTERVAL_MS + 10)

    const state = await manager.confirm()
    expect(state.phase).toBe('done')

    // 폰 입장에서 언랩해 본다 — 이게 실제 상호운용의 증명이다.
    const completed = relay.completed!
    const phoneShared = sharedSecret(
      phoneKeys.secretKey,
      fromBase64Url(relay.machinePubKey as string)
    )
    const unwrapped = open(
      derivePairingKek(phoneShared, relay.code as string),
      { v: 1, machineId: MACHINE_ID, deviceId: completed.deviceId, kind: 'result' },
      {
        nonce: fromBase64Url(completed.wrappedNonce),
        ct: fromBase64Url(completed.wrappedKey)
      }
    )

    expect(keystore.devices).toHaveLength(1)
    const stored = keystore.devices[0] as { deviceId: string; name: string; sessionKey: string }
    expect(stored.deviceId).toBe(completed.deviceId)
    expect(stored.name).toBe('My iPhone')
    expect(decodeSessionKey(stored.sessionKey)).toEqual(unwrapped)
    manager.dispose()
  })

  it('확인 전에는 세션키가 존재하지도 전송되지도 않는다', async () => {
    // 이 프로토콜의 유일한 인증이 사용자 확인이다. 확인 없이 완료되는 경로가 있으면 안 된다.
    const manager = newManager()
    await manager.start()
    phoneClaims()
    await vi.advanceTimersByTimeAsync(PAIRING_POLL_INTERVAL_MS * 5)

    expect(relay.completed).toBeNull()
    expect(keystore.devices).toHaveLength(0)
    manager.dispose()
  })

  it('confirming 이 아닐 때의 confirm 은 거부한다', async () => {
    const manager = newManager()
    expect((await manager.confirm()).phase).toBe('error')

    await manager.start()
    expect((await manager.confirm()).phase).toBe('error') // 아직 waiting
    expect(relay.completed).toBeNull()
    manager.dispose()
  })

  it('만료 직후의 확인 클릭을 거부한다', async () => {
    const manager = newManager()
    await manager.start()
    phoneClaims()
    await vi.advanceTimersByTimeAsync(PAIRING_POLL_INTERVAL_MS + 10)

    clock += PAIRING_TTL_MS + 1
    expect((await manager.confirm()).phase).toBe('error')
    expect(relay.completed).toBeNull()
    manager.dispose()
  })

  it('complete 가 실패하면 기기를 저장하지 않는다', async () => {
    const manager = newManager()
    await manager.start()
    phoneClaims()
    await vi.advanceTimersByTimeAsync(PAIRING_POLL_INTERVAL_MS + 10)

    relay.override = { status: 410, json: { error: 'pairing expired' } }
    expect((await manager.confirm()).phase).toBe('error')
    expect(keystore.devices).toHaveLength(0)
    manager.dispose()
  })

  it('서버가 확정한 deviceId 를 신뢰한다 (재시도로 이미 완료된 경우)', async () => {
    const manager = newManager()
    await manager.start()
    phoneClaims()
    await vi.advanceTimersByTimeAsync(PAIRING_POLL_INTERVAL_MS + 10)

    relay.override = { status: 200, json: { deviceId: '99999999-9999-9999-9999-999999999999' } }
    await manager.confirm()
    expect((keystore.devices[0] as { deviceId: string }).deviceId).toBe(
      '99999999-9999-9999-9999-999999999999'
    )
    manager.dispose()
  })
})

describe('cancel()', () => {
  it('폴링을 멈추고 idle 로 돌아간다', async () => {
    const manager = newManager()
    await manager.start()
    expect(manager.cancel().phase).toBe('idle')

    const before = relay.calls.length
    await vi.advanceTimersByTimeAsync(PAIRING_POLL_INTERVAL_MS * 5)
    expect(relay.calls.length).toBe(before)
  })

  it('취소 후 claim 이 와도 확인 창이 뜨지 않는다', async () => {
    const manager = newManager()
    await manager.start()
    manager.cancel()
    phoneClaims()

    await vi.advanceTimersByTimeAsync(PAIRING_POLL_INTERVAL_MS * 5)
    expect(manager.getState().phase).toBe('idle')
    expect(relay.completed).toBeNull()
  })
})

describe('상태 알림', () => {
  it('phase 전이를 순서대로 알린다', async () => {
    const manager = newManager()
    await manager.start()
    phoneClaims()
    await vi.advanceTimersByTimeAsync(PAIRING_POLL_INTERVAL_MS + 10)
    await manager.confirm()

    expect(states.map((s) => s.phase)).toEqual(['waiting', 'confirming', 'completing', 'done'])
    manager.dispose()
  })

  it('알린 상태에 비밀이 들어 있지 않다', async () => {
    const manager = newManager()
    await manager.start()
    phoneClaims()
    await vi.advanceTimersByTimeAsync(PAIRING_POLL_INTERVAL_MS + 10)
    await manager.confirm()

    const sessionKey = (keystore.devices[0] as { sessionKey: string }).sessionKey
    const serialized = JSON.stringify(states)
    expect(serialized).not.toContain(sessionKey)
    manager.dispose()
  })
})

describe('릴레이 5xx', () => {
  it('502 를 만나도 페어링을 포기하지 않는다', async () => {
    // Edge Function 은 콜드스타트·재배포 중에 502 를 낸다. 그때마다 사용자에게 QR 을 다시
    // 띄우게 만들면 안 된다 — 실제로 이 경로에서 페어링이 끊기는 것을 보고 고친 것이다.
    const manager = newManager()
    await manager.start()

    relay.override = { status: 502, json: null }
    await vi.advanceTimersByTimeAsync(PAIRING_POLL_INTERVAL_MS + 10)
    expect(manager.getState().phase).toBe('waiting')

    phoneClaims()
    await vi.advanceTimersByTimeAsync(PAIRING_POLL_INTERVAL_MS + 10)
    expect(manager.getState().phase).toBe('confirming')
    manager.dispose()
  })

  it('4xx 는 여전히 확정적 실패로 다룬다', async () => {
    const manager = newManager()
    await manager.start()
    relay.override = { status: 404, json: { error: 'not found' } }
    await vi.advanceTimersByTimeAsync(PAIRING_POLL_INTERVAL_MS + 10)
    expect(manager.getState().phase).toBe('error')
    manager.dispose()
  })
})
