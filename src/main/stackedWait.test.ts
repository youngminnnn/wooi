import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { AppState, PermissionRequest, Workspace } from '@shared/types'
import { pendingPermissions } from './remote/permissions'
import { StackedWaitCoordinator, timeoutMinutes } from './stackedWait'

const NOW = Date.parse('2026-08-22T00:00:00Z')
let userData = ''

vi.mock('electron', () => ({ app: { getPath: (): string => userData } }))
vi.mock('./transcripts', () => ({ getTranscripts: () => ({ upsert: () => {} }) }))

beforeAll(() => {
  userData = mkdtempSync(join(tmpdir(), 'wooi-stacked-wait-test-'))
})
afterAll(() => rmSync(userData, { recursive: true, force: true }))

function workspace(id: string, patch: Partial<Workspace> = {}): Workspace {
  return {
    id,
    repoId: 'repo',
    agentBackend: 'claude',
    name: id,
    displayName: null,
    branch: `feat/${id}`,
    baseBranch: 'main',
    parentWorkspaceId: id === 'parent' ? null : 'parent',
    createdByWorkspaceId: id === 'parent' ? null : 'parent',
    worktreePath: `/tmp/${id}`,
    status: id === 'parent' ? 'idle' : 'running',
    sessionId: 'session-1',
    archived: false,
    pendingRateLimitResume: null,
    rateLimited: null,
    awaitingStackedWork: null,
    ...patch
  } as Workspace
}

describe('timeoutMinutes', () => {
  it('생략하면 60분이다', () => {
    expect(timeoutMinutes()).toBe(60)
  })

  it('범위를 벗어난 값을 가둔다', () => {
    expect(timeoutMinutes(0)).toBe(1)
    expect(timeoutMinutes(-5)).toBe(1)
    expect(timeoutMinutes(99_999)).toBe(1440)
  })

  // 스키마 검증은 Claude 경로에만 붙어 있어 Codex shim 으로는 아무 숫자나 들어온다. NaN 이
  // 통과하면 deadlineAt 이 NaN 이 되어 타임아웃이 영영 오지 않는다 — 무한 대기 금지가 깨진다.
  it('NaN·Infinity 를 기본값으로 되돌린다', () => {
    expect(timeoutMinutes(Number.NaN)).toBe(60)
    expect(timeoutMinutes(Number.POSITIVE_INFINITY)).toBe(60)
  })
})

