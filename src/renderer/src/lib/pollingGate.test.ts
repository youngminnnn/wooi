import { describe, expect, it } from 'vitest'
import { returnedFromIdle, shouldPoll, USER_IDLE_AFTER_MS } from './pollingGate'

const NOW = 1_700_000_000_000

function gate(overrides: Partial<Parameters<typeof shouldPoll>[0]> = {}): boolean {
  return shouldPoll({
    focused: true,
    visible: true,
    lastUserActivityAt: NOW,
    now: NOW,
    ...overrides
  })
}

describe('폴링 게이트', () => {
  it('창이 앞에 있고 보이고 사용자가 방금 입력했으면 돈다', () => {
    expect(gate()).toBe(true)
  })

  it('다른 앱을 쓰는 중이면 멈춘다', () => {
    expect(gate({ focused: false })).toBe(false)
  })

  it('최소화·가려짐이면 포커스가 남아 있어도 멈춘다', () => {
    expect(gate({ visible: false })).toBe(false)
  })

  it('창을 앞에 띄운 채 자리를 비우면 멈춘다 — 예전 게이트가 밤새 git 을 돌리던 경우다', () => {
    expect(gate({ lastUserActivityAt: NOW - USER_IDLE_AFTER_MS })).toBe(false)
  })

  it('자리 비움 직전까지는 계속 돈다 — 긴 diff 를 읽는 동안 배지가 굳지 않는다', () => {
    expect(gate({ lastUserActivityAt: NOW - USER_IDLE_AFTER_MS + 1 })).toBe(true)
  })

  it('입력이 돌아오면 따라잡기 시점으로 본다', () => {
    expect(returnedFromIdle(NOW - USER_IDLE_AFTER_MS, NOW)).toBe(true)
    expect(returnedFromIdle(NOW - USER_IDLE_AFTER_MS + 1, NOW)).toBe(false)
  })
})
