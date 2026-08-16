/**
 * Wooi Remote 의 종단 간 암호.
 *
 * 서버(Supabase)는 이 파일이 만든 암호문만 본다 — 워크스페이스 이름도, 프롬프트도,
 * 트랜스크립트도 릴레이를 평문으로 지나가지 않는다.
 *
 * **랩탑과 폰이 이 파일 하나를 공유한다.** `src/main/` 이 아니라 `src/shared/` 에 있는 이유가
 * 그것이다 — Metro 의 watchFolder 가 이 폴더라 모바일이 복사 없이 그대로 번들한다.
 * 그래서 `@noble/*` 외에는 **아무것도 import 하지 않는다**(`crypto.test.ts` 가 강제한다).
 * 구현이 두 벌이 되는 순간 한쪽만 고쳐지고, 상호운용 버그는 "복호화 실패"라는 가장
 * 진단하기 어려운 형태로 나타난다.
 *
 * 알고리즘 선택:
 * - **XChaCha20-Poly1305** — nonce 가 192비트라 매 메시지 CSPRNG 난수로 충분하다.
 *   AES-GCM(96비트)이었다면 카운터를 앱 재시작·재설치 너머로 영속하거나 birthday bound 를
 *   감수해야 했다. 순수 JS 에서 상수시간이기도 하다.
 * - **X25519** — 페어링 시 ECDH. QR 에 세션키를 직접 싣지 않기 위한 것이다(사진 한 장이
 *   영구 제어권이 되면 안 된다).
 * - **HKDF-SHA256** — 방향 분리와 KEK·SAS 파생.
 */

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js'

// ── 상수 ──────────────────────────────────────────────────────────────────

/** 세션키·파생키 길이. */
export const KEY_BYTES = 32
/** XChaCha20-Poly1305 nonce 길이. */
export const NONCE_BYTES = 24
/** Poly1305 태그 길이. `open` 이 최소 길이를 검사할 때 쓴다. */
export const TAG_BYTES = 16
/** 페어링 1회용 코드의 엔트로피(바이트). 128비트. */
export const PAIRING_CODE_BYTES = 16

/**
 * HKDF info 문자열. 버전을 접두사로 갖는 이유는, 프로토콜이 바뀔 때 **키가 자동으로 갈라져서**
 * 구버전 암호문이 신버전 키로 열리지 않게 하기 위해서다.
 */
const INFO_LAPTOP_TO_PHONE = 'wooi/v1/laptop->phone'
const INFO_PHONE_TO_LAPTOP = 'wooi/v1/phone->laptop'
const INFO_PAIRING_KEK = 'wooi/v1/pair'
const INFO_SAS = 'wooi/v1/sas'

// ── 오류 ──────────────────────────────────────────────────────────────────

/**
 * 복호화·인증 실패. 파싱 오류와 구분되어야 브리지가 "변조/키 불일치"와 "우리 쪽 버그"를
 * 로그에서 갈라 볼 수 있다.
 */
export class RemoteCryptoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RemoteCryptoError'
  }
}

// ── 봉투 헤더 (AAD) ───────────────────────────────────────────────────────

/** 메시지 종류. AAD 에 들어가므로 종류를 바꿔치기한 재생이 불가능하다. */
export type RemoteMessageKind = 'event' | 'command' | 'result' | 'state' | 'push'

/** 모든 암호문에 결합되는 헤더. 암호화되지 않지만 **변조되면 복호화가 실패한다**. */
export interface RemoteHeader {
  /** 프로토콜 버전(`REMOTE_PROTOCOL_VERSION`). */
  v: number
  machineId: string
  deviceId: string
  kind: RemoteMessageKind
}

/**
 * 헤더를 AAD 바이트로 직렬화한다.
 *
 * `JSON.stringify(header)` 를 쓰지 않는 이유: 키 순서가 객체 리터럴의 삽입 순서를 따르므로,
 * 랩탑과 폰이 필드를 다른 순서로 만든 헤더를 넘기면 AAD 바이트가 달라지고 복호화가 실패한다.
 * 그 버그는 "가끔 열리고 가끔 안 열린다"로 나타나 추적이 매우 어렵다. 순서를 여기서 못 박는다.
 */
export function encodeHeader(header: RemoteHeader): Uint8Array {
  const { v, machineId, deviceId, kind } = header
  return utf8ToBytes(
    `{"v":${JSON.stringify(v)},"machineId":${JSON.stringify(machineId)}` +
      `,"deviceId":${JSON.stringify(deviceId)},"kind":${JSON.stringify(kind)}}`
  )
}

// ── AEAD ──────────────────────────────────────────────────────────────────

/** 봉인된 메시지. `nonce` 는 비밀이 아니므로 암호문과 나란히 저장·전송한다. */
export interface SealedBox {
  nonce: Uint8Array
  ct: Uint8Array
}

