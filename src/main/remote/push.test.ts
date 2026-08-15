import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { RemoteKeystore } from './keystore'
import type { RemotePushRequest } from './push'

vi.mock('electron', () => ({
  app: { getPath: () => '/unused', getVersion: () => '1.0.0' }
}))

const { deriveDirectionKeys, fromBase64Url, generateSessionKey, openJson, toBase64Url } =
  await import('@shared/crypto')
const { REMOTE_PUSH_BODIES, RemotePush } = await import('./push')

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
  workspaceName: 'Highly Secret Workspace',
  kind: 'needsInput' as const
}

describe('RemotePush', () => {
  it('고정 본문만 평문으로 보내고 워크스페이스 정보는 기기별 암호문 안에만 둔다', async () => {
    await remotePush().notify(notification)

    const request = call.mock.calls[0]?.[0]
    const serialized = JSON.stringify(request)
    expect(Object.values(REMOTE_PUSH_BODIES)).toContain(request.body)
    expect(serialized).not.toContain(notification.workspaceName)
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
