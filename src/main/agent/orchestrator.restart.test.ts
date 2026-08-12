import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { Workspace } from '@shared/types'

/**
 * "다음 전송에서 세션을 다시 연다" 는 예약의 규칙.
 *
 * 세션을 열 때 고정되는 것(위임 도구 목록)을 바꾼 쪽은 언젠가 세션을 다시 열어야 하는데, 그
 * 시점이 **지금이면 안 된다** — 바꾸는 쪽은 도는 턴 안에 있다. 그래서 시점을 "다음 전송 직전"
 * 하나로 못 박고, 그 앞뒤로 어긋나지 않는지를 여기서 지킨다.
 */

const state = vi.hoisted(() => ({ workspaces: [] as Partial<Workspace>[] }))
const backend = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  dispose: vi.fn(),
  disposeAll: vi.fn(),
  abortAll: vi.fn(),
  recycleAll: vi.fn(),
  meta: { id: 'claude', capabilities: {} }
}))

vi.mock('../store', () => ({ getStore: () => ({ getState: () => state }) }))
vi.mock('./registry', () => ({ createBackend: () => backend, backendAvailability: vi.fn() }))

const workspace: Partial<Workspace> = { id: 'ws-1', agentBackend: 'claude', status: 'idle' }

async function orchestrator(): Promise<{
  sendMessage: (id: string, text: string) => void
  restartBeforeNextMessage: (id: string) => void
  dispose: (id: string) => void
}> {
  const { AgentOrchestrator } = await import('./orchestrator')
  return new AgentOrchestrator(
    () => {},
    () => null
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  state.workspaces = [{ ...workspace }]
})

describe('restartBeforeNextMessage', () => {
  it('예약만으로는 세션을 끊지 않는다 — 도는 턴이 죽는다', async () => {
    const agents = await orchestrator()
    agents.restartBeforeNextMessage('ws-1')

    expect(backend.dispose).not.toHaveBeenCalled()
  })

  it('다음 전송 직전에 끊고, 그 전송이 새 세션을 연다', async () => {
    const agents = await orchestrator()
    agents.restartBeforeNextMessage('ws-1')
    agents.sendMessage('ws-1', 'go')

    expect(backend.dispose).toHaveBeenCalledWith('ws-1')
    // 끊는 것이 전송보다 앞서야 한다. 뒤면 옛 세션이 그 메시지를 받아 버린다.
    expect(backend.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      backend.sendMessage.mock.invocationCallOrder[0]
    )
    // 4번째 인자는 에이전트 교체 인수인계 프롬프트다. 예약이 없었으니 undefined 여야 한다 —
    // 여기서 값이 생기면 없던 인수인계가 메시지 앞에 얹힌다는 뜻이다([[agent/orchestrator]]).
    expect(backend.sendMessage).toHaveBeenCalledWith('ws-1', 'go', undefined, undefined)
  })

  it('한 번만 쓰인다 — 그다음 전송은 멀쩡한 세션을 끊지 않는다', async () => {
    const agents = await orchestrator()
    agents.restartBeforeNextMessage('ws-1')
    agents.sendMessage('ws-1', 'first')
    agents.sendMessage('ws-1', 'second')

    expect(backend.dispose).toHaveBeenCalledTimes(1)
  })

  it('다른 이유로 이미 끊겼으면 예약은 사라진다', async () => {
    const agents = await orchestrator()
    agents.restartBeforeNextMessage('ws-1')
    agents.dispose('ws-1')
    agents.sendMessage('ws-1', 'go')

    // dispose 한 번은 위에서 명시적으로 부른 것뿐이다.
    expect(backend.dispose).toHaveBeenCalledTimes(1)
  })

  it('예약이 없으면 전송이 세션을 끊지 않는다', async () => {
    const agents = await orchestrator()
    agents.sendMessage('ws-1', 'go')

    expect(backend.dispose).not.toHaveBeenCalled()
  })
})
