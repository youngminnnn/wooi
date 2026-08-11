import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../storeSchema'
import type { AppSettings, Workspace } from '@shared/types'
import type { AgentToolDeps } from './registry'

/**
 * Solo → 팀 전환에서 지켜야 할 것들.
 *
 * 이 도구의 값은 플래그를 바꾸는 데 있지 않다 — 그건 한 줄이다. **바꾼 것이 실제로 세션에
 * 닿는가**가 전부다. 위임 도구는 세션을 열 때 박히므로, 재시작 예약을 빠뜨리면 "팀으로 바꿨다"
 * 고 답해 놓고 위임 도구는 영영 생기지 않는, 모델도 사용자도 원인을 못 찾는 상태가 된다.
 */

const state = vi.hoisted(() => ({
  workspaces: [] as Partial<Workspace>[],
  settings: {} as AppSettings
}))
const update = vi.hoisted(() =>
  vi.fn((fn: (st: typeof state) => void) => {
    fn(state)
  })
)

vi.mock('../../store', () => ({ getStore: () => ({ getState: () => state, update }) }))

const restartBeforeNextMessage = vi.fn()
const broadcastState = vi.fn()
const deps = {
  sessions: { dispose: vi.fn(), restartBeforeNextMessage },
  broadcastState
} as unknown as AgentToolDeps

const solo: Partial<Workspace> = {
  id: 'ws-1',
  name: 'base',
  displayName: null,
  agentBackend: 'claude',
  multiAgent: false
}

beforeEach(() => {
  vi.clearAllMocks()
  state.workspaces = [{ ...solo }]
  state.settings = { ...DEFAULT_SETTINGS, experiments: { multiAgent: true } }
})

async function switch_(from = 'ws-1'): Promise<Record<string, unknown>> {
  const { switchToAgentTeam } = await import('./agentTeam')
  return switchToAgentTeam(deps, from, { reason: 'Codex should review this.' }) as Promise<
    Record<string, unknown>
  >
}

describe('switch_to_agent_team', () => {
  it('워크스페이스를 팀으로 바꾸고 화면에 반영한다', async () => {
    await expect(switch_()).resolves.toMatchObject({ mode: 'team' })

    expect(state.workspaces[0].multiAgent).toBe(true)
    expect(broadcastState).toHaveBeenCalled()
  })

  // 이 도구의 존재 이유. 예약이 없으면 플래그만 참이고 세션에는 위임 도구가 없다.
  it('다음 전송에서 세션을 다시 열도록 예약한다', async () => {
    await switch_()
    expect(restartBeforeNextMessage).toHaveBeenCalledWith('ws-1')
  })

  it('지금 도는 세션은 끊지 않는다 — 이 호출의 결과가 돌아갈 세션이다', async () => {
    await switch_()
    expect(deps.sessions.dispose).not.toHaveBeenCalled()
  })

  it('생긴 도구 이름과, 그것이 다음 턴부터라는 사실을 알려 준다', async () => {
    const result = await switch_()

    expect(result.teammateTools).toEqual(['claude_subagent', 'codex_subagent'])
    expect(String(result.next)).toMatch(/next message/)
  })

  // 원하던 상태가 이미 참인 것은 실패가 아니다. 다만 켜진 채로 열린 세션에는 도구가 이미
  // 있으므로, 여기서 재시작을 걸면 값 없이 대화만 끊는다.
  it('이미 팀이면 아무것도 하지 않는다', async () => {
    state.workspaces = [{ ...solo, multiAgent: true }]

    await expect(switch_()).resolves.toMatchObject({ alreadyOn: true })
    expect(restartBeforeNextMessage).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  // 켤 수 없는 조건에서 켜 주면 "팀인데 팀원이 없는" 상태가 된다 — 모델은 도구를 찾다가
  // 턴을 버리고, 사용자는 배지만 바뀐 것을 본다. 조건은 delegateBackendsFor 와 같은 것을 본다.
  it('실험 기능이 꺼져 있으면 켜지 않고 이유를 말한다', async () => {
    state.settings = { ...DEFAULT_SETTINGS, experiments: { multiAgent: false } }

    await expect(switch_()).rejects.toThrow(/Experiments/)
    expect(state.workspaces[0].multiAgent).toBe(false)
    expect(restartBeforeNextMessage).not.toHaveBeenCalled()
  })

  it('사라진 워크스페이스면 던진다', async () => {
    state.workspaces = []
    await expect(switch_()).rejects.toThrow(/no longer exists/)
  })
})