/**
 * 평문을 봉인한다. nonce 는 **매번 새로 뽑는다** — XChaCha 의 192비트 nonce 는
 * 난수 충돌 확률이 무시 가능해서 카운터를 영속할 필요가 없다(그게 이 알고리즘을 고른 이유다).
 */
export function seal(key: Uint8Array, header: RemoteHeader, plaintext: Uint8Array): SealedBox {
  assertKey(key)
  const nonce = randomBytes(NONCE_BYTES)
  const ct = xchacha20poly1305(key, nonce, encodeHeader(header)).encrypt(plaintext)
  return { nonce, ct }
}

/** 봉인을 연다. 변조·키 불일치·헤더 불일치는 모두 `RemoteCryptoError` 로 나온다. */
export function open(key: Uint8Array, header: RemoteHeader, box: SealedBox): Uint8Array {
  assertKey(key)
  if (box.nonce.length !== NONCE_BYTES) {
    throw new RemoteCryptoError(`nonce must be ${NONCE_BYTES} bytes, got ${box.nonce.length}`)
  }
  if (box.ct.length < TAG_BYTES) {
    throw new RemoteCryptoError(`ciphertext shorter than auth tag (${box.ct.length} bytes)`)
  }
  try {
    return xchacha20poly1305(key, box.nonce, encodeHeader(header)).decrypt(box.ct)
  } catch {
    // noble 의 메시지를 그대로 흘리지 않는다 — 실패 사유는 항상 같다: 열리지 않았다.
    throw new RemoteCryptoError(
      'authentication failed — tampered ciphertext, wrong key, or header mismatch'
    )
  }
}

/** JSON 값을 봉인한다. 릴레이를 지나는 거의 모든 것이 이 형태다. */
export function sealJson(key: Uint8Array, header: RemoteHeader, value: unknown): SealedBox {
  return seal(key, header, utf8ToBytes(JSON.stringify(value)))
}

/** 봉인된 JSON 값을 연다. 반환 타입은 `unknown` — 호출자가 검증해야 한다. */
export function openJson(key: Uint8Array, header: RemoteHeader, box: SealedBox): unknown {
  const bytes = open(key, header, box)
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    // 여기까지 왔다면 AEAD 는 통과했다 — 즉 상대가 정당한 피어인데 우리가 못 읽는 것이다.
    // 변조가 아니라 버전·구현 불일치이므로 별도 오류로 구분한다.
    throw new Error('remote payload authenticated but is not valid JSON')
  }
}

// ── 세션키와 방향 분리 ────────────────────────────────────────────────────

/** 한 기기와의 세션키에서 파생한 방향별 키. */
export interface DirectionKeys {
  /** 랩탑이 봉인하고 폰이 여는 키. */
  laptopToPhone: Uint8Array
  /** 폰이 봉인하고 랩탑이 여는 키. */
  phoneToLaptop: Uint8Array
}

/** 새 기기 세션키 `K_dev`. 페어링 때 랩탑이 만들어 KEK 로 감싸 폰에 전달한다. */
export function generateSessionKey(): Uint8Array {
  return randomBytes(KEY_BYTES)
}

/**
 * 세션키에서 방향별 키를 파생한다.
 *
 * 방향을 나누지 않으면 랩탑이 보낸 암호문을 그대로 `commands` 행에 다시 넣어 랩탑에게
 * 되돌려주는 반사 공격이 성립한다. 키가 다르면 그 암호문은 애초에 열리지 않는다.
 */
export function deriveDirectionKeys(sessionKey: Uint8Array, deviceId: string): DirectionKeys {
  assertKey(sessionKey)
  const salt = utf8ToBytes(deviceId)
  return {
    laptopToPhone: hkdf(sha256, sessionKey, salt, utf8ToBytes(INFO_LAPTOP_TO_PHONE), KEY_BYTES),
    phoneToLaptop: hkdf(sha256, sessionKey, salt, utf8ToBytes(INFO_PHONE_TO_LAPTOP), KEY_BYTES)
  }
}

// ── 페어링 (X25519 + 1회용 코드 + SAS) ────────────────────────────────────

/** X25519 키쌍. `secretKey` 는 절대 기기를 벗어나지 않는다. */
export interface KeyPair {
  secretKey: Uint8Array
  publicKey: Uint8Array
}

export function generateKeyPair(): KeyPair {
  const secretKey = randomBytes(KEY_BYTES)
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) }
}

/**
 * ECDH 공유 비밀. noble 이 저차 점(공유 비밀이 전부 0이 되는 공개키)을 거부하므로
 * 악의적 피어가 공유 비밀을 고정된 값으로 강제할 수 없다.
 */
export function sharedSecret(secretKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(secretKey, peerPublicKey)
}

