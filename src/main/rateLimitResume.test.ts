import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { activeRateLimitPause } from '@shared/types'
import type { AppState, RateLimitPause, RateLimitSnapshot, Workspace } from '@shared/types'
import {
  CONNECTION_CONTINUATION,
  RATE_LIMIT_CONTINUATION,
  RateLimitResumeCoordinator,
  backoffWait,
  resetMissedResumeGrace,
  exhaustedResetTimes,
  isRateLimited,
  retryTime
} from './rateLimitResume'

const NOW = Date.parse('2026-08-10T00:00:00Z')

let userData = ''

vi.mock('electron', () => ({
  app: { getPath: (): string => userData }
}))

// 트랜스크립트 파일까지 건드릴 이유가 없다 — 코디네이터가 남기는 안내는 여기서 흡수한다.
vi.mock('./transcripts', () => ({
  getTranscripts: () => ({ upsert: () => {} })
}))

beforeAll(() => {
  userData = mkdtempSync(join(tmpdir(), 'wooi-rate-limit-test-'))
})

afterAll(() => {
  rmSync(userData, { recursive: true, force: true })
})

function snapshot(windows: RateLimitSnapshot['windows']): RateLimitSnapshot {
  return { fetchedAt: NOW, available: true, subscriptionType: 'pro', windows }
}

describe('rate-limit resume scheduling', () => {
  it('동시에 소진된 창이 여럿이면 가장 늦게 풀리는 창까지 기다린다', () => {
    const limits = snapshot([
      { label: '5-hour', utilization: 100, resetsAt: '2026-08-10T01:00:00Z' },
      { label: 'weekly', utilization: 100, resetsAt: '2026-08-11T00:00:00Z' }
    ])
    expect(exhaustedResetTimes(limits, NOW)).toHaveLength(2)
    expect(retryTime(limits, NOW)).toBe(Date.parse('2026-08-11T00:00:15Z'))
  })

  it('reset 정보를 얻지 못하면 5분 뒤에 다시 확인한다', () => {
    expect(retryTime(undefined, NOW)).toBe(NOW + 5 * 60_000 + 15_000)
  })

  it('100% 미만인 창은 제한으로 보지 않는다', () => {
    const limits = snapshot([
      { label: '5-hour', utilization: 99, resetsAt: '2026-08-10T01:00:00Z' }
    ])
    expect(exhaustedResetTimes(limits, NOW)).toEqual([])
  })

  it('오류가 알려 준 해제 시각을 쓴다 — 스냅샷이 비어 있어도 그때까지 기다린다', () => {
    const resetAt = NOW + 3 * 60 * 60_000
    expect(retryTime(undefined, NOW, 0, resetAt)).toBe(resetAt + 15_000)
    // 스냅샷과 오류가 둘 다 말해 주면 늦은 쪽까지 기다린다.
    const limits = snapshot([
      { label: '5-hour', utilization: 100, resetsAt: '2026-08-10T01:00:00Z' }
    ])
    expect(retryTime(limits, NOW, 0, resetAt)).toBe(resetAt + 15_000)
  })

  it('해제 시각을 모르면 확인 간격을 배로 늘리고 한 시간에서 멈춘다', () => {
    expect(backoffWait(0)).toBe(5 * 60_000)
    expect(backoffWait(1)).toBe(10 * 60_000)
    expect(backoffWait(2)).toBe(20 * 60_000)
    expect(backoffWait(9)).toBe(60 * 60_000)
    expect(retryTime(undefined, NOW, 2)).toBe(NOW + 20 * 60_000 + 15_000)
  })

  it('새 스냅샷의 reset 시각이 지났다면 사용률 갱신이 늦어도 제한이 풀린 것으로 본다', () => {
    const limits = snapshot([
      { label: '5-hour', utilization: 100, resetsAt: '2026-08-09T23:00:00Z' }
    ])
    expect(exhaustedResetTimes(limits, NOW)).toEqual([])
    expect(isRateLimited(limits, NOW)).toBe(false)
    expect(
      isRateLimited(
        snapshot([{ label: '5-hour', utilization: 100, resetsAt: '2026-08-10T01:00:00Z' }]),
        NOW
      )
    ).toBe(true)
    // reset 시각을 받지 못했다면 100% 신호를 버릴 근거가 없으므로 계속 제한으로 본다.
    expect(
      isRateLimited(snapshot([{ label: '5-hour', utilization: 100, resetsAt: null }]), NOW)
    ).toBe(true)
    expect(isRateLimited(snapshot([{ label: '5-hour', utilization: 40, resetsAt: null }]))).toBe(
      false
    )
  })
})

