import type * as acp from '@agentclientprotocol/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent, ChatItem, PermissionDecision, PermissionRequest } from '@shared/types'
import { CopilotSession, type CopilotHost, type CopilotSessionConfig } from './session'
import { COPILOT_SESSION_MODES } from './acp'

/**
 * 세션이 지켜야 하는 것 중 **실측이 없으면 틀리게 짰을** 것들을 고정한다.
 *
 * 가장 중요한 것은 steering 이다 — 턴이 도는 중에 보낸 두 번째 `session/prompt` 는 7ms 만에
 * `end_turn` 을 돌려주면서 실제 작업은 계속 돈다. 그 응답을 턴의 끝으로 읽으면 대화가 유휴로
 * 보이고 완료 알림까지 뜬다.
 */

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: unknown) => void
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const CONFIG: CopilotSessionConfig = {
  cwd: '/tmp/ws',
  permissionMode: 'default',
  resumeSessionId: null,
  extraDirs: []
}

function harness(overrides: Partial<CopilotSessionConfig> = {}) {
  const events: ChatEvent[] = []
  const persisted: ChatItem[] = []
  const permissions: PermissionRequest[] = []
  let answerPermission: (request: PermissionRequest) => Promise<PermissionDecision> = async () => ({
    behavior: 'allow'
  })

  const host: CopilotHost = {
    emit: (_ws, event) => void events.push(event),
    persist: (_ws, item) => void persisted.push(item),
    noteSessionId: vi.fn(),
    askPermission: (request) => {
      permissions.push(request)
      return answerPermission(request)
    },
    onDisconnect: vi.fn()
  }

  /** 진행 중인 `session/prompt` 들. 테스트가 원하는 시점에 하나씩 끝낸다. */
  const prompts: { text: string; deferred: Deferred<{ stopReason: string }> }[] = []
  const calls: { method: string; params: Record<string, unknown> }[] = []
  let loadFails = false

  const ctx = {
    request: (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'session/new') return Promise.resolve({ sessionId: 'acp-1' })
      if (method === 'session/load') {
        return loadFails ? Promise.reject(new Error('no such session')) : Promise.resolve({})
      }
      if (method === 'session/prompt') {
        const text = (params.prompt as { text: string }[])[0]?.text ?? ''
        const deferred = defer<{ stopReason: string }>()
        prompts.push({ text, deferred })
        return deferred.promise
      }
      return Promise.resolve({})
    },
    notify: () => {
      calls.push({ method: 'session/cancel', params: {} })
      return Promise.resolve()
    }
  } as unknown as acp.ClientContext

  const session = new CopilotSession('ws-1', host, {
    ctx: () => Promise.resolve(ctx),
    route: vi.fn(),
    unroute: vi.fn()
  })
  session.configure({ ...CONFIG, ...overrides })

  return {
    session,
    events,
    persisted,
    permissions,
    prompts,
    calls,
    failLoad: () => (loadFails = true),
    setPermissionAnswer: (fn: typeof answerPermission) => (answerPermission = fn),
    statuses: () => events.filter((e) => e.type === 'status').map((e) => e.status)
  }
}

