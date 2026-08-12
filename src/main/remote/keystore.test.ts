import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * safeStorage 를 목킹한다 — 실제 것은 macOS Keychain 을 건드리므로 CI 에서 돌지 않는다.
 * 가짜 봉인은 XOR 한 줄이면 충분하다. 여기서 검증하려는 것은 암호 강도가 아니라
 * **"평문이 디스크에 닿지 않는다"와 "복호화 실패가 조용히 넘어가지 않는다"** 이기 때문이다.
 */
const fake = {
  available: true,
  /** true 면 decryptString 이 던진다 — 키체인 항목 상실을 흉내낸다. */
  brokenKey: false
}

const XOR = 0x5a

vi.mock('electron', () => ({
  app: { getPath: () => '/unused — 테스트는 항상 디렉토리를 직접 넘긴다' },
  safeStorage: {
    isEncryptionAvailable: () => fake.available,
    encryptString: (text: string) => {
      const bytes = Buffer.from(text, 'utf-8')
      return Buffer.from(bytes.map((b) => b ^ XOR))
    },
    decryptString: (buffer: Buffer) => {
      if (fake.brokenKey) throw new Error('keychain entry missing')
      return Buffer.from(buffer.map((b) => b ^ XOR)).toString('utf-8')
    }
  }
}))

const { RemoteKeystore, RemoteKeystoreError, isRemoteStorageAvailable, encodeSessionKey } =
  await import('./keystore')
const { generateSessionKey } = await import('@shared/crypto')

let dir: string
let file: string

const newStore = (): InstanceType<typeof RemoteKeystore> => new RemoteKeystore(dir)

const device = (
  over: Partial<Parameters<InstanceType<typeof RemoteKeystore>['addDevice']>[0]> = {}
) => ({
  deviceId: 'device-1',
  name: 'My iPhone',
  platform: 'ios' as const,
  sessionKey: encodeSessionKey(generateSessionKey()),
  createdAt: 1,
  ...over
})

beforeEach(() => {
  fake.available = true
  fake.brokenKey = false
  dir = mkdtempSync(join(tmpdir(), 'wooi-keystore-'))
  file = join(dir, 'remote.json')
})

describe('빈 상태', () => {
  it('파일이 없으면 빈 상태로 시작한다', () => {
    const store = newStore()
    expect(store.exists()).toBe(false)
    expect(store.read()).toEqual({ version: 1, identity: null, authSession: null, devices: [] })
  })

  it('읽기만 해서는 파일을 만들지 않는다', () => {
    newStore().read()
    expect(newStore().exists()).toBe(false)
  })
})

describe('머신 신원', () => {
  it('처음 요청할 때 만들어 영속한다', () => {
    const first = newStore().identity()
    expect(first.machineId).toMatch(/^[0-9a-f-]{36}$/)
    expect(newStore().identity()).toEqual(first)
  })

  it('같은 인스턴스에서 반복 호출해도 바뀌지 않는다', () => {
    const store = newStore()
    expect(store.identity()).toEqual(store.identity())
  })
})

describe('기기', () => {
  it('추가·조회·목록·삭제가 재시작 너머로 유지된다', () => {
    const entry = device()
    newStore().addDevice(entry)

    const reopened = newStore()
    expect(reopened.listDevices()).toEqual([entry])
    expect(reopened.getDevice('device-1')).toEqual(entry)

    reopened.removeDevice('device-1')
    expect(newStore().listDevices()).toEqual([])
  })

  it('같은 deviceId 는 덮어쓴다 (재페어링)', () => {
    const store = newStore()
    store.addDevice(device())
    const rekeyed = device({ sessionKey: encodeSessionKey(generateSessionKey()) })
    store.addDevice(rekeyed)
    expect(store.listDevices()).toEqual([rekeyed])
  })

  it('길이가 틀린 세션키를 저장 시점에 거부한다', () => {
    // 나중에 "복호화 실패"로만 드러나면 원인을 찾기 어렵다.
    expect(() =>
      newStore().addDevice(device({ sessionKey: encodeSessionKey(new Uint8Array(16)) }))
    ).toThrow(RemoteKeystoreError)
  })

  it('여러 기기를 독립적으로 다룬다', () => {
    const store = newStore()
    store.addDevice(device({ deviceId: 'a' }))
    store.addDevice(device({ deviceId: 'b', platform: 'android', name: 'Pixel' }))
    store.removeDevice('a')
    expect(store.listDevices().map((d) => d.deviceId)).toEqual(['b'])
  })
})