describe('activeRateLimitPause', () => {
  const pause = (resetsAt: number | null, detectedAt = NOW): RateLimitPause => ({
    backend: 'claude',
    detectedAt,
    resetsAt
  })

  it('해제 시각이 지나면 표시를 거둔다', () => {
    expect(activeRateLimitPause(pause(NOW + 60_000), NOW)).not.toBeNull()
    expect(activeRateLimitPause(pause(NOW - 1), NOW)).toBeNull()
  })

  it('해제 시각을 모르면 12시간까지만 보여 준다', () => {
    expect(activeRateLimitPause(pause(null), NOW + 60_000)).not.toBeNull()
    expect(activeRateLimitPause(pause(null), NOW + 13 * 60 * 60_000)).toBeNull()
    expect(activeRateLimitPause(null, NOW)).toBeNull()
  })
})

/**
 * 코디네이터의 계약: **제한이 안 풀렸는데 계속 보내지 않는다.** 이어 보내기 직전에 예약 레코드를
 * 지우므로, 시도 횟수를 따로 들고 있지 않으면 다시 걸릴 때마다 attempt 가 0 으로 되돌아가
 * 영원히 몇 분마다 재시도한다(사용자가 겪은 증상).
 */
describe('RateLimitResumeCoordinator', () => {
  const WORKSPACE_ID = 'ws-1'

  function seedWorkspace(store: { update: (mutate: (state: AppState) => void) => void }): void {
    store.update((draft) => {
      draft.workspaces = [
        {
          id: WORKSPACE_ID,
          repoId: 'repo-1',
          agentBackend: 'claude',
          name: 'ws',
          displayName: null,
          branch: 'feat/x',
          baseBranch: 'main',
          worktreePath: '/tmp/ws',
          status: 'idle',
          sessionId: 'sess-1',
          archived: false,
          pendingRateLimitResume: null,
          rateLimited: null
        } as unknown as Workspace
      ]
      draft.settings.autoResumeAfterRateLimit = true
      draft.rateLimitsByAgent = {
        // 제한에 걸렸지만 사용량 API 는 그 사실을 싣지 못한 상태(라이브 세션 없이 조회한 경우).
        claude: { fetchedAt: 1, available: true, subscriptionType: 'pro', windows: [] }
      }
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('예약이 생기고 사라질 때마다 상태를 방송한다 — 사이드바가 알 길이 이것뿐이다', async () => {
    const { getStore } = await import('./store')
    seedWorkspace(getStore())
    let broadcasts = 0
    const coordinator = new RateLimitResumeCoordinator({
      backend: 'claude',
      refreshLimits: async () => {},
      sendContinuation: () => {},
      emitItem: () => {},
      broadcastState: () => broadcasts++
    })

    await coordinator.noteRateLimit(WORKSPACE_ID)
    expect(getStore().getState().workspaces[0].pendingRateLimitResume?.backend).toBe('claude')
    const afterSchedule = broadcasts
    expect(afterSchedule).toBeGreaterThan(0)

    coordinator.cancel(WORKSPACE_ID)
    expect(getStore().getState().workspaces[0].pendingRateLimitResume).toBeNull()
    expect(getStore().getState().workspaces[0].rateLimited).toBeNull()
    expect(broadcasts).toBeGreaterThan(afterSchedule)
  })

  it('자동 이어가기가 꺼져 있어도 제한 표시는 남긴다', async () => {
    const { getStore } = await import('./store')
    const store = getStore()
    seedWorkspace(store)
    store.update((state) => {
      state.settings.autoResumeAfterRateLimit = false
    })
    let broadcasts = 0
    const coordinator = new RateLimitResumeCoordinator({
      backend: 'claude',
      refreshLimits: async () => {},
      sendContinuation: () => {},
      emitItem: () => {},
      broadcastState: () => broadcasts++
    })

    const resetAt = Date.now() + 2 * 60 * 60_000
    await coordinator.noteRateLimit(WORKSPACE_ID, resetAt)

    const ws = store.getState().workspaces[0]
    expect(ws.rateLimited).toEqual({
      backend: 'claude',
      detectedAt: expect.any(Number),
      resetsAt: resetAt
    })
    // 이어가기 예약은 걸지 않는다 — 사용자가 끄기로 한 동작이다.
    expect(ws.pendingRateLimitResume).toBeNull()
    expect(broadcasts).toBeGreaterThan(0)
  })

  it('오류가 시각을 안 알려 주면 사용량 조회로 해제 시각을 채운다', async () => {
    const { getStore } = await import('./store')
    const store = getStore()
    seedWorkspace(store)
    store.update((state) => {
      state.settings.autoResumeAfterRateLimit = false
    })
    const resetsAt = new Date(Date.now() + 90 * 60_000).toISOString()
    const coordinator = new RateLimitResumeCoordinator({
      backend: 'claude',
      refreshLimits: async () => {
        store.update((state) => {
          state.rateLimitsByAgent = {
            ...state.rateLimitsByAgent,
            claude: {
              fetchedAt: Date.now(),
              available: true,
              subscriptionType: 'pro',
              windows: [{ label: '5-hour', utilization: 100, resetsAt }]
            }
          }
        })
      },
      sendContinuation: () => {},
      emitItem: () => {},
      broadcastState: () => {}
    })

    await coordinator.noteRateLimit(WORKSPACE_ID)
    expect(store.getState().workspaces[0].rateLimited?.resetsAt).toBe(Date.parse(resetsAt))
  })

  it('제한 오류가 알려 준 해제 시각까지 기다린다', async () => {
    const { getStore } = await import('./store')
    seedWorkspace(getStore())
    const coordinator = new RateLimitResumeCoordinator({
      backend: 'claude',
      refreshLimits: async () => {},
      sendContinuation: () => {},
      emitItem: () => {},
      broadcastState: () => {}
    })

    const resetAt = Date.now() + 4 * 60 * 60_000
    await coordinator.noteRateLimit(WORKSPACE_ID, resetAt)
    expect(getStore().getState().workspaces[0].pendingRateLimitResume?.retryAt).toBe(
      resetAt + 15_000
    )
  })

  it('해제 시각을 몰라도 백오프 뒤 사용량 조회가 실패하면 실제 턴으로 확인한다', async () => {
    const { getStore } = await import('./store')
    const store = getStore()
    seedWorkspace(store)
    const sent = vi.fn()
    const coordinator = new RateLimitResumeCoordinator({
      backend: 'claude',
      // fetchedAt 이 바뀌지 않는 실제 조회 장애를 재현한다.
      refreshLimits: async () => {},
      sendContinuation: sent,
      emitItem: () => {},
      broadcastState: () => {}
    })

    await coordinator.noteRateLimit(WORKSPACE_ID)
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 15_000)

    expect(sent).toHaveBeenCalledWith(WORKSPACE_ID, RATE_LIMIT_CONTINUATION)
    expect(store.getState().workspaces[0].pendingRateLimitResume).toBeNull()
    expect(store.getState().workspaces[0].rateLimited).toBeNull()
  })

  it('Claude 사용률이 100%로 늦게 갱신돼도 reset 시각이 지났으면 이어 보낸다', async () => {
    const { getStore } = await import('./store')
    const store = getStore()
    seedWorkspace(store)
    const sent = vi.fn()
    const coordinator = new RateLimitResumeCoordinator({
      backend: 'claude',
      refreshLimits: async () => {
        store.update((state) => {
          state.rateLimitsByAgent = {
            ...state.rateLimitsByAgent,
            claude: {
              fetchedAt: Date.now(),
              available: true,
              subscriptionType: 'pro',
              windows: [
                {
                  label: '5-hour',
                  utilization: 100,
                  resetsAt: new Date(Date.now() - 1_000).toISOString()
                }
              ]
            }
          }
        })
      },
      sendContinuation: sent,
      emitItem: () => {},
      broadcastState: () => {}
    })

    await coordinator.noteRateLimit(WORKSPACE_ID, Date.now() + 60_000)
    await vi.advanceTimersByTimeAsync(75_000)

    expect(sent).toHaveBeenCalledWith(WORKSPACE_ID, RATE_LIMIT_CONTINUATION)
    expect(store.getState().workspaces[0].pendingRateLimitResume).toBeNull()
    expect(store.getState().workspaces[0].rateLimited).toBeNull()
  })

  it('네트워크가 없으면 보내지 않고 기다렸다가, 연결이 돌아오면 이어 보낸다', async () => {
    const { getStore } = await import('./store')
    const store = getStore()
    seedWorkspace(store)
    let online = false
    const sent = vi.fn()
    const coordinator = new RateLimitResumeCoordinator({
      backend: 'claude',
      refreshLimits: async () => {},
      sendContinuation: sent,
      emitItem: () => {},
      isOnline: () => online,
      broadcastState: () => {}
    })

    await coordinator.noteRateLimit(WORKSPACE_ID)
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 15_000)

    // 오프라인에서는 한 번도 보내지 않는다 — 보내 봐야 오류 카드만 쌓인다.
    expect(sent).not.toHaveBeenCalled()
    expect(store.getState().workspaces[0].pendingRateLimitResume?.blocked).toBe('offline')

    online = true
    await vi.advanceTimersByTimeAsync(30_000)
    expect(sent).toHaveBeenCalledWith(WORKSPACE_ID, RATE_LIMIT_CONTINUATION)
    expect(store.getState().workspaces[0].pendingRateLimitResume).toBeNull()
  })

  it('맥이 자는 동안 예약 시각이 지나 버려도 깨어나서 이어 보낸다', async () => {
    const { getStore } = await import('./store')
    seedWorkspace(getStore())
    const sent = vi.fn()
    const coordinator = new RateLimitResumeCoordinator({
      backend: 'claude',
      refreshLimits: async () => {},
      sendContinuation: sent,
      emitItem: () => {},
      isOnline: () => true,
      broadcastState: () => {}
    })

    await coordinator.noteRateLimit(WORKSPACE_ID, Date.now() + 5 * 60 * 60_000)
    // 잠든 사이 벽시계만 6시간 흘렀다(가짜 타이머의 setSystemTime 은 예약된 타이머의 남은 시간을
    // 그대로 유지한다 — 잠든 동안 멈춰 있던 타이머와 같은 상황이다).
    vi.setSystemTime(Date.now() + 6 * 60 * 60_000)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(sent).toHaveBeenCalledWith(WORKSPACE_ID, RATE_LIMIT_CONTINUATION)
  })

  it('이어 보낸 턴이 실패하면 다시 예약하고, 그래도 안 되면 예산 안에서 멈춘다', async () => {
    const { getStore } = await import('./store')
    const store = getStore()
    seedWorkspace(store)
    let sent = 0
    const coordinator = new RateLimitResumeCoordinator({
      backend: 'claude',
      refreshLimits: async () => {},
      sendContinuation: (workspaceId) => {
        sent++
        // 턴이 제한이 아닌 이유로 실패한다(호스트가 죽었다·요청이 끊겼다).
        coordinator.noteTurnEnd(workspaceId, 'error')
      },
      emitItem: () => {},
      isOnline: () => true,
      broadcastState: () => {}
    })

    await coordinator.noteRateLimit(WORKSPACE_ID)
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 15_000)

    expect(sent).toBe(1)
    // 예전에는 여기서 오류 카드 한 장만 남고 예약이 사라져 영영 이어가지 못했다.
    expect(store.getState().workspaces[0].pendingRateLimitResume?.blocked).toBe('error')

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    expect(sent).toBe(5)
    expect(store.getState().workspaces[0].pendingRateLimitResume).toBeNull()
  })

  it('네트워크가 끊겨 실패한 턴은 시도 예산을 쓰지 않는다', async () => {
    const { getStore } = await import('./store')
    const store = getStore()
    seedWorkspace(store)
    let online = true
    let sent = 0
    const coordinator = new RateLimitResumeCoordinator({
      backend: 'claude',
      refreshLimits: async () => {},
      sendContinuation: (workspaceId) => {
        sent++
        // 보내는 도중에 네트워크가 끊긴다.
        online = false
        coordinator.noteTurnEnd(workspaceId, 'error')
      },
      emitItem: () => {},
      isOnline: () => online,
      broadcastState: () => {}
    })

    await coordinator.noteRateLimit(WORKSPACE_ID)
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 15_000)

    expect(sent).toBe(1)
    expect(store.getState().workspaces[0].pendingRateLimitResume?.blocked).toBe('offline')

    // 끊겨 있는 동안 하루가 지나도 아무것도 보내지 않고, 예약도 접지 않는다 — 연결만 기다린다.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    expect(sent).toBe(1)
    expect(store.getState().workspaces[0].pendingRateLimitResume?.blocked).toBe('offline')

    // 예산을 쓰지 않았으므로, 연결이 돌아오면 (몇 번이 됐든) 다시 이어 보낸다.
    online = true
    await vi.advanceTimersByTimeAsync(30_000)
    expect(sent).toBe(2)
  })

  it('이어 보낸 턴이 곧바로 다시 걸리면 시도 횟수를 이어받아 결국 멈춘다', async () => {
    const { getStore } = await import('./store')
    const store = getStore()
    seedWorkspace(store)
    let sent = 0
    const coordinator = new RateLimitResumeCoordinator({
      backend: 'claude',
      // 조회는 성공하지만(스냅샷이 새로 찍힌다) 제한 사실은 실어 오지 못한다 — 예전 코드가
      // "풀렸다" 로 오해해 곧장 다시 보내던 상황 그대로다.
      refreshLimits: async () => {
        store.update((state) => {
          state.rateLimitsByAgent = {
            ...state.rateLimitsByAgent,
            claude: {
              fetchedAt: Date.now(),
              available: true,
              subscriptionType: 'pro',
              windows: []
            }
          }
        })
      },
      sendContinuation: () => {
        sent++
        // 백엔드가 곧바로 또 제한을 물고 온다.
        void coordinator.noteRateLimit(WORKSPACE_ID)
      },
      emitItem: () => {},
      broadcastState: () => {}
    })

    await coordinator.noteRateLimit(WORKSPACE_ID)
    // 넉넉히 하루를 흘려보내도(백오프 상한이 1시간) 시도는 예산 안에서 멈춘다.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)

    // 예산(5회)만큼만 보낸다 — 예전에는 attempt 가 매번 0 으로 되돌아가 끝없이 보냈다.
    expect(sent).toBe(5)
    expect(store.getState().workspaces[0].pendingRateLimitResume).toBeNull()
  })
})

