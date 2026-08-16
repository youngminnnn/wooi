import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  initRegistry,
  registerAgentTool,
  registerExternalAgentTool,
  resetAgentToolsForTest,
  runAgentTool,
  runExternalAgentTool,
  type AgentToolDeps
} from './registry'

/**
 * 도구 실행부는 에이전트가 앱을 조작하는 유일한 통로다. 여기서 지켜야 할 것은 두 가지다 —
 * 모르는 이름이 조용히 통과하지 않을 것, 그리고 workspaceId 가 호출 맥락에서 그대로 올 것
 * (인자로 받으면 모델이 남의 워크스페이스를 지목할 수 있다).
 */

const deps = { scripts: {}, broadcastState: vi.fn() } as unknown as AgentToolDeps

beforeEach(() => {
  resetAgentToolsForTest()
})

describe('runAgentTool', () => {
  it('등록된 도구에 workspaceId 와 인자를 그대로 넘긴다', async () => {
    initRegistry(deps)
    const handler = vi.fn().mockResolvedValue({ ok: true })
    registerAgentTool('demo', handler)

    const result = await runAgentTool('ws-1', 'demo', { name: 'feat/x' })

    expect(result).toEqual({ ok: true })
    expect(handler).toHaveBeenCalledWith(deps, 'ws-1', { name: 'feat/x' })
  })

  it('인자가 없으면 빈 객체로 넘긴다(핸들러가 undefined 를 방어하지 않아도 되게)', async () => {
    initRegistry(deps)
    const handler = vi.fn().mockResolvedValue(null)
    registerAgentTool('demo', handler)

    await runAgentTool('ws-1', 'demo', undefined)

    expect(handler).toHaveBeenCalledWith(deps, 'ws-1', {})
  })

  it('모르는 도구는 던진다 — 조용히 성공하면 모델이 됐다고 믿는다', async () => {
    initRegistry(deps)
    await expect(runAgentTool('ws-1', 'nope', {})).rejects.toThrow(/Unknown Wooi tool/)
  })

  it('주입 전에는 던진다(부팅 순서가 어긋난 것을 숨기지 않는다)', async () => {
    registerAgentTool('demo', vi.fn())
    await expect(runAgentTool('ws-1', 'demo', {})).rejects.toThrow(/not ready/)
  })

  it('핸들러가 던진 오류를 그대로 올린다 — 호출부가 도구 오류로 바꿔 모델에게 준다', async () => {
    initRegistry(deps)
    registerAgentTool('demo', vi.fn().mockRejectedValue(new Error('commit first')))
    await expect(runAgentTool('ws-1', 'demo', {})).rejects.toThrow('commit first')
  })
})

describe('registerAgentTool', () => {
  it('같은 이름을 두 번 등록하면 던진다', () => {
    registerAgentTool('demo', vi.fn())
    expect(() => registerAgentTool('demo', vi.fn())).toThrow(/twice/)
  })
})

describe('runExternalAgentTool', () => {
  it('외부 전용으로 등록한 도구만 실행한다', async () => {
    initRegistry(deps)
    registerAgentTool('create_workspace', vi.fn().mockResolvedValue(null))
    registerExternalAgentTool('list_workspace_peers', vi.fn().mockResolvedValue({ peers: [] }))

    await expect(runExternalAgentTool('list_workspace_peers', {})).resolves.toEqual({ peers: [] })
    await expect(runExternalAgentTool('create_workspace', {})).rejects.toThrow(
      /not available to external callers/
    )
  })
})
