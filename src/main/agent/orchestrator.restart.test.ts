import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { Workspace } from '@shared/types'

/**
 * "세션을 다시 연다" 는 예약의 규칙 — **언제** 열고, 그 뒤를 **누가** 잇는가.
 *
 * 세션을 열 때 고정되는 것(위임 도구 목록)을 바꾼 쪽은 언젠가 세션을 다시 열어야 하는데, 그
 * 시점이 **지금이면 안 된다** — 바꾸는 쪽은 도는 턴 안에 있다. 그래서 시점은 둘 중 하나다:
 * 사용자의 다음 전송 직전(restartBeforeNextMessage), 또는 이 턴이 끝나는 즉시(resumeAfterTurn).
 * 뒤엣것은 Wooi 가 사용자를 대신해 한 턴을 더 보낸다 — 사용자가 시작하지 않은 턴이므로, 어떤
 * 개입이 그것을 취소하는지가 이 파일의 절반이다.
 */

const state = vi.hoisted(() => ({ workspaces: [] as Partial<Workspace>[] }))
const backend = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  dispose: vi.fn(),
  disposeAll: vi.fn(),
  abortAll: vi.fn(),
  recycleAll: vi.fn(),
  interrupt: vi.fn(),
  clearSession: vi.fn(),
  meta: { id: 'claude', capabilities: {} }
}))
type Hook = (workspaceId: string, status: 'idle' | 'error') => boolean

/** 오케스트레이터가 백엔드에 심어 둔 턴 종료 훅. 백엔드 대신 여기서 당긴다. */
const deps = vi.hoisted(() => ({ onTurnEnd: undefined as Hook | undefined }))

vi.mock('../store', () => ({
  getStore: () => ({ getState: () => state, update: (fn: (st: typeof state) => void) => fn(state) })
}))

/**
 * 이 턴을 기다리던 peer 묶음이 세션 교체 사이에 어떻게 다뤄지는지만 본다 — 묶음을 실제로 쌓는
 * 것은 [[agent/tools/peer]] 의 몫이고, 여기서 확인할 것은 **순서**다: dispose 보다 먼저 꺼내고,
 * 새 세션이 열린 뒤에 넣는다.
 */
const peer = vi.hoisted(() => {
  const handoff = { deliver: vi.fn(), park: vi.fn() }
  return { handoff, buffered: false }
})
vi.mock('./tools/peer', () => ({
  detachBufferedPeerMessages: vi.fn(() => (peer.buffered ? peer.handoff : null)),
  flushBufferedPeerMessages: vi.fn(() => false),
  forgetPeerSessionRules: vi.fn(),
  resetPeerSession: vi.fn(),
  resetAllPeerSessions: vi.fn()
}))
vi.mock('./registry', () => ({
  createBackend: (_id: string, d: { onTurnEnd: Hook }) => {
    deps.onTurnEnd = d.onTurnEnd
    return backend
  },
  backendAvailability: vi.fn()
}))

const workspace: Partial<Workspace> = { id: 'ws-1', agentBackend: 'claude', status: 'idle' }
const prompt = 'The teammate tools are loaded — carry on.'

interface Agents {
  sendMessage: (id: string, text: string) => void
  restartBeforeNextMessage: (id: string) => void
  resumeAfterTurn: (id: string, prompt: string) => void
  interrupt: (id: string) => Promise<void>
  clearSession: (id: string) => void
  dispose: (id: string) => void
  metaFor: (id: string) => unknown
}

async function orchestrator(): Promise<Agents> {
  const { AgentOrchestrator } = await import('./orchestrator')
  const agents = new AgentOrchestrator(
    () => {},
    () => null
  ) as unknown as Agents
  // 백엔드는 지연 생성이라 아직 훅이 심기지 않았다. 실제로 턴 종료를 알려 오는 것은 백엔드이므로
  // (그때는 반드시 존재한다) 여기서도 한 번 만들어 두고, 그 과정에서 남은 호출 기록은 지운다.
  agents.metaFor('ws-1')
  vi.clearAllMocks()
  return agents
}

/** 백엔드가 턴 종료를 알리는 자리. 훅이 아직 안 심겼으면 그것부터 실패로 잡는다. */
function endTurn(id = 'ws-1', status: 'idle' | 'error' = 'idle'): boolean {
  if (!deps.onTurnEnd) throw new Error('턴 종료 훅이 백엔드에 전달되지 않았다')
  return deps.onTurnEnd(id, status)
}