describe('StackedWaitCoordinator', () => {
  let sent: Mock<(workspaceId: string, text: string) => void>
  let coordinator: StackedWaitCoordinator

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const { getStore } = await import('./store')
    getStore().update((state: AppState) => {
      state.workspaces = [workspace('parent'), workspace('one'), workspace('two')]
    })
    sent = vi.fn<(workspaceId: string, text: string) => void>()
    coordinator = new StackedWaitCoordinator({
      sendMessage: sent,
      postToTranscript: vi.fn(),
      broadcastState: vi.fn()
    })
  })

  afterEach(() => {
    coordinator.cancelAll()
    pendingPermissions.clear()
    vi.useRealTimers()
  })

  async function store() {
    return (await import('./store')).getStore()
  }

  async function report(id: string, at = Date.now()): Promise<void> {
    ;(await store()).update((state) => {
      const child = state.workspaces.find((item) => item.id === id)!
      child.status = 'idle'
      child.handoff = { status: 'done', summary: `${id} done`, at }
    })
  }

  it('조건 미충족 시 깨우지 않는다', async () => {
    coordinator.register('parent', {})
    await report('one')
    coordinator.poke('parent')
    expect(sent).not.toHaveBeenCalled()
  })

  it('조건 충족 시 정확히 한 번 깨운다', async () => {
    coordinator.register('parent', {})
    await report('one')
    await report('two')
    coordinator.poke('parent')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(sent).toHaveBeenCalledTimes(1)
    expect((await store()).getState().workspaces[0].awaitingStackedWork).toBeNull()
  })

  it('타임아웃으로 빠져나온다', async () => {
    coordinator.register('parent', { timeoutMinutes: 1 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sent).toHaveBeenCalledTimes(1)
    expect(sent.mock.calls[0][1]).toContain('timed out')
    expect((await store()).getState().workspaces[0].awaitingStackedWork).toBeNull()
  })

  it('취소하면 깨우지 않는다', async () => {
    coordinator.register('parent', {})
    coordinator.cancel('parent')
    await report('one')
    await report('two')
    coordinator.poke('parent')
    expect(sent).not.toHaveBeenCalled()
  })

  it('부모가 running 이면 전달을 미룬다', async () => {
    coordinator.register('parent', {})
    await report('one')
    await report('two')
    ;(await store()).update((state) => {
      state.workspaces[0].status = 'running'
    })
    coordinator.poke('parent')
    expect(sent).not.toHaveBeenCalled()
    ;(await store()).update((state) => {
      state.workspaces[0].status = 'idle'
    })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(sent).toHaveBeenCalledTimes(1)
  })

  it('세션이 바뀌었으면 깨우지 않는다', async () => {
    coordinator.register('parent', {})
    await report('one')
    await report('two')
    ;(await store()).update((state) => {
      state.workspaces[0].sessionId = 'session-2'
    })
    coordinator.poke('parent')
    expect(sent).not.toHaveBeenCalled()
    expect((await store()).getState().workspaces[0].awaitingStackedWork).toBeNull()
  })

  it('남은 자식 모두가 유예 넘게 idle 이면 stalled 로 깨운다', async () => {
    ;(await store()).update((state) => {
      state.workspaces.slice(1).forEach((child) => (child.status = 'idle'))
    })
    coordinator.register('parent', {})
    await vi.advanceTimersByTimeAsync(105_000)
    expect(sent).toHaveBeenCalledTimes(1)
    expect(sent.mock.calls[0][1]).toContain('cannot make progress')
  })

  /**
   * 정지의 가장 흔한 이유가 승인 카드다. 승인 대기 중인 워크스페이스는 `status` 가 `running`
   * 이라, 진행 판정이 `running` 을 먼저 보면 "진행 가능" 으로 읽혀 이 길이 영영 열리지 않는다.
   * 그래서 판정을 describeWorkspaceActivity 에서 파생시켰다([[stackedProgress]]).
   */
  it('자식이 승인 카드에 걸려 있으면 status 가 running 이어도 stalled 로 깨운다', async () => {
    for (const id of ['one', 'two']) {
      pendingPermissions.add({
        requestId: `req-${id}`,
        workspaceId: id,
        toolName: 'Bash'
      } as PermissionRequest)
    }
    coordinator.register('parent', {})
    // 승인 대기의 유예는 5분이다 — 사람이 곧 승인할 수 있어 성급히 깨우면 낭비다.
    await vi.advanceTimersByTimeAsync(4 * 60_000)
    expect(sent).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(sent).toHaveBeenCalledTimes(1)
    expect(sent.mock.calls[0][1]).toContain('waiting for your approval')
  })

  it('유예 안의 idle 은 stalled 가 아니다', async () => {
    ;(await store()).update((state) => {
      state.workspaces.slice(1).forEach((child) => (child.status = 'idle'))
    })
    coordinator.register('parent', {})
    await vi.advanceTimersByTimeAsync(89_000)
    expect(sent).not.toHaveBeenCalled()
  })

  it('진행 가능한 자식이 하나라도 있으면 stalled 가 아니다', async () => {
    ;(await store()).update((state) => {
      state.workspaces.find((item) => item.id === 'one')!.status = 'idle'
    })
    coordinator.register('parent', {})
    await vi.advanceTimersByTimeAsync(120_000)
    expect(sent).not.toHaveBeenCalled()
  })

  it('재시작 뒤 저장된 예약을 복원한다', async () => {
    coordinator.register('parent', {})
    coordinator.cancelAll()
    ;(await store()).update((state) => {
      state.workspaces[0].awaitingStackedWork = {
        targets: [
          { workspaceId: 'one', seenReportAt: null },
          { workspaceId: 'two', seenReportAt: null }
        ],
        until: 'all-reported',
        startedAt: NOW,
        deadlineAt: NOW + 60 * 60_000,
        sessionId: 'session-1'
      }
    })
    coordinator.restore()
    await report('one')
    await report('two')
    coordinator.poke('parent')
    expect(sent).toHaveBeenCalledTimes(1)
  })

  it('연속 비생산적 대기 두 번 뒤 세 번째 등록을 거절한다', async () => {
    coordinator.register('parent', { timeoutMinutes: 1 })
    await vi.advanceTimersByTimeAsync(60_000)
    coordinator.register('parent', { timeoutMinutes: 1 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(() => coordinator.register('parent', {})).toThrow('nothing twice in a row')
  })

  it('등록 시 이미 조건이 충족됐으면 예약하지 않는다', async () => {
    await report('one')
    await report('two')
    const result = coordinator.register('parent', {})
    expect(result).toMatchObject({ waiting: false, satisfied: true })
    expect((await store()).getState().workspaces[0].awaitingStackedWork).toBeNull()
  })
})
