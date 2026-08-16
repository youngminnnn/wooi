import { describe, expect, it } from 'vitest'
import { deriveDirectionKeys, fromBase64Url, sealJson, toBase64Url } from '@shared/crypto'
import { REMOTE_PROTOCOL_VERSION } from '@shared/remote'
import { openPushPayload } from './payload'
import type { StoredPairing } from '../storage/secure'

/**
 * 푸시 페이로드는 **랩탑이 봉인하고 폰이 연다**. 두 쪽이 헤더를 한 글자라도 다르게 만들면
 * 열리지 않고, E2E 라 증상은 "아무 일도 일어나지 않음" 하나뿐이다 — 탭해도 딥링크가 안 되고
 * 오류도 없다. 그래서 여기서는 **랩탑이 실제로 하는 그대로** 봉인해 두고 연다.
 * (랩탑 쪽 코드는 `src/main/remote/push.ts`)
 */

const MACHINE_ID = '11111111-1111-1111-1111-111111111111'
const DEVICE_ID = '33333333-3333-3333-3333-333333333333'
const SESSION_KEY = toBase64Url(new Uint8Array(32).fill(7))

const pairing: StoredPairing = {
  url: 'https://relay.example',
  anonKey: 'anon',
  machineId: MACHINE_ID,
  machineName: 'laptop',
  deviceId: DEVICE_ID,
  sessionKey: SESSION_KEY
}

/** 랩탑의 `RemotePush.send` 와 같은 헤더·키·구조로 봉인한다. */
function sealAsLaptop(
  payload: unknown,
  overrides: { machineId?: string; deviceId?: string; kind?: string } = {}
): { n: string; p: string } {
  const header = {
    v: REMOTE_PROTOCOL_VERSION,
    machineId: overrides.machineId ?? MACHINE_ID,
    deviceId: overrides.deviceId ?? DEVICE_ID,
    kind: overrides.kind ?? 'push'
  }
  const { laptopToPhone } = deriveDirectionKeys(fromBase64Url(SESSION_KEY), DEVICE_ID)
  const box = sealJson(laptopToPhone, header, payload)
  return { n: toBase64Url(box.nonce), p: toBase64Url(box.ct) }
}

describe('푸시 페이로드', () => {
  it('랩탑이 봉인한 것을 연다', () => {
    const sealed = sealAsLaptop({ workspaceId: 'ws-1', workspaceName: 'fix login' })
    expect(openPushPayload(pairing, { m: MACHINE_ID, k: 'needsInput', ...sealed })).toEqual({
      workspaceId: 'ws-1',
      workspaceName: 'fix login'
    })
  })

  it('다른 머신의 알림은 무시한다', () => {
    // 재페어링 직후 예전 머신의 알림이 남아 있을 수 있다. 열리지 않는 것이 아니라
    // **열어 보지도 않는 것**이 맞다 — 다른 머신의 워크스페이스로 딥링크할 이유가 없다.
    const sealed = sealAsLaptop({ workspaceId: 'ws-1', workspaceName: 'x' })
    expect(openPushPayload(pairing, { m: 'other-machine', k: 'needsInput', ...sealed })).toBeNull()
  })

  it('변조된 암호문을 거부한다', () => {
    const sealed = sealAsLaptop({ workspaceId: 'ws-1', workspaceName: 'x' })
    // base64url 은 마지막 글자의 일부 비트가 무의미할 수 있어, 글자를 바꿔도 같은 바이트로
    // 디코딩된다. 그래서 **바이트를 직접** 뒤집는다 — 그러지 않으면 통과하는 척만 한다.
    const bytes = fromBase64Url(sealed.p)
    bytes[0] ^= 0xff
    expect(
      openPushPayload(pairing, {
        m: MACHINE_ID,
        k: 'needsInput',
        n: sealed.n,
        p: toBase64Url(bytes)
      })
    ).toBeNull()
  })

  it('헤더가 어긋나면 열리지 않는다', () => {
    // AAD 로 묶여 있으므로 kind 하나만 달라도 열 수 없다. 상태나 커맨드 봉투를
    // 알림으로 재생할 수 없다는 뜻이다.
    const sealed = sealAsLaptop({ workspaceId: 'ws-1', workspaceName: 'x' }, { kind: 'state' })
    expect(openPushPayload(pairing, { m: MACHINE_ID, k: 'needsInput', ...sealed })).toBeNull()
  })

  it('다른 기기 앞으로 봉인된 것을 열지 않는다', () => {
    const sealed = sealAsLaptop(
      { workspaceId: 'ws-1', workspaceName: 'x' },
      { deviceId: '44444444-4444-4444-4444-444444444444' }
    )
    expect(openPushPayload(pairing, { m: MACHINE_ID, k: 'needsInput', ...sealed })).toBeNull()
  })

  it('모양이 어긋난 평문을 거부한다', () => {
    const sealed = sealAsLaptop({ workspaceId: 'ws-1' })
    expect(openPushPayload(pairing, { m: MACHINE_ID, k: 'needsInput', ...sealed })).toBeNull()
  })

  it('data 가 없거나 필드가 빠지면 null 이다', () => {
    expect(openPushPayload(pairing, undefined)).toBeNull()
    expect(openPushPayload(pairing, { m: MACHINE_ID, k: 'needsInput' })).toBeNull()
  })
})