/**
 * API 에 닿지 못해 멈춘 턴의 계약. 사용량 제한과 달리 **누가 보낸 턴이든** 이어가기 대상이고,
 * 언제 풀릴지 아무도 알려 주지 않으므로 시도 예산이 아니라 확인 간격으로 물러선다.
 */
describe('연결 실패 이어가기', () => {
  const WORKSPACE_ID = 'ws-1'

  function seed(store: { update: (mutate: (state: AppState) => void) => void }): void {
    store.update((draft) => {
      draft.workspaces = [
        {
          id: WORKSPACE_ID,
          repoId: 'repo-1',
          agentBackend: 'claude',
          name: 'ws',
          displayName: null,
          branch: 'feat/x',
          baseBranch: 'main',
          worktreePath: '/tmp/ws',
          status: 'error',
          sessionId: 'sess-1',
          archived: false,
          pendingRateLimitResume: null,
          rateLimited: null
        } as unknown as Workspace
      ]
      draft.settings.autoResumeAfterRateLimit = true
      draft.rateLimitsByAgent = {}
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('사용자가 직접 보낸 턴이 ENOTFOUND 로 죽어도 이어가기를 예약한다', async () => {
    const { getStore } = await import('./store')
    const store = getStore()
    seed(store)
    const sent = vi.fn()
    const coordinator = new RateLimitResumeCoordinator({
      backend: 'claude',
      // 조회가 새 fetchedAt 을 찍었다 = 요청이 서버까지 갔다 왔다 = 연결이 돌아왔다.
      refreshLimits: async () => {
        store.update((state) => {
          state.rateLimitsByAgent = {
            claude: {
              fetchedAt: Date.now(),
              available: true,
              subscriptionType: 'pro',
              windows: []
            }
          }
        })
      },
      sendContinuation: sent,
      emitItem: () => {},
      broadcastState: () => {}
    })

    coordinator.noteConnectionLost(WORKSPACE_ID)

    const pending = store.getState().workspaces[0].pendingRateLimitResume
    expect(pending?.cause).toBe('connection')
    expect(pending?.blocked).toBe('offline')
    // 제한에 걸린 것이 아니므로 제한 표시는 남기지 않는다 — 없는 제한을 기다리게 하면 안 된다.
    expect(store.getState().workspaces[0].rateLimited).toBeNull()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(sent).toHaveBeenCalledWith(WORKSPACE_ID, CONNECTION_CONTINUATION)
    expect(store.getState().workspaces[0].pendingRateLimitResume).toBeNull()
  })

  it('연결이 안 돌아오는 동안에는 조회로만 확인하고 대화에 이어가기 지시를 쌓지 않는다', async () => {
    const { getStore } = await import('./store')
    const store = getStore()
    seed(store)
    let sent = 0
    let probes = 0
    const coordinator: RateLimitResumeCoordinator = new RateLimitResumeCoordinator({
      backend: 'claude',
      // 조회도 못 닿는다 — fetchedAt 이 갱신되지 않는다.
      refreshLimits: async () => {
        probes++
      },
      sendContinuation: () => {
        sent++
        // 실제 턴도 같은 이유로 죽는다.
        coordinator.noteConnectionLost(WORKSPACE_ID)
        coordinator.noteTurnEnd(WORKSPACE_ID, 'error')
      },
      emitItem: () => {},
      broadcastState: () => {}
    })

    coordinator.noteConnectionLost(WORKSPACE_ID)
    await vi.advanceTimersByTimeAsync(60 * 60_000)

    // 한 시간 동안 확인은 여러 번 하되(30s→5m 로 물러선다), 대화를 건드리는 실제 턴은 드물게만
    // 보낸다 — 예전 설계처럼 매번 보내면 이어가기 지시가 트랜스크립트에 수십 개 쌓인다.
    expect(probes).toBeGreaterThan(5)
    expect(sent).toBeLessThanOrEqual(3)
    // 그래도 포기하지는 않는다 — 예약이 살아 있어야 연결이 돌아왔을 때 이어갈 수 있다.
    expect(store.getState().workspaces[0].pendingRateLimitResume?.cause).toBe('connection')
  })

  it('안내는 기다리기 시작할 때 한 번만 남긴다 — 확인할 때마다 쌓지 않는다', async () => {
    const { getStore } = await import('./store')
    const store = getStore()
    seed(store)
    const items: string[] = []
    const coordinator: RateLimitResumeCoordinator = new RateLimitResumeCoordinator({
      backend: 'claude',
      refreshLimits: async () => {},
      sendContinuation: () => {
        coordinator.noteConnectionLost(WORKSPACE_ID)
        coordinator.noteTurnEnd(WORKSPACE_ID, 'error')
      },
      emitItem: (_id, item) => {
        if (item.type === 'system') items.push(item.text)
      },
      broadcastState: () => {}
    })

    coordinator.noteConnectionLost(WORKSPACE_ID)
    await vi.advanceTimersByTimeAsync(60 * 60_000)

    expect(items.filter((text) => text.includes('could not reach the API'))).toHaveLength(1)
  })

  it('사용량 제한 예약을 연결 실패로 덮지 않는다 — 해제 시각을 아는 쪽이 우선이다', async () => {
    const { getStore } = await import('./store')
    const store = getStore()
    seed(store)
    const coordinator = new RateLimitResumeCoordinator({
      backend: 'claude',
      refreshLimits: async () => {},
      sendContinuation: () => {},
      emitItem: () => {},
      broadcastState: () => {}
    })

    const resetAt = Date.now() + 4 * 60 * 60_000
    await coordinator.noteRateLimit(WORKSPACE_ID, resetAt)
    coordinator.noteConnectionLost(WORKSPACE_ID)

    const pending = store.getState().workspaces[0].pendingRateLimitResume
    expect(pending?.cause).toBe('rateLimit')
    expect(pending?.retryAt).toBe(resetAt + 15_000)
  })

  it('자동 이어가기가 꺼져 있으면 예약하지 않는다', async () => {
    const { getStore } = await import('./store')
    const store = getStore()
    seed(store)
    store.update((state) => {
      state.settings.autoResumeAfterRateLimit = false
    })
    const coordinator = new RateLimitResumeCoordinator({
      backend: 'claude',
      refreshLimits: async () => {},
      sendContinuation: () => {},
      emitItem: () => {},
      broadcastState: () => {}
    })

    coordinator.noteConnectionLost(WORKSPACE_ID)
    expect(store.getState().workspaces[0].pendingRateLimitResume).toBeNull()
  })
})

/**
 * 복귀 정책의 계약: **앱이 꺼져 있던 동안 밀린 예약을 켜자마자 몰아서 보내지 않는다.**
 * 데스크톱 앱이라 예약 시각에 프로세스가 없을 수 있고, 그때 그냥 다시 걸면 워크스페이스 수만큼의
 * 턴이 동시에 시작된다 — 깨움 하나가 곧 사용자 토큰 하나이므로 이것이 막아야 할 최악이다.
 */
describe('놓친 예약의 유예(grace) 정책', () => {
  interface Spec {
    id: string
    retryAt: number
  }

  function seedPending(
    store: { update: (mutate: (state: AppState) => void) => void },
    specs: Spec[]
  ): void {
    store.update((draft) => {
      draft.workspaces = specs.map(
        ({ id, retryAt }) =>
          ({
            id,
            repoId: 'repo-1',
            agentBackend: 'claude',
            name: id,
            displayName: null,
            branch: `feat/${id}`,
            baseBranch: 'main',
            worktreePath: `/tmp/${id}`,
            status: 'idle',
            sessionId: `sess-${id}`,
            archived: false,
            rateLimited: null,
            pendingRateLimitResume: {
              backend: 'claude',
              sessionId: `sess-${id}`,
              detectedAt: retryAt - 60_000,
              cause: 'rateLimit',
              retryAt,
              attempt: 0
            }
          }) as unknown as Workspace
      )
      draft.settings.autoResumeAfterRateLimit = true
      draft.rateLimitsByAgent = {
        claude: { fetchedAt: 1, available: true, subscriptionType: 'pro', windows: [] }
      }
    })
  }

  function coordinatorWith(continued: string[], notices: string[]): RateLimitResumeCoordinator {
    return new RateLimitResumeCoordinator({
      backend: 'claude',
      refreshLimits: async () => {},
      sendContinuation: (workspaceId) => continued.push(workspaceId),
      emitItem: (workspaceId, item) => notices.push(`${workspaceId}:${item.type}`),
      broadcastState: () => {}
    })
  }

  const pendingOf = (state: AppState, id: string): unknown =>
    state.workspaces.find((ws) => ws.id === id)?.pendingRateLimitResume

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    resetMissedResumeGrace()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('밀린 예약이 여럿이어도 가장 최근 것 하나만 이어가고 나머지는 버린다', async () => {
    const { getStore } = await import('./store')
    seedPending(getStore(), [
      { id: 'ws-old', retryAt: NOW - 30 * 60_000 },
      { id: 'ws-new', retryAt: NOW - 60_000 },
      { id: 'ws-mid', retryAt: NOW - 10 * 60_000 }
    ])
    const continued: string[] = []
    const notices: string[] = []
    coordinatorWith(continued, notices).restore()
    await vi.advanceTimersByTimeAsync(1)

    expect(continued).toEqual(['ws-new'])
    const state = getStore().getState()
    expect(pendingOf(state, 'ws-old')).toBeNull()
    expect(pendingOf(state, 'ws-mid')).toBeNull()
    // 버린 것은 조용히 알린다 — 자동으로 돌리지는 않는다.
    expect(notices.filter((text) => text.startsWith('ws-old:'))).toHaveLength(1)
    expect(notices.filter((text) => text.startsWith('ws-mid:'))).toHaveLength(1)
  })

  it('유예 창을 넘긴 예약은 이어가지 않고 버린다', async () => {
    const { getStore } = await import('./store')
    seedPending(getStore(), [{ id: 'ws-stale', retryAt: NOW - 2 * 60 * 60_000 }])
    const continued: string[] = []
    const notices: string[] = []
    coordinatorWith(continued, notices).restore()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(continued).toEqual([])
    expect(pendingOf(getStore().getState(), 'ws-stale')).toBeNull()
    expect(notices).toHaveLength(1)
  })

  it('시각이 아직 오지 않은 예약은 그대로 살려 두고 유예 예산도 쓰지 않는다', async () => {
    const { getStore } = await import('./store')
    seedPending(getStore(), [
      { id: 'ws-future', retryAt: NOW + 30 * 60_000 },
      { id: 'ws-missed', retryAt: NOW - 60_000 }
    ])
    const continued: string[] = []
    const notices: string[] = []
    coordinatorWith(continued, notices).restore()
    await vi.advanceTimersByTimeAsync(1)

    expect(continued).toEqual(['ws-missed'])
    expect(pendingOf(getStore().getState(), 'ws-future')).not.toBeNull()
  })

  it('빗장은 백엔드 사이에서도 공유된다 — 복귀 한 번에 깨움은 하나뿐이다', async () => {
    const { getStore } = await import('./store')
    seedPending(getStore(), [
      { id: 'ws-claude', retryAt: NOW - 60_000 },
      { id: 'ws-codex', retryAt: NOW - 2 * 60_000 }
    ])
    getStore().update((draft) => {
      const codex = draft.workspaces.find((ws) => ws.id === 'ws-codex')!
      codex.agentBackend = 'codex'
      codex.pendingRateLimitResume!.backend = 'codex'
    })
    const continued: string[] = []
    const notices: string[] = []
    coordinatorWith(continued, notices).restore()
    new RateLimitResumeCoordinator({
      backend: 'codex',
      refreshLimits: async () => {},
      sendContinuation: (workspaceId) => continued.push(workspaceId),
      emitItem: (workspaceId, item) => notices.push(`${workspaceId}:${item.type}`),
      broadcastState: () => {}
    }).restore()
    await vi.advanceTimersByTimeAsync(1)

    expect(continued).toEqual(['ws-claude'])
    expect(pendingOf(getStore().getState(), 'ws-codex')).toBeNull()
  })
})
