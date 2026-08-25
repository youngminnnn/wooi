import { describe, it, expect, beforeEach } from 'vitest'
import type { UsageTotals } from '@shared/types'
import {
  forgetWorkspaceUsage,
  getWorkspaceUsage,
  recordDelegatedUsage,
  recordReviewUsage,
  recordSessionUsage,
  resetUsageLedgerForTests
} from './usageLedger'

/**
 * 장부의 어려운 부분은 전부 "SDK 의 누계를 어떻게 다루는가" 에 있다 — result 들을 더하면 안 되고,
 * 세션이 다시 열리면 그 누계가 0부터 다시 시작한다. 여기서 못 박는 것이 그 규칙이다.
 */

const usage = (
  cacheRead: number,
  cacheWrite: number,
  costUsd = 0,
  input = 0,
  output = 0
): UsageTotals => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheCreationTokens: cacheWrite,
  costUsd
})

describe('usageLedger', () => {
  beforeEach(() => {
    resetUsageLedgerForTests()
  })

  it('한 턴도 안 돌았으면 undefined 다 — 0 으로 채운 장부와 구분한다', () => {
    expect(getWorkspaceUsage('ws-1')).toBeUndefined()
  })

  it('같은 query 안에서는 누계를 더하지 않고 마지막 것을 읽는다', () => {
    recordSessionUsage('ws-1', 'run-a', usage(1_000, 500, 0.01))
    recordSessionUsage('ws-1', 'run-a', usage(3_000, 800, 0.03))

    // 더했다면 4,000 이 나온다. 마지막 누계만 읽어야 3,000 이다.
    expect(getWorkspaceUsage('ws-1')?.total.cacheReadTokens).toBe(3_000)
    expect(getWorkspaceUsage('ws-1')?.total.costUsd).toBeCloseTo(0.03)
    expect(getWorkspaceUsage('ws-1')?.sessionRestarts).toBe(0)
  })

  it('runId 가 바뀌면 세션이 다시 열린 것이다 — 이전 구간을 확정하고 더한다', () => {
    recordSessionUsage('ws-1', 'run-a', usage(3_000, 800, 0.03))
    recordSessionUsage('ws-1', 'run-b', usage(100, 4_000, 0.02))

    const info = getWorkspaceUsage('ws-1')
    expect(info?.total.cacheReadTokens).toBe(3_100)
    expect(info?.total.cacheCreationTokens).toBe(4_800)
    expect(info?.total.costUsd).toBeCloseTo(0.05)
    expect(info?.sessionRestarts).toBe(1)
  })

  it('다시 열린 세션의 첫 누계가 이전 구간보다 커도 구간은 갈린다', () => {
    // 숫자로 리셋을 추측하면 여기서 틀린다 — 짧게 끝난 세션 다음 세션의 첫 턴은 대화를 통째로
    // 다시 읽느라 이전 세션의 총계보다 클 수 있다.
    recordSessionUsage('ws-1', 'run-a', usage(0, 500, 0.005))
    recordSessionUsage('ws-1', 'run-b', usage(0, 60_000, 0.6))

    const info = getWorkspaceUsage('ws-1')
    expect(info?.total.cacheCreationTokens).toBe(60_500)
    expect(info?.sessionRestarts).toBe(1)
  })

  it('첫 구간은 재시작이 아니다', () => {
    recordSessionUsage('ws-1', 'run-a', usage(10, 20, 0.001))
    expect(getWorkspaceUsage('ws-1')?.sessionRestarts).toBe(0)
  })

  it('세션 중 /clear 는 토큰을 지키되 재시작으로 세지 않는다', () => {
    // query 는 그대로인데(runId 동일) 누계만 되돌아가는 것이 세션 중 /clear 의 모양이다.
    recordSessionUsage('ws-1', 'run-a', usage(3_000, 800, 0.03))
    recordSessionUsage('ws-1', 'run-a', usage(0, 200, 0.002))

    const info = getWorkspaceUsage('ws-1')
    expect(info?.total.cacheReadTokens).toBe(3_000)
    expect(info?.total.cacheCreationTokens).toBe(1_000)
    expect(info?.sessionRestarts).toBe(0)
  })

  it('통째로 0 인 스냅샷은 무시한다 — 크래시 result 가 구간을 0 으로 덮으면 안 된다', () => {
    recordSessionUsage('ws-1', 'run-a', usage(3_000, 800, 0.03))
    recordSessionUsage('ws-1', 'run-a', usage(0, 0, 0))

    const info = getWorkspaceUsage('ws-1')
    expect(info?.sessionRestarts).toBe(0)
    expect(info?.total.cacheReadTokens).toBe(3_000)
  })

  it('위임 서브런은 한 번에 하나씩 더한다(누계가 아니라 1회분이다)', () => {
    recordSessionUsage('ws-1', 'run-a', usage(1_000, 200, 0.01))
    recordDelegatedUsage('ws-1', usage(0, 5_000, 0.05))
    recordDelegatedUsage('ws-1', usage(0, 3_000, 0.03))

    const info = getWorkspaceUsage('ws-1')
    expect(info?.delegated.cacheCreationTokens).toBe(8_000)
    // 위임 몫은 워크스페이스 총계에 포함된다 — 부모 회계에 안 잡히는 Wooi 고유 비용이다.
    expect(info?.total.cacheCreationTokens).toBe(8_200)
    expect(info?.total.costUsd).toBeCloseTo(0.09)
  })

  it('리뷰는 워크스페이스 총계에 섞이지 않고 앱 전체 칸에 쌓인다', () => {
    recordSessionUsage('ws-1', 'run-a', usage(1_000, 200, 0.01))
    recordReviewUsage(usage(0, 9_000, 0.09))

    const info = getWorkspaceUsage('ws-1')
    expect(info?.reviews.cacheCreationTokens).toBe(9_000)
    expect(info?.total.cacheCreationTokens).toBe(200)
    expect(info?.total.costUsd).toBeCloseTo(0.01)
    // 워크스페이스에 매인 값이 아니므로 다른 워크스페이스에서도 같은 값이 보인다.
    expect(getWorkspaceUsage('ws-2')?.reviews.cacheCreationTokens).toBe(9_000)
  })

  it('워크스페이스끼리 섞이지 않는다', () => {
    recordSessionUsage('ws-1', 'run-a', usage(1_000, 0, 0.01))
    // runId 는 워크스페이스마다 따로 센다 — 같은 id 가 와도 남의 구간을 건드리지 않는다.
    recordSessionUsage('ws-2', 'run-a', usage(7_000, 0, 0.07))

    expect(getWorkspaceUsage('ws-1')?.total.cacheReadTokens).toBe(1_000)
    expect(getWorkspaceUsage('ws-2')?.total.cacheReadTokens).toBe(7_000)
    expect(getWorkspaceUsage('ws-2')?.sessionRestarts).toBe(0)
  })

  it('/clear 는 장부를 비운다 — 재시작 카운트까지', () => {
    recordSessionUsage('ws-1', 'run-a', usage(3_000, 800, 0.03))
    recordSessionUsage('ws-1', 'run-b', usage(100, 4_000, 0.02))
    expect(getWorkspaceUsage('ws-1')?.sessionRestarts).toBe(1)

    forgetWorkspaceUsage('ws-1')
    expect(getWorkspaceUsage('ws-1')).toBeUndefined()

    // 비운 뒤 이어지는 첫 구간은 재시작이 아니라 새 장부의 시작이다.
    recordSessionUsage('ws-1', 'run-c', usage(50, 900, 0.005))
    expect(getWorkspaceUsage('ws-1')?.sessionRestarts).toBe(0)
    expect(getWorkspaceUsage('ws-1')?.total.cacheCreationTokens).toBe(900)
  })
})
