import { describe, expect, it } from 'vitest'
import { isLaptopAway, LAPTOP_STALE_MS, useRemoteStore } from './store'
import { agoLabel } from './useNow'
import { unpairedNotice } from './unpairNotice'

/**
 * 랩탑이 자리를 비웠는지의 판단. 이 값이 틀리면 화면이 가장 정확해야 할 순간에 거짓말을 한다 —
 * 너무 짧으면 잠깐의 끊김에도 깜빡이고, 너무 길면 자고 있는데 붙어 있다고 말한다.
 */
describe('랩탑 생존 판단', () => {
  const now = 1_800_000_000_000

  it('한 번쯤 놓친 heartbeat 는 자리를 비운 것이 아니다', () => {
    // 랩탑은 60초마다 찍는다. 90초는 한 번 놓친 것이고, 그건 흔한 네트워크 끊김이다.
    expect(isLaptopAway(now - 90_000, now)).toBe(false)
  })

  it('두 번 반을 놓치면 자리를 비운 것으로 본다', () => {
    expect(isLaptopAway(now - LAPTOP_STALE_MS - 1, now)).toBe(true)
  })

  it('한 번도 본 적이 없으면 판단하지 않는다', () => {
    // null 은 "죽었다"가 아니라 "모른다"다. 아직 확인 전인데 오프라인이라 말하면 안 된다.
    expect(isLaptopAway(null, now)).toBe(false)
  })
})

describe('경과 표시', () => {
  const now = 1_800_000_000_000

  it('1분 미만은 방금 전이다', () => {
    expect(agoLabel(now - 30_000, now)).toBe('just now')
  })

  it('분·시·일로 올라간다', () => {
    expect(agoLabel(now - 4 * 60_000, now)).toBe('4m ago')
    expect(agoLabel(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(agoLabel(now - 2 * 86_400_000, now)).toBe('2d ago')
  })

  it('미래 시각을 음수로 표시하지 않는다', () => {
    // 랩탑과 폰의 시계는 어긋날 수 있다. "-3m ago" 는 버그처럼 보인다.
    expect(agoLabel(now + 60_000, now)).toBe('just now')
  })
})

describe('데모 명령', () => {
  it('릴레이 없이 상태와 트랜스크립트를 바꾼다', async () => {
    const store = useRemoteStore.getState()
    store.enterDemo()

    const demo = useRemoteStore.getState()
    expect(demo.demo).toBe(true)
    expect(demo.pairing).toBeNull()
    expect(demo.state?.repos).toHaveLength(2)
    // 승인 하나와 질문 하나 — 데모에서도 둘이 어떻게 다르게 그려지는지 보여야 한다.
    expect(demo.state?.pendingPermissions).toHaveLength(2)
    expect(demo.command).not.toBeNull()

    const command = demo.command!
    const initial = (await command('remote:transcript', [
      'mobile-checkout',
      { limit: 100 }
    ])) as Array<{ type: string }>
    expect(initial.map((item) => item.type)).toEqual(
      expect.arrayContaining([
        'user',
        'assistant',
        'thinking',
        'tool_use',
        'tool_result',
        'bash',
        'result'
      ])
    )

    await command('chat:send', ['mobile-checkout', 'Show me the local reply'])
    const updated = (await command('remote:transcript', [
      'mobile-checkout',
      { limit: 100 }
    ])) as Array<{ text?: string }>
    expect(updated.some((item) => item.text === 'Show me the local reply')).toBe(true)

    await command('permission:respond', ['demo-permission', { behavior: 'allow' }])
    const afterAllow = useRemoteStore.getState().state
    expect(afterAllow?.pendingPermissions).toHaveLength(1)
    // 답한 요청의 워크스페이스만 내린다. 하나에 답했다고 다른 워크스페이스의 배지까지
    // 사라지면, 목록만 보고는 아직 기다리는 것이 있다는 사실을 알 수 없다.
    expect(
      afterAllow?.workspaces.find((item) => item.id === 'mobile-checkout')?.attention
    ).toBeNull()
    expect(afterAllow?.workspaces.find((item) => item.id === 'docs-refresh')?.attention).toBe(
      'permission'
    )

    await command('chat:interrupt', ['mobile-checkout'])
    expect(
      useRemoteStore.getState().state?.workspaces.find((item) => item.id === 'mobile-checkout')
        ?.status
    ).toBe('idle')

    useRemoteStore.getState().leaveDemo()
    expect(useRemoteStore.getState().demo).toBe(false)
    expect(useRemoteStore.getState().state).toBeNull()
  })
})

describe('페어링 해제', () => {
  it('세션에 묶인 상태와 콜백을 한 번에 비운다', () => {
    const store = useRemoteStore.getState()
    store.setPairing({
      url: 'https://relay.example',
      anonKey: 'anon',
      machineId: 'machine',
      machineName: 'Laptop',
      deviceId: 'phone',
      sessionKey: 'key'
    })
    store.setStatus('online')
    store.setUpdatedAt(123)
    store.setLaptopSeenAt(456)
    store.setLastError('old error')
    store.setRefresh(async () => undefined)
    store.setCommand(async () => undefined)
    store.setUnpair(async () => 'revoked')

    store.unpaired('Pair again')

    const reset = useRemoteStore.getState()
    expect(reset.pairing).toBeNull()
    expect(reset.state).toBeNull()
    expect(reset.refresh).toBeNull()
    expect(reset.command).toBeNull()
    expect(reset.unpair).toBeNull()
    expect(reset.status).toBe('offline')
    expect(reset.updatedAt).toBeNull()
    expect(reset.laptopSeenAt).toBeNull()
    expect(reset.lastError).toBeNull()
    expect(reset.unpairedReason).toBe('Pair again')
  })

  it('확인된 해제는 조용히 끝내고 대기 중인 해제만 랩탑 정리를 안내한다', () => {
    expect(unpairedNotice('revoked')).toBeNull()
    expect(unpairedNotice('queued')).toContain('Settings → Integrations → Remote access')
  })
})
