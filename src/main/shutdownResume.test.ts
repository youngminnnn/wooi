import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState, Workspace } from '@shared/types'
import {
  SHUTDOWN_CONTINUATION,
  SHUTDOWN_RESUME_GRACE_MS,
  ShutdownResumeCoordinator
} from './shutdownResume'
import { RateLimitResumeCoordinator } from './rateLimitResume'
import { resetResumeBudget } from './resumeBudget'

let userData = ''
vi.mock('electron', () => ({ app: { getPath: (): string => userData } }))
vi.mock('./transcripts', () => ({ getTranscripts: () => ({ upsert: () => {} }) }))

beforeAll(() => {
  userData = mkdtempSync(join(tmpdir(), 'wooi-shutdown-resume-test-'))
})
afterAll(() => rmSync(userData, { recursive: true, force: true }))

describe('ShutdownResumeCoordinator', () => {
  const NOW = Date.parse('2026-09-01T00:00:00Z')

  function seed(
    store: { update: (mutate: (state: AppState) => void) => void },
    specs: Array<{
      id: string
      reason: 'update' | 'background' | 'quit' | 'crash'
      at?: number
      sessionId?: string | null
    }>
  ): void {
    store.update((draft) => {
      draft.workspaces = specs.map(
        ({ id, reason, at = NOW - 1_000, sessionId = `sess-${id}` }) =>
          ({
            id,
            repoId: 'repo-1',
            agentBackend: 'claude',
            name: id,
            branch: `feat/${id}`,
            baseBranch: 'main',
            worktreePath: `/tmp/${id}`,
            status: 'idle',
            sessionId,
            archived: false,
            pendingShutdownResume: {
              backend: 'claude',
              sessionId: `sess-${id}`,
              at,
              reason
            }
          }) as unknown as Workspace
      )
      draft.settings.resumeUnfinishedTurnsOnLaunch = true
      draft.settings.autoResumeAfterRateLimit = true
      draft.rateLimitsByAgent = {
        claude: { fetchedAt: NOW, available: true, subscriptionType: 'pro', windows: [] }
      }
    })
  }

  function coordinator(sent: string[], notices: string[]): ShutdownResumeCoordinator {
    return new ShutdownResumeCoordinator({
      backend: 'claude',
      sendContinuation: (id, text) => sent.push(`${id}:${text}`),
      emitItem: (id, item) => {
        if (item.type === 'system') notices.push(`${id}:${item.text}`)
      },
      broadcastState: () => {}
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    resetResumeBudget()
  })
  afterEach(() => vi.useRealTimers())

  for (const reason of ['quit', 'update', 'background'] as const) {
    it(`${reason} 종료는 보류된 턴을 모두 이어간다`, async () => {
      const { getStore } = await import('./store')
      seed(getStore(), [
        { id: 'one', reason },
        { id: 'two', reason }
      ])
      const sent: string[] = []
      coordinator(sent, []).restore()
      expect(sent).toEqual([`one:${SHUTDOWN_CONTINUATION}`, `two:${SHUTDOWN_CONTINUATION}`])
    })
  }

  it('crash는 최신 하나만 이어가고 나머지는 안내와 함께 버린다', async () => {
    const { getStore } = await import('./store')
    seed(getStore(), [
      { id: 'old', reason: 'crash', at: NOW - 10_000 },
      { id: 'new', reason: 'crash', at: NOW - 1_000 }
    ])
    const sent: string[] = []
    const notices: string[] = []
    coordinator(sent, notices).restore()
    expect(sent).toEqual([`new:${SHUTDOWN_CONTINUATION}`])
    expect(notices.some((text) => text.startsWith('old:Wooi stopped unexpectedly'))).toBe(true)
  })

  it('놓친 rate-limit 재개와 crash 재개가 실행당 하나의 예산을 공유한다', async () => {
    const { getStore } = await import('./store')
    seed(getStore(), [{ id: 'crash', reason: 'crash' }])
    getStore().update((draft) => {
      draft.workspaces.push({
        ...draft.workspaces[0],
        id: 'rate',
        sessionId: 'sess-rate',
        pendingShutdownResume: null,
        pendingRateLimitResume: {
          backend: 'claude',
          sessionId: 'sess-rate',
          detectedAt: NOW - 60_000,
          retryAt: NOW - 1_000,
          attempt: 0
        }
      })
    })
    const rateSent = vi.fn()
    new RateLimitResumeCoordinator({
      backend: 'claude',
      refreshLimits: async () => {},
      sendContinuation: rateSent,
      emitItem: () => {},
      broadcastState: () => {}
    }).restore()
    const crashSent: string[] = []
    coordinator(crashSent, []).restore()
    await vi.advanceTimersByTimeAsync(1)
    expect(rateSent).toHaveBeenCalledTimes(1)
    expect(crashSent).toEqual([])
  })

  it('24시간 유예를 지난 기록은 안내 후 버리고 보내지 않는다', async () => {
    const { getStore } = await import('./store')
    seed(getStore(), [{ id: 'stale', reason: 'quit', at: NOW - SHUTDOWN_RESUME_GRACE_MS - 1 }])
    const sent: string[] = []
    const notices: string[] = []
    coordinator(sent, notices).restore()
    expect(sent).toEqual([])
    expect(notices[0]).toContain('too much time has passed')
  })

  it('sessionId가 바뀌었으면 조용히 취소한다', async () => {
    const { getStore } = await import('./store')
    seed(getStore(), [{ id: 'changed', reason: 'quit', sessionId: 'replacement' }])
    const sent: string[] = []
    const notices: string[] = []
    coordinator(sent, notices).restore()
    expect(sent).toEqual([])
    expect(notices).toEqual([])
  })

  it('설정이 꺼져 있으면 기록만 지우고 아무것도 보내지 않는다', async () => {
    const { getStore } = await import('./store')
    seed(getStore(), [{ id: 'off', reason: 'quit' }])
    getStore().update((draft) => {
      draft.settings.resumeUnfinishedTurnsOnLaunch = false
    })
    const sent: string[] = []
    coordinator(sent, []).restore()
    expect(sent).toEqual([])
    expect(getStore().getState().workspaces[0].pendingShutdownResume).toBeNull()
  })
})