beforeEach(() => {
  vi.clearAllMocks()
  deps.onTurnEnd = undefined
  peer.buffered = false
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

  // 이쪽 예약은 사용자를 기다린다 — 턴이 끝났다고 Wooi 가 대신 말을 걸지는 않는다.
  it('턴이 끝나도 저절로 이어 가지는 않는다', async () => {
    const agents = await orchestrator()
    agents.restartBeforeNextMessage('ws-1')

    expect(endTurn()).toBe(false)
    expect(backend.sendMessage).not.toHaveBeenCalled()
  })
})

describe('resumeAfterTurn', () => {
  it('예약만으로는 세션을 끊지 않는다 — 예약하는 쪽은 도는 턴 안에 있다', async () => {
    const agents = await orchestrator()
    agents.resumeAfterTurn('ws-1', prompt)

    expect(backend.dispose).not.toHaveBeenCalled()
    expect(backend.sendMessage).not.toHaveBeenCalled()
  })

  it('턴이 끝나면 세션을 다시 열고 이어 보낸다', async () => {
    const agents = await orchestrator()
    agents.resumeAfterTurn('ws-1', prompt)

    expect(endTurn()).toBe(true)
    expect(backend.dispose).toHaveBeenCalledWith('ws-1')
    // silent — 화면에는 한 글자도 남지 않아야 한다([[agent/backend]] sendMessage).
    expect(backend.sendMessage).toHaveBeenCalledWith('ws-1', prompt, undefined, { silent: true })
    // 여기서도 끊는 것이 전송보다 앞서야 한다 — 뒤면 도구가 없는 옛 세션이 그 턴을 받는다.
    expect(backend.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      backend.sendMessage.mock.invocationCallOrder[0]
    )
  })

  /**
   * 이 파일에서 가장 중요한 한 줄. `true` 는 "이 턴 종료를 방송하지 말라" 는 뜻이고, 그래야 턴과
   * 턴 사이에 사용자가 쉬고 있다고 볼 틈이 생기지 않는다. `false` 를 돌리면 그 틈에 입력한 말이
   * 사용자가 시작하지도 않은 턴에 섞여 들어간다 — 한 번 겪고 되돌린 실패다([[shared/handoff]]).
   */
  it('이어 보냈으면 그 턴 종료는 방송되지 않는다(턴 사이에 틈이 없다)', async () => {
    const agents = await orchestrator()
    agents.resumeAfterTurn('ws-1', prompt)

    expect(endTurn()).toBe(true)
  })

  it('한 번만 이어 간다 — 그다음 턴이 끝날 때 되살아나지 않는다', async () => {
    const agents = await orchestrator()
    agents.resumeAfterTurn('ws-1', prompt)
    endTurn()
    backend.sendMessage.mockClear()

    expect(endTurn()).toBe(false)
    expect(backend.sendMessage).not.toHaveBeenCalled()
  })

  it('예약이 없으면 턴 종료는 그냥 지나간다', async () => {
    await orchestrator()

    expect(endTurn()).toBe(false)
    expect(backend.sendMessage).not.toHaveBeenCalled()
  })

  it('오류로 끝난 턴은 이어 가지 않고, 예약도 남기지 않는다', async () => {
    const agents = await orchestrator()
    agents.resumeAfterTurn('ws-1', prompt)

    expect(endTurn('ws-1', 'error')).toBe(false)
    expect(backend.sendMessage).not.toHaveBeenCalled()
    // 예약이 남아 있었다면 한참 뒤 다른 턴이 끝날 때 뜬금없이 되살아난다.
    expect(endTurn('ws-1', 'idle')).toBe(false)
  })

  /**
   * 회귀: 이 턴이 끝나기를 기다리던 peer 묶음은 dispose 가 승인 대기로 되돌려 버렸다. 발신자는
   * 이미 "현재 턴이 끝나면 전달된다" 는 답을 받아 간 뒤라, 사용자가 카드를 승인하지 않으면
   * 그 메시지는 영영 모델에 닿지 않았다 — 곧바로 새 턴이 열리는 자리인데도.
   */
  it('대기 중이던 peer 묶음을 새 세션으로 넘긴다', async () => {
    peer.buffered = true
    const agents = await orchestrator()
    agents.resumeAfterTurn('ws-1', prompt)

    expect(endTurn()).toBe(true)
    expect(peer.handoff.deliver).toHaveBeenCalledTimes(1)
    expect(peer.handoff.park).not.toHaveBeenCalled()
    // 새 세션이 열린 뒤여야 한다 — 앞이면 끊길 옛 세션이 그것을 받는다.
    expect(backend.sendMessage.mock.invocationCallOrder[0]).toBeLessThan(
      peer.handoff.deliver.mock.invocationCallOrder[0]
    )
  })

  it('이어 보내지 못하면 그 묶음은 승인 대기로 되돌린다 — 조용히 사라지지 않게', async () => {
    peer.buffered = true
    const agents = await orchestrator()
    backend.sendMessage.mockImplementationOnce(() => {
      throw new Error('host is gone')
    })
    agents.resumeAfterTurn('ws-1', prompt)

    expect(endTurn()).toBe(false)
    expect(peer.handoff.park).toHaveBeenCalledTimes(1)
    expect(peer.handoff.deliver).not.toHaveBeenCalled()
  })

  it('보내지 못하면 턴 종료를 넘겨준다 — 사이드바가 진행 중에 갇히지 않게', async () => {
    const agents = await orchestrator()
    backend.sendMessage.mockImplementationOnce(() => {
      throw new Error('host is gone')
    })
    agents.resumeAfterTurn('ws-1', prompt)

    expect(endTurn()).toBe(false)
  })

  // 재시작 예약은 남는다 — 세션이 낡았다는 사실은 개입과 무관하다.
  it('사용자가 먼저 말을 걸면 자동 이어가기는 접히고, 재시작은 그 전송이 처리한다', async () => {
    const agents = await orchestrator()
    agents.resumeAfterTurn('ws-1', prompt)
    agents.sendMessage('ws-1', 'actually do this instead')

    expect(backend.dispose).toHaveBeenCalledTimes(1)
    expect(backend.sendMessage).toHaveBeenCalledTimes(1)
    expect(endTurn()).toBe(false)
    expect(backend.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('중단하면 이어 가지 않는다 — 중단이 중단이 아니게 된다', async () => {
    const agents = await orchestrator()
    agents.resumeAfterTurn('ws-1', prompt)
    void agents.interrupt('ws-1')

    expect(endTurn()).toBe(false)
    expect(backend.sendMessage).not.toHaveBeenCalled()
  })

  it('/clear 로 대화를 비우면 이어 가지 않는다 — 이어갈 대화가 없다', async () => {
    const agents = await orchestrator()
    agents.resumeAfterTurn('ws-1', prompt)
    agents.clearSession('ws-1')

    expect(endTurn()).toBe(false)
    expect(backend.sendMessage).not.toHaveBeenCalled()
  })

  it('세션이 다른 이유로 끊기면 이어 가지 않는다', async () => {
    const agents = await orchestrator()
    agents.resumeAfterTurn('ws-1', prompt)
    agents.dispose('ws-1')
    backend.sendMessage.mockClear()

    expect(endTurn()).toBe(false)
    expect(backend.sendMessage).not.toHaveBeenCalled()
  })

  // 겹치는 경우: 팀으로 바꾼 턴이 끝나기 전에 사용자가 헤더 배지로 다시 Solo 로 돌린다.
  // 그대로 이어 가면 "팀원 도구가 실렸다" 는 거짓말로 시작하는 턴이 된다.
  it('그냥 재시작이 다시 예약되면 자동 이어가기는 접힌다', async () => {
    const agents = await orchestrator()
    agents.resumeAfterTurn('ws-1', prompt)
    agents.restartBeforeNextMessage('ws-1')

    expect(endTurn()).toBe(false)
    expect(backend.sendMessage).not.toHaveBeenCalled()
    // 재시작 자체는 살아 있어야 한다 — 세션이 낡았다는 사실은 그대로다.
    agents.sendMessage('ws-1', 'go')
    expect(backend.dispose).toHaveBeenCalledWith('ws-1')
  })

  it('다른 워크스페이스의 턴이 끝난 것으로는 발동하지 않는다', async () => {
    const agents = await orchestrator()
    agents.resumeAfterTurn('ws-1', prompt)

    expect(endTurn('ws-2')).toBe(false)
    expect(backend.sendMessage).not.toHaveBeenCalled()
  })
})
