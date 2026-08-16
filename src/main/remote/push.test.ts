import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { RemoteKeystore } from './keystore'
import type { RemotePushRequest } from './push'

vi.mock('electron', () => ({
  app: { getPath: () => '/unused', getVersion: () => '1.0.0' }
}))

const { deriveDirectionKeys, fromBase64Url, generateSessionKey, openJson, toBase64Url } =
  await import('@shared/crypto')
const { REMOTE_PUSH_BODIES, REMOTE_PUSH_NAME_MAX, RemotePush } = await import('./push')

const machineId = 'machine-1'
const sessionKey = generateSessionKey()
const device = {
  deviceId: 'device-1',
  name: 'Phone',
  platform: 'android' as const,
  sessionKey: toBase64Url(sessionKey),
  createdAt: 1
}

let enabled: boolean
let call: ReturnType<typeof vi.fn<(request: RemotePushRequest) => Promise<void>>>
let selectResult: { data: Array<{ id: string; expo_push_token: string | null }>; error: null }

beforeEach(() => {
  enabled = true
  call = vi.fn<(request: RemotePushRequest) => Promise<void>>(async () => undefined)
  selectResult = {
    data: [{ id: device.deviceId, expo_push_token: 'ExponentPushToken[secret]' }],
    error: null
  }
})

function remotePush(burstMs = 0): InstanceType<typeof RemotePush> {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    is: vi.fn(() => query),
    not: vi.fn(async () => selectResult)
  }
  const client = { from: vi.fn(() => query) } as unknown as SupabaseClient
  const keystore = { listDevices: () => [device] } as unknown as RemoteKeystore
  return new RemotePush({
    supabase: () => client,
    keystore,
    machineId: () => machineId,
    enabled: () => enabled,
    call,
    now: () => 120_000,
    burstMs
  })
}

const notification = {
  workspaceId: 'workspace-1',
  workspaceName: 'design-tokens',
  kind: 'needsInput' as const
}

describe('RemotePush', () => {
  it('배너 본문에 워크스페이스 이름을 실어 열어 보지 않아도 알게 한다', async () => {
    await remotePush().notify({ ...notification, kind: 'completed' })
    expect(call.mock.calls[0]?.[0].body).toBe('design-tokens finished')
  })

  it('종류마다 이름 뒤 문구가 다르다', async () => {
    await remotePush().notify(notification)
    await remotePush().notify({ ...notification, kind: 'error' })
    expect(call.mock.calls[0]?.[0].body).toBe('design-tokens needs your permission')
    expect(call.mock.calls[1]?.[0].body).toBe('design-tokens encountered an error')
  })

  it('긴 이름은 배너 한 줄에 맞게 자른다', async () => {
    const workspaceName = 'a'.repeat(REMOTE_PUSH_NAME_MAX + 20)
    await remotePush().notify({ ...notification, workspaceName })

    expect(call.mock.calls[0]?.[0].body).toBe(
      `${'a'.repeat(REMOTE_PUSH_NAME_MAX - 1)}… needs your permission`
    )
  })

  it('줄바꿈은 접고 빈 이름은 고정 문구로 되돌린다', async () => {
    await remotePush().notify({ ...notification, workspaceName: 'two\n  lines' })
    await remotePush().notify({ ...notification, workspaceName: '   ' })
    expect(call.mock.calls[0]?.[0].body).toBe('two lines needs your permission')
    expect(call.mock.calls[1]?.[0].body).toBe(REMOTE_PUSH_BODIES.needsInput)
  })

  it('본문에 이름과 고정 문구 말고 다른 것은 넣지 않는다', async () => {
    await remotePush().notify(notification)

    const suffix = ' needs your permission'
    const body = call.mock.calls[0]?.[0].body ?? ''
    expect(body.endsWith(suffix)).toBe(true)
    expect(body.slice(0, -suffix.length)).toBe(notification.workspaceName)
  })

  it('폰 방향 키와 push 헤더로 봉인한 페이로드가 왕복한다', async () => {
    await remotePush().notify(notification)

    const message = call.mock.calls[0]?.[0].messages[0]
    const header = { v: 1, machineId, deviceId: device.deviceId, kind: 'push' as const }
    const { laptopToPhone } = deriveDirectionKeys(sessionKey, device.deviceId)
    expect(
      openJson(laptopToPhone, header, {
        nonce: fromBase64Url(message.n),
        ct: fromBase64Url(message.p)
      })
    ).toEqual({
      workspaceId: notification.workspaceId,
      workspaceName: notification.workspaceName
    })
  })

  it('같은 워크스페이스·종류·분 키는 한 번만 보낸다', async () => {
    const push = remotePush()
    await push.notify(notification)
    await push.notify(notification)
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('10초 창 안의 세 워크스페이스를 요약 푸시 하나로 합친다', async () => {
    const push = remotePush(10_000)
    await Promise.all([
      push.notify({ ...notification, workspaceId: 'workspace-1' }),
      push.notify({ ...notification, workspaceId: 'workspace-2' }),
      push.notify({ ...notification, workspaceId: 'workspace-3' })
    ])

    expect(call).toHaveBeenCalledTimes(1)
    expect(call.mock.calls[0]?.[0]).toMatchObject({
      kind: 'summary',
      body: REMOTE_PUSH_BODIES.summary,
      dedupeKey: 'summary:2'
    })
  })

  it('Edge Function 실패를 notify 밖으로 던지지 않는다', async () => {
    call.mockRejectedValueOnce(new Error('relay unavailable'))
    await expect(remotePush().notify(notification)).resolves.toBeUndefined()
  })

  it('remotePushEnabled가 꺼져 있으면 조회도 호출도 하지 않는다', async () => {
    enabled = false
    await remotePush().notify(notification)
    expect(call).not.toHaveBeenCalled()
  })
})
