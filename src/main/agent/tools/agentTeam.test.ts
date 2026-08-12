import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../storeSchema'
import { AGENT_BACKEND_IDS, type AppSettings, type Workspace } from '@shared/types'
import { delegateToolName } from './catalog'
import type { AgentToolDeps } from './registry'

/**
 * Solo → 팀 전환에서 지켜야 할 것들.
 *
 * 이 도구의 값은 플래그를 바꾸는 데 있지 않다 — 그건 한 줄이다. **바꾼 것이 실제로 세션에
 * 닿는가**가 전부다. 위임 도구는 세션을 열 때 박히므로, 재시작 예약을 빠뜨리면 "팀으로 바꿨다"
 * 고 답해 놓고 위임 도구는 영영 생기지 않는, 모델도 사용자도 원인을 못 찾는 상태가 된다.
 *
 * 그다음이 **언제 닿는가**다. 사용자의 다음 메시지를 기다리면, 사용자가 방금 시킨 일이 시작도
 * 못 한 채 턴 하나가 지나간다. 그래서 예약은 턴이 끝나는 즉시 이어 가는 쪽이어야 하고, 도구가
 * 모델에게 하는 말도 그것과 같아야 한다 — 한쪽만 고치면 배관은 이어 보내는데 모델은 기다린다.
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

const resumeAfterTurn = vi.fn()
const restartBeforeNextMessage = vi.fn()
const broadcastState = vi.fn()
const deps = {
  sessions: { dispose: vi.fn(), restartBeforeNextMessage, resumeAfterTurn },
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
  state.settings = { ...DEFAULT_SETTINGS }
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
  it('턴이 끝나는 즉시 세션을 다시 열고 이어 가도록 예약한다', async () => {
    await switch_()

    expect(resumeAfterTurn).toHaveBeenCalledWith('ws-1', expect.anything())
    // 사용자의 다음 메시지를 기다리는 예약은 쓰지 않는다 — 그게 없애려는 마찰 그 자체다.
    expect(restartBeforeNextMessage).not.toHaveBeenCalled()
  })

  it('이어 갈 때 모델에게 그 턴을 누가 시작했는지 밝힌다', async () => {
    await switch_()

    const [, prompt] = resumeAfterTurn.mock.calls[0]
    // 밝히지 않으면 모델은 사용자가 다시 말을 건 줄 알고 "무엇을 도와드릴까요" 로 답한다.
    expect(prompt).toMatch(/Wooi started this turn, not the user/)
    // 화면에 남지 않는 말이라는 것도 알려 준다 — 모르면 "말씀하신 대로" 하고 없는 말을 가리킨다.
    expect(prompt).toMatch(/not shown to the user/)
  })

  it('지금 도는 세션은 끊지 않는다 — 이 호출의 결과가 돌아갈 세션이다', async () => {
    await switch_()
    expect(deps.sessions.dispose).not.toHaveBeenCalled()
  })

  it('생긴 도구 이름과, 다음 턴이 저절로 시작된다는 사실을 알려 준다', async () => {
    const result = await switch_()

    expect(result.teammateTools).toEqual(AGENT_BACKEND_IDS.map(delegateToolName))
    // 배관이 이어 보내는데 모델이 대답을 기다리면 마찰은 그대로다. 기다리라고 시키지 않는지까지 본다.
    expect(String(result.next)).toMatch(/continues on its own/)
    expect(String(result.next)).toMatch(/Do not ask the user to reply/)
  })

  // 원하던 상태가 이미 참인 것은 실패가 아니다. 다만 켜진 채로 열린 세션에는 도구가 이미
  // 있으므로, 여기서 재시작을 걸면 값 없이 대화만 끊는다.
  it('이미 팀이면 아무것도 하지 않는다', async () => {
    state.workspaces = [{ ...solo, multiAgent: true }]

    await expect(switch_()).resolves.toMatchObject({ alreadyOn: true })
    expect(resumeAfterTurn).not.toHaveBeenCalled()
    expect(restartBeforeNextMessage).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('사라진 워크스페이스면 던진다', async () => {
    state.workspaces = []
    await expect(switch_()).rejects.toThrow(/no longer exists/)
  })
})
