import { describe, expect, it } from 'vitest'
import type { Workspace } from '@shared/types'
import { stackedChildProgress } from './stackedProgress'

const NOW = Date.parse('2026-08-22T00:00:00Z')

function child(patch: Partial<Workspace> = {}): Workspace {
  return {
    id: 'child',
    status: 'idle',
    archived: false,
    pendingRateLimitResume: null,
    rateLimited: null,
    ...patch
  } as Workspace
}

describe('stackedChildProgress', () => {
  it.each([
    ['archived', child({ archived: true }), false, false],
    ['running', child({ status: 'running' }), false, true],
    [
      'resuming',
      child({
        pendingRateLimitResume: {
          backend: 'claude',
          sessionId: 's',
          detectedAt: NOW,
          retryAt: NOW + 1,
          attempt: 0
        }
      }),
      false,
      true
    ],
    [
      'rate-limited',
      child({ rateLimited: { backend: 'claude', detectedAt: NOW, resetsAt: NOW + 60_000 } }),
      false,
      false
    ],
    ['awaiting-approval', child(), true, false],
    ['error', child({ status: 'error' }), false, false],
    ['idle', child(), false, false]
  ] as const)(
    '%s 판정을 표의 우선순위대로 돌려준다',
    (reason, workspace, approval, canProgress) => {
      expect(stackedChildProgress(workspace, approval, NOW)).toEqual({ reason, canProgress })
    }
  )
})