/**
 * 1회용 페어링 코드(128비트).
 *
 * 계획서는 base32 라고 적었지만 base64url 로 간다 — 코드는 QR 로만 전달되고 사람이 옮겨
 * 적지 않으므로 base32 의 이점(오독 방지)이 실현되지 않는다. 알파벳 구현을 하나로 줄이는
 * 편이 낫다. 보안 속성(128비트 엔트로피, 1회용, 5분 만료)은 동일하다.
 */
export function generatePairingCode(): string {
  return toBase64Url(randomBytes(PAIRING_CODE_BYTES))
}

/**
 * 릴레이가 보관하는 코드의 지문(소문자 hex). 코드 원문은 어디에도 저장하지 않는다.
 *
 * **hex 인 이유**: 이 값은 우리 TS 구현과 Deno 로 도는 Edge Function 이 **정확히 같은
 * 문자열**을 만들어야 하는 유일한 지점이다(둘이 어긋나면 페어링이 조용히 "코드 없음"으로 실패한다).
 * base64 계열은 알파벳(`+/` vs `-_`)과 패딩 유무의 변형이 있어 그 합의가 깨지기 쉽다.
 * hex 는 변형이 없다.
 *
 * 그리고 해싱은 **서버가** 한다 — 클라이언트가 해시를 보내면 DB 를 읽을 수 있는 쪽이
 * 곧 claim 할 수 있게 되어, 코드 원문 대신 해시를 저장하는 의미가 사라진다.
 */
export function hashPairingCode(code: string): string {
  return bytesToHex(sha256(utf8ToBytes(code)))
}

/**
 * 세션키를 감싸는 KEK. 코드를 salt 로 물려서 **그 페어링 시도 하나에만** 유효하게 만든다.
 * ECDH 공유 비밀만으로 파생하면 같은 키쌍의 다른 시도에도 재사용될 수 있다.
 */
export function derivePairingKek(shared: Uint8Array, code: string): Uint8Array {
  return hkdf(sha256, shared, sha256(utf8ToBytes(code)), utf8ToBytes(INFO_PAIRING_KEK), KEY_BYTES)
}

/**
 * 6자리 SAS(Short Authentication String). 양쪽 화면에 같은 숫자가 떠야 사용자가 승인한다.
 *
 * 이게 페어링의 실질적 인증이다. QR 을 촬영한 공격자가 먼저 claim 하면 랩탑에 뜨는 숫자와
 * 정당한 폰에 뜨는 숫자가 달라지고, 랩탑 확인 창에는 공격자의 기기 이름이 뜬다.
 * 릴레이가 침해되어 공개키를 바꿔치기해도 마찬가지다 — 중간자는 양쪽 숫자를 맞출 수 없다.
 */
export function computeSas(shared: Uint8Array, code: string): string {
  const bytes = hkdf(sha256, shared, sha256(utf8ToBytes(code)), utf8ToBytes(INFO_SAS), 8)
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  // 2^64 mod 10^6 로 인한 편향은 ~1e-13 이라 6자리 표시에서 무시 가능하다.
  return (value % 1000000n).toString().padStart(6, '0')
}

// ── base64url ─────────────────────────────────────────────────────────────
// Buffer 도 atob 도 쓰지 않는다 — 둘 다 React Native 에서 신뢰할 수 없다.

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const B64URL_INDEX = new Map([...B64URL_ALPHABET].map((char, i) => [char, i]))

/** 패딩 없는 base64url 인코딩. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    out += B64URL_ALPHABET[b0 >> 2]
    out += B64URL_ALPHABET[((b0 & 0b11) << 4) | ((b1 ?? 0) >> 4)]
    if (b1 === undefined) break
    out += B64URL_ALPHABET[((b1 & 0b1111) << 2) | ((b2 ?? 0) >> 6)]
    if (b2 === undefined) break
    out += B64URL_ALPHABET[b2 & 0b111111]
  }
  return out
}

/** 패딩 없는 base64url 디코딩. 알파벳 밖의 문자는 거부한다(조용히 무시하지 않는다). */
export function fromBase64Url(text: string): Uint8Array {
  const out = new Uint8Array(Math.floor((text.length * 6) / 8))
  let acc = 0
  let bits = 0
  let written = 0
  for (const char of text) {
    const value = B64URL_INDEX.get(char)
    if (value === undefined) {
      throw new RemoteCryptoError(`invalid base64url character: ${JSON.stringify(char)}`)
    }
    acc = (acc << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[written++] = (acc >> bits) & 0xff
    }
  }
  return out.subarray(0, written)
}

// ── 내부 ──────────────────────────────────────────────────────────────────

function assertKey(key: Uint8Array): void {
  if (key.length !== KEY_BYTES) {
    throw new RemoteCryptoError(`key must be ${KEY_BYTES} bytes, got ${key.length}`)
  }
}