/** 마이크로태스크가 다 돌 때까지 — 세션 열기는 몇 단계의 await 를 거친다. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('턴 소유권', () => {
  it('turn 이 돌고 있으면 두 번째 메시지는 steering 이고 그 응답으로 턴을 끝내지 않는다', async () => {
    const h = harness()

    void h.session.prompt('count to 40')
    await settle()
    expect(h.statuses()).toEqual(['running'])
    expect(h.prompts).toHaveLength(1)

    // 도는 중에 밀어 넣는다.
    void h.session.prompt('also say BANANA')
    await settle()
    expect(h.prompts).toHaveLength(2)
    // 상태 이벤트가 하나 더 늘지 않는다 — running 하나뿐이어야 한다.
    expect(h.statuses()).toEqual(['running'])

    // 실측대로 steering prompt 가 **먼저** end_turn 으로 끝난다. 그래도 턴은 계속이다.
    h.prompts[1].deferred.resolve({ stopReason: 'end_turn' })
    await settle()
    expect(h.statuses()).toEqual(['running'])
    expect(h.session.running).toBe(true)

    // 처음 시작한 prompt 가 끝나야 비로소 턴이 끝난다.
    h.prompts[0].deferred.resolve({ stopReason: 'end_turn' })
    await settle()
    expect(h.statuses()).toEqual(['running', 'idle'])
    expect(h.session.running).toBe(false)
  })

  it('턴이 실패하면 오류 카드를 남기고 error 로 끝난다', async () => {
    const h = harness()
    void h.session.prompt('hi')
    await settle()
    h.prompts[0].deferred.reject(new Error('boom'))
    await settle()

    expect(h.statuses()).toEqual(['running', 'error'])
    expect(h.persisted.some((i) => i.type === 'error')).toBe(true)
  })

  // `session/cancel` 뒤 prompt 는 `cancelled` 가 아니라 end_turn 으로 resolve 된다(실측).
  // 사용자가 끊은 것은 실패가 아니므로 오류 카드를 남기면 안 된다.
  it('취소는 오류가 아니다', async () => {
    const h = harness()
    void h.session.prompt('count to 200')
    await settle()

    await h.session.cancel()
    h.prompts[0].deferred.reject(new Error('aborted'))
    await settle()

    expect(h.calls.some((c) => c.method === 'session/cancel')).toBe(true)
    expect(h.statuses()).toEqual(['running', 'idle'])
    expect(h.persisted.some((i) => i.type === 'error')).toBe(false)
  })
})

describe('세션 열기', () => {
  it('권한 모드는 mode 를 먼저, allow_all 을 나중에 보낸다', async () => {
    const h = harness({ permissionMode: 'fullAccess' })
    void h.session.prompt('hi')
    await settle()

    const modeAt = h.calls.findIndex((c) => c.method === 'session/set_mode')
    const allowAt = h.calls.findIndex((c) => c.method === 'session/set_config_option')
    // plan 으로 바꾸면 Copilot 이 allow_all 을 강제로 off 로 되돌린다(실측). 순서가 뒤집히면
    // 우리가 정한 조합이 조용히 사라진다.
    expect(modeAt).toBeGreaterThanOrEqual(0)
    expect(allowAt).toBeGreaterThan(modeAt)
    expect(h.calls[modeAt].params.modeId).toBe(COPILOT_SESSION_MODES.agent)
    expect(h.calls[allowAt].params).toMatchObject({ configId: 'allow_all', value: 'on' })
  })

  it('resume 이 있으면 session/load 로 이어 붙인다', async () => {
    const h = harness({ resumeSessionId: 'old-session' })
    void h.session.prompt('hi')
    await settle()

    expect(h.calls[0]).toMatchObject({ method: 'session/load' })
    expect(h.calls.some((c) => c.method === 'session/new')).toBe(false)
  })

  it('load 가 실패하면 새 세션으로 이어 가고 사용자에게 알린다', async () => {
    const h = harness({ resumeSessionId: 'gone' })
    h.failLoad()
    void h.session.prompt('hi')
    await settle()

    expect(h.calls.some((c) => c.method === 'session/new')).toBe(true)
    expect(h.persisted.some((i) => i.type === 'system')).toBe(true)
    // 대화가 죽지는 않는다 — 턴은 정상적으로 시작된다.
    expect(h.statuses()).toEqual(['running'])
  })

  it('세션은 한 번만 연다 — 겹쳐 들어온 메시지가 session/new 를 두 번 부르지 않는다', async () => {
    const h = harness()
    void h.session.prompt('one')
    void h.session.prompt('two')
    await settle()

    expect(h.calls.filter((c) => c.method === 'session/new')).toHaveLength(1)
  })
})

describe('슬래시 명령 패널', () => {
  // 실측: 도는 턴에 슬래시 명령을 밀어 넣으면 그 턴이 취소된다("Operation cancelled by user").
  // 패널 하나 보여 주자고 사용자의 작업을 죽일 수는 없다.
  it('턴이 도는 중에는 거절한다', async () => {
    const h = harness()
    void h.session.prompt('long task')
    await settle()

    await expect(h.session.runCommand('usage')).rejects.toThrow(/working/i)
  })

  it('명령의 답은 대화에 남기지 않고 패널로만 간다', async () => {
    const h = harness()
    const result = h.session.runCommand('usage')
    await settle()

    const usagePrompt = h.prompts.find((p) => p.text === '/usage')
    expect(usagePrompt).toBeDefined()
    h.session.handleUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'text',
        text: 'Session Usage\n\nChanges: +2 -1\nRequests: 0.1 AI Units (3s)'
      }
    } as never)
    usagePrompt!.deferred.resolve({ stopReason: 'end_turn' })

    expect(await result).toMatchObject({
      kind: 'usage',
      usage: { linesAdded: 2, linesRemoved: 1, costLabel: '0.1 AI Units' }
    })
    // 대화에는 한 글자도 남지 않는다.
    expect(h.persisted).toHaveLength(0)
    expect(h.events.some((e) => e.type === 'delta')).toBe(false)
  })

  it('첫 메시지 전의 /context 는 빈 막대 대신 사람이 읽는 오류로 끊는다', async () => {
    const h = harness()
    const result = h.session.runCommand('context')
    await settle()

    const prompt = h.prompts.find((p) => p.text === '/context')!
    h.session.handleUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Context information is not yet available.' }
    } as never)
    prompt.deferred.resolve({ stopReason: 'end_turn' })

    await expect(result).rejects.toThrow(/send a message first/i)
  })
})

describe('승인', () => {
  const editPermission = {
    sessionId: 'acp-1',
    toolCall: { toolCallId: 't1', kind: 'edit', status: 'pending', title: 'Edit file' },
    options: [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' }
    ]
  } as acp.RequestPermissionRequest

  it('사용자가 고른 optionId 를 그대로 되돌린다', async () => {
    const h = harness()
    h.setPermissionAnswer(async () => ({ behavior: 'allow', optionId: 'allow_once' }))
    expect(await h.session.handlePermission(editPermission)).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow_once' }
    })
  })

  it('거절하면 reject 옵션을 고른다', async () => {
    const h = harness()
    h.setPermissionAnswer(async () => ({ behavior: 'deny' }))
    expect(await h.session.handlePermission(editPermission)).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject_once' }
    })
  })

  // plan 의 마지막 방어선. 실측상 plan 에서는 요청 자체가 오지 않지만, ACP 에는 OS 샌드박스라는
  // 두 번째 방어선이 없어 Copilot 의 plan 구현이 바뀌면 여기가 전부다.
  it('plan 모드에서는 읽기가 아닌 도구를 묻지도 않고 거절한다', async () => {
    const h = harness({ permissionMode: 'plan' })
    expect(await h.session.handlePermission(editPermission)).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject_once' }
    })
    expect(h.permissions).toHaveLength(0)
  })

  it('plan 모드에서도 읽기는 사용자에게 묻는다', async () => {
    const h = harness({ permissionMode: 'plan' })
    h.setPermissionAnswer(async () => ({ behavior: 'allow', optionId: 'allow_once' }))
    const read = {
      ...editPermission,
      toolCall: { ...editPermission.toolCall, kind: 'read' }
    } as acp.RequestPermissionRequest

    await h.session.handlePermission(read)
    expect(h.permissions).toHaveLength(1)
  })
})

describe('업데이트 매핑', () => {
  beforeEach(() => vi.useRealTimers())

  it('텍스트는 delta 로 흐르고 도구 호출 앞에서 아이템으로 굳는다', async () => {
    const h = harness()
    void h.session.prompt('hi')
    await settle()

    h.session.handleUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Creating ' }
    } as never)
    h.session.handleUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'the file.' }
    } as never)
    expect(h.persisted).toHaveLength(0)

    h.session.handleUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Creating a.txt',
      kind: 'edit',
      status: 'pending'
    } as never)

    const assistant = h.persisted.find((i) => i.type === 'assistant')
    expect(assistant).toMatchObject({ text: 'Creating the file.' })
    expect(h.persisted.some((i) => i.type === 'tool_use')).toBe(true)
  })

  // percentage 는 0~1 fraction 이다. 0~100 으로 보내면 10% 짜리 대화가 빨간 100% 로 그려진다.
  it('usage_update 를 0~1 fraction 으로 방송한다', async () => {
    const h = harness()
    h.session.handleUpdate({ sessionUpdate: 'usage_update', used: 12716, size: 128000 } as never)
    expect(h.events).toContainEqual({
      type: 'context',
      usedTokens: 12716,
      maxTokens: 128000,
      percentage: 12716 / 128000
    })
  })

  it('처음 보는 업데이트는 unknown 카드로 한 번만 알린다', async () => {
    const h = harness()
    h.session.handleUpdate({ sessionUpdate: 'brand_new_thing' } as never)
    h.session.handleUpdate({ sessionUpdate: 'brand_new_thing' } as never)
    expect(h.persisted.filter((i) => i.type === 'unknown')).toHaveLength(1)
  })

  it('session/load 재생분은 대화에 다시 쌓지 않는다', async () => {
    const h = harness({ resumeSessionId: 'old' })
    const done = h.session.prompt('hi')
    // load 가 도는 동안 과거 대화가 재생된다.
    h.session.handleUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'this is old history' }
    } as never)
    await settle()
    void done

    expect(h.persisted.some((i) => i.type === 'assistant')).toBe(false)
  })
})