describe('auth 세션', () => {
  it('왕복하고 null 로 지울 수 있다', () => {
    newStore().setAuthSession('rt-secret')
    expect(newStore().getAuthSession()).toBe('rt-secret')
    newStore().setAuthSession(null)
    expect(newStore().getAuthSession()).toBeNull()
  })
})

describe('디스크 표현', () => {
  it('평문이 파일에 남지 않는다', () => {
    const store = newStore()
    store.setAuthSession('rt-super-secret')
    store.addDevice(device({ name: 'Youngmin 의 iPhone' }))

    const onDisk = readFileSync(file, 'utf-8')
    expect(onDisk).not.toContain('rt-super-secret')
    expect(onDisk).not.toContain('Youngmin')
    expect(onDisk).not.toContain('device-1')
    // 기기 개수나 이름 같은 메타데이터도 새지 않게 파일 전체가 한 덩어리로 봉인된다.
    expect(JSON.parse(onDisk)).toEqual({ version: 1, payload: expect.any(String) })
  })

  it('소유자만 읽을 수 있는 권한으로 쓴다', () => {
    newStore().setAuthSession('x')
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})

describe('실패를 감추지 않는다', () => {
  it('OS 암호화 저장소가 없으면 평문으로 쓰지 않고 거부한다', () => {
    fake.available = false
    expect(isRemoteStorageAvailable()).toBe(false)
    expect(() => newStore().setAuthSession('x')).toThrow(RemoteKeystoreError)
    expect(newStore().exists()).toBe(false)
  })

  it('키체인 항목을 잃으면 빈 상태로 시작하지 않고 알린다', () => {
    // 다른 머신으로 복원했거나 키체인이 초기화된 경우. 정답은 재페어링이고,
    // 조용히 빈 상태로 시작하면 사용자는 이유도 모른 채 폰 연결이 끊긴 것을 본다.
    newStore().addDevice(device())
    fake.brokenKey = true
    expect(() => newStore().read()).toThrow(/re-pair/)
  })

  it('봉투가 손상되면 알린다', () => {
    writeFileSync(file, '{ not json')
    expect(() => newStore().read()).toThrow(RemoteKeystoreError)
  })

  it('payload 필드가 없으면 알린다', () => {
    writeFileSync(file, JSON.stringify({ version: 1 }))
    expect(() => newStore().read()).toThrow(RemoteKeystoreError)
  })

  it('모양이 어긋난 기기 항목을 조용히 버리지 않는다', () => {
    // 버리면 "폰이 갑자기 연결을 잃었다"로 나타나고 단서가 남지 않는다.
    seed({ version: 1, identity: null, authSession: null, devices: [{ deviceId: 'x' }] })
    expect(() => newStore().read()).toThrow(RemoteKeystoreError)
  })

  it('알 수 없는 platform 을 거부한다', () => {
    seed({
      version: 1,
      identity: null,
      authSession: null,
      devices: [{ ...device(), platform: 'web' }]
    })
    expect(() => newStore().read()).toThrow(RemoteKeystoreError)
  })

  it('미래 버전 파일을 덮어쓰지 않고 거부한다', () => {
    seed({ version: 99, identity: null, authSession: null, devices: [] })
    expect(() => newStore().read()).toThrow(RemoteKeystoreError)
  })
})

describe('clear()', () => {
  it('파일과 메모리 상태를 모두 지운다', () => {
    const store = newStore()
    store.addDevice(device())
    store.setAuthSession('rt')
    store.clear()

    expect(store.exists()).toBe(false)
    expect(store.listDevices()).toEqual([])
    expect(store.getAuthSession()).toBeNull()
    // 새 신원으로 다시 시작한다.
    expect(newStore().identity().machineId).not.toBe('')
  })

  it('파일이 없어도 실패하지 않는다', () => {
    expect(() => newStore().clear()).not.toThrow()
  })

  it('복호화 불가 상태에서도 복구 경로로 동작한다', () => {
    newStore().addDevice(device())
    fake.brokenKey = true
    const store = newStore()
    expect(() => store.clear()).not.toThrow()
    fake.brokenKey = false
    expect(newStore().listDevices()).toEqual([])
  })
})

/** 목킹된 봉인 형식으로 임의의 내용을 파일에 심는다. */
function seed(data: unknown): void {
  const bytes = Buffer.from(JSON.stringify(data), 'utf-8')
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      payload: Buffer.from(bytes.map((b) => b ^ XOR)).toString('base64')
    })
  )
}
