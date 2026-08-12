import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  KEY_BYTES,
  NONCE_BYTES,
  RemoteCryptoError,
  computeSas,
  deriveDirectionKeys,
  derivePairingKek,
  encodeHeader,
  fromBase64Url,
  generateKeyPair,
  generatePairingCode,
  generateSessionKey,
  hashPairingCode,
  open,
  openJson,
  seal,
  sealJson,
  sharedSecret,
  toBase64Url,
  type RemoteHeader
} from './crypto'

const header: RemoteHeader = {
  v: 1,
  machineId: '11111111-1111-1111-1111-111111111111',
  deviceId: '22222222-2222-2222-2222-222222222222',
  kind: 'command'
}

const text = (value: string): Uint8Array => new TextEncoder().encode(value)
const str = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

describe('RN 이식성 제약', () => {
  it('crypto.ts 는 @noble 외에는 아무것도 import 하지 않는다', () => {
    // apps/mobile 이 이 파일을 **그대로** 번들한다(metro watchFolder = src/shared).
    // node:/electron 의존이 하나라도 들어오면 모바일 번들이 깨지고, 그때 유일한 대안은
    // "암호 구현을 두 벌 유지" 다 — 상호운용 버그가 가장 진단하기 어려운 형태로 나타난다.
    const source = readFileSync(join(import.meta.dirname, 'crypto.ts'), 'utf-8')
    const specifiers = [...source.matchAll(/\sfrom\s+'([^']+)'/g)].map((m) => m[1])
    expect(specifiers.length).toBeGreaterThan(0)
    for (const specifier of specifiers) {
      expect(specifier).toMatch(/^@noble\//)
    }
    expect(source).not.toMatch(/\brequire\s*\(/)
  })
})

describe('AEAD 봉인', () => {
  it('왕복한다', () => {
    const key = generateSessionKey()
    const box = seal(key, header, text('hello 안녕'))
    expect(str(open(key, header, box))).toBe('hello 안녕')
  })

  it('JSON 왕복은 구조를 보존한다', () => {
    const key = generateSessionKey()
    const value = { channel: 'chat:send', args: ['ws-1', '멀티바이트 🎉'], seq: 7, ts: 1 }
    expect(openJson(key, header, sealJson(key, header, value))).toEqual(value)
  })

  it('암호문이 1비트라도 바뀌면 거부한다', () => {
    const key = generateSessionKey()
    const box = seal(key, header, text('hello'))
    box.ct[0] ^= 0b1
    expect(() => open(key, header, box)).toThrow(RemoteCryptoError)
  })

  it('nonce 가 바뀌면 거부한다', () => {
    const key = generateSessionKey()
    const box = seal(key, header, text('hello'))
    box.nonce[0] ^= 0b1
    expect(() => open(key, header, box)).toThrow(RemoteCryptoError)
  })

  it('다른 키로는 열리지 않는다', () => {
    const box = seal(generateSessionKey(), header, text('hello'))
    expect(() => open(generateSessionKey(), header, box)).toThrow(RemoteCryptoError)
  })

  it.each([
    ['machineId', { ...header, machineId: '33333333-3333-3333-3333-333333333333' }],
    ['deviceId', { ...header, deviceId: '44444444-4444-4444-4444-444444444444' }],
    ['kind', { ...header, kind: 'event' as const }],
    ['v', { ...header, v: 2 }]
  ])('헤더의 %s 가 바뀌면 거부한다 (AAD 결속)', (_field, tampered) => {
    const key = generateSessionKey()
    const box = seal(key, header, text('hello'))
    expect(() => open(key, tampered, box)).toThrow(RemoteCryptoError)
  })

  it('잘못된 길이의 키·nonce·암호문을 형태 단계에서 거부한다', () => {
    const key = generateSessionKey()
    const box = seal(key, header, text('hello'))
    expect(() => seal(new Uint8Array(16), header, text('x'))).toThrow(/key must be 32 bytes/)
    expect(() => open(key, header, { ...box, nonce: new Uint8Array(12) })).toThrow(/nonce must be/)
    expect(() => open(key, header, { ...box, ct: new Uint8Array(4) })).toThrow(
      /shorter than auth tag/
    )
  })

  it('nonce 는 매번 다르다', () => {
    const key = generateSessionKey()
    const seen = new Set<string>()
    for (let i = 0; i < 10_000; i++) seen.add(toBase64Url(seal(key, header, text('x')).nonce))
    expect(seen.size).toBe(10_000)
  })

  it('빈 평문도 봉인된다', () => {
    const key = generateSessionKey()
    const box = seal(key, header, new Uint8Array(0))
    expect(open(key, header, box).length).toBe(0)
    expect(box.nonce.length).toBe(NONCE_BYTES)
  })
})

describe('헤더 직렬화', () => {
  it('필드 삽입 순서와 무관하게 같은 바이트를 낸다', () => {
    // 이게 깨지면 랩탑과 폰이 헤더를 다른 순서로 만들 때만 복호화가 실패한다 —
    // 재현이 거의 불가능한 형태의 버그다.
    const reordered = {
      kind: header.kind,
      deviceId: header.deviceId,
      v: header.v,
      machineId: header.machineId
    }
    expect(encodeHeader(reordered as RemoteHeader)).toEqual(encodeHeader(header))
  })

  it('따옴표가 들어간 값을 이스케이프한다', () => {
    const evil = { ...header, machineId: 'a","kind":"event' }
    // 이스케이프가 없으면 이 값이 kind 를 덮어써서 두 개의 다른 헤더가 같은 AAD 를 갖게 된다.
    expect(encodeHeader(evil)).not.toEqual(encodeHeader({ ...header, kind: 'event' }))
  })
})

describe('방향 분리', () => {
  it('랩탑→폰 암호문은 폰→랩탑 키로 열리지 않는다', () => {
    // 없으면 랩탑이 보낸 암호문을 commands 행에 되돌려 넣는 반사 공격이 성립한다.
    const keys = deriveDirectionKeys(generateSessionKey(), header.deviceId)
    const box = seal(keys.laptopToPhone, header, text('to phone'))
    expect(() => open(keys.phoneToLaptop, header, box)).toThrow(RemoteCryptoError)
  })

  it('두 방향 키는 서로 다르고 세션키와도 다르다', () => {
    const sessionKey = generateSessionKey()
    const keys = deriveDirectionKeys(sessionKey, header.deviceId)
    expect(keys.laptopToPhone).not.toEqual(keys.phoneToLaptop)
    expect(keys.laptopToPhone).not.toEqual(sessionKey)
    expect(keys.laptopToPhone.length).toBe(KEY_BYTES)
  })

  it('기기가 다르면 키가 다르다', () => {
    const sessionKey = generateSessionKey()
    const a = deriveDirectionKeys(sessionKey, 'device-a')
    const b = deriveDirectionKeys(sessionKey, 'device-b')
    expect(a.laptopToPhone).not.toEqual(b.laptopToPhone)
  })

  it('결정적이다 — 같은 입력이면 같은 키', () => {
    const sessionKey = generateSessionKey()
    expect(deriveDirectionKeys(sessionKey, 'd')).toEqual(deriveDirectionKeys(sessionKey, 'd'))
  })
})

describe('페어링', () => {
  it('양쪽이 같은 공유 비밀에 도달한다', () => {
    const laptop = generateKeyPair()
    const phone = generateKeyPair()
    expect(sharedSecret(laptop.secretKey, phone.publicKey)).toEqual(
      sharedSecret(phone.secretKey, laptop.publicKey)
    )
  })

  it('양쪽 SAS 가 일치하고 6자리다', () => {
    const laptop = generateKeyPair()
    const phone = generateKeyPair()
    const code = generatePairingCode()
    const sas = computeSas(sharedSecret(laptop.secretKey, phone.publicKey), code)
    expect(sas).toBe(computeSas(sharedSecret(phone.secretKey, laptop.publicKey), code))
    expect(sas).toMatch(/^\d{6}$/)
  })

  it('중간자는 SAS 를 맞출 수 없다', () => {
    // 공격자가 폰의 공개키를 자기 것으로 바꿔치기하면 랩탑이 보는 숫자가 달라진다.
    // 사용자는 두 화면의 숫자가 다른 것을 보고 거부한다 — 이게 페어링의 실질적 인증이다.
    const laptop = generateKeyPair()
    const phone = generateKeyPair()
    const attacker = generateKeyPair()
    const code = generatePairingCode()
    const legit = computeSas(sharedSecret(phone.secretKey, laptop.publicKey), code)
    const spoofed = computeSas(sharedSecret(laptop.secretKey, attacker.publicKey), code)
    expect(spoofed).not.toBe(legit)
  })

  it('같은 키쌍이라도 코드가 다르면 SAS 와 KEK 가 다르다', () => {
    // KEK 가 코드에 묶이지 않으면 이전 페어링 시도의 wrapped_key 를 재사용할 수 있다.
    const laptop = generateKeyPair()
    const phone = generateKeyPair()
    const shared = sharedSecret(laptop.secretKey, phone.publicKey)
    expect(computeSas(shared, 'code-a')).not.toBe(computeSas(shared, 'code-b'))
    expect(derivePairingKek(shared, 'code-a')).not.toEqual(derivePairingKek(shared, 'code-b'))
  })

  it('KEK 로 세션키를 감싸고 푼다', () => {
    const laptop = generateKeyPair()
    const phone = generateKeyPair()
    const code = generatePairingCode()
    const sessionKey = generateSessionKey()
    const wrapHeader: RemoteHeader = { ...header, kind: 'result' }

    const kek = derivePairingKek(sharedSecret(laptop.secretKey, phone.publicKey), code)
    const wrapped = seal(kek, wrapHeader, sessionKey)

    const phoneKek = derivePairingKek(sharedSecret(phone.secretKey, laptop.publicKey), code)
    expect(open(phoneKek, wrapHeader, wrapped)).toEqual(sessionKey)
  })

  it('코드를 모르면 wrapped_key 를 풀 수 없다', () => {
    const laptop = generateKeyPair()
    const phone = generateKeyPair()
    const shared = sharedSecret(laptop.secretKey, phone.publicKey)
    const wrapped = seal(derivePairingKek(shared, 'real-code'), header, generateSessionKey())
    expect(() => open(derivePairingKek(shared, 'guessed'), header, wrapped)).toThrow(
      RemoteCryptoError
    )
  })

  it('코드는 128비트이고 매번 다르다', () => {
    const codes = new Set(Array.from({ length: 1000 }, () => generatePairingCode()))
    expect(codes.size).toBe(1000)
    expect(fromBase64Url([...codes][0] as string).length).toBe(16)
  })

  it('코드 해시는 결정적이고 코드 원문을 담지 않는다', () => {
    const code = generatePairingCode()
    expect(hashPairingCode(code)).toBe(hashPairingCode(code))
    expect(hashPairingCode(code)).not.toContain(code)
    expect(hashPairingCode(code)).not.toBe(hashPairingCode(generatePairingCode()))
  })

  it('코드 해시의 알려진 값 (Edge Function 과의 계약)', () => {
    // 이 벡터가 Deno 쪽 구현과의 유일한 접점이다. 여기가 바뀌면 페어링은 예외가 아니라
    // "그런 코드 없음"으로 조용히 실패하므로, 상수로 못 박는다.
    // 참고: `printf 'wooi-pairing-test' | shasum -a 256`
    expect(hashPairingCode('wooi-pairing-test')).toBe(
      '0ec22b69c7d8b36447dad5b0c26b9c377aa9331277ba50d91a540fdeb0744c39'
    )
    expect(hashPairingCode('')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('저차 공개키를 거부한다', () => {
    // 공유 비밀을 전부 0으로 강제하려는 시도. noble 이 막아 준다.
    const laptop = generateKeyPair()
    expect(() => sharedSecret(laptop.secretKey, new Uint8Array(32))).toThrow()
  })
})

describe('base64url', () => {
  it.each([0, 1, 2, 3, 4, 15, 16, 31, 32, 100])('%d 바이트를 왕복한다', (length) => {
    const bytes = new Uint8Array(Array.from({ length }, (_, i) => (i * 37 + 11) & 0xff))
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes)
  })

  it('URL 안전한 알파벳만 쓰고 패딩이 없다', () => {
    const encoded = toBase64Url(new Uint8Array([251, 255, 190, 0, 1]))
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(encoded).not.toContain('=')
  })

  it('알파벳 밖의 문자를 조용히 무시하지 않는다', () => {
    expect(() => fromBase64Url('AA+A')).toThrow(RemoteCryptoError)
    expect(() => fromBase64Url('AA=')).toThrow(RemoteCryptoError)
  })
})
