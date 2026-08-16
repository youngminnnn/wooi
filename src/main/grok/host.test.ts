import type * as acp from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'
import type { PermissionDecision, PermissionRequest } from '@shared/types'
import { GrokHost, type GrokConnection } from './host'
import type { AcpExtensionResult } from '../acp/ext'

function harness(decision: PermissionDecision = { behavior: 'allow' }) {
  const mapped = vi.fn()
  const permissions: PermissionRequest[] = []
  const calls: Array<{ method: string; params: unknown }> = []
  const connection: GrokConnection = {
    live: true,
    newSession: vi.fn(async () => ({ sessionId: 'session-1' })),
    loadSession: vi.fn(async () => ({})),
    prompt: vi.fn(async (): Promise<acp.PromptResponse> => ({ stopReason: 'end_turn' })),
    cancel: vi.fn(async () => undefined),
    setMode: vi.fn(async (): Promise<acp.SetSessionModeResponse> => ({})),
    ext: async function <Response, Params>(
      method: string,
      params?: Params
    ): Promise<AcpExtensionResult<Response>> {
      calls.push({ method, params })
      return { supported: false, reason: 'method_not_found' }
    },
    closeSession: vi.fn(async () => undefined),
    dispose: vi.fn()
  }
  const host = new GrokHost(
    {
      onMapped: (_workspaceId, value) => mapped(value),
      onSessionId: vi.fn(),
      askPermission: async (request) => {
        permissions.push(request)
        return decision
      },
      onDisconnect: vi.fn()
    },
    connection
  )
  return { host, connection, mapped, permissions, calls }
}

const permissionRequest: acp.RequestPermissionRequest = {
  sessionId: 'session-1',
  toolCall: { toolCallId: 'tool-1', title: 'Run command', rawInput: { command: 'npm test' } },
  options: [
    { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
    { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
  ]
}

describe('GrokHost protocol routing', () => {
  it('routes a permission request through the Wooi card and returns the selected outcome', async () => {
    const h = harness({ behavior: 'allow', optionId: 'allow-once' })
    await h.host.open('workspace-1', {
      cwd: '/tmp/workspace-1',
      resumeSessionId: null,
      modeId: 'default'
    })

    await expect(h.host.handlePermissionRequest(permissionRequest)).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    })
    expect(h.permissions[0]).toMatchObject({
      workspaceId: 'workspace-1',
      kind: 'tool',
      toolName: 'Run command'
    })
  })

  it('applies the local auto/yolo axis without showing a card', async () => {
    const h = harness()
    await h.host.open('workspace-1', {
      cwd: '/tmp/workspace-1',
      resumeSessionId: null,
      modeId: 'default'
    })
    h.host.setAutoApprove('workspace-1', 'yolo')

    await expect(h.host.handlePermissionRequest(permissionRequest)).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    })
    expect(h.permissions).toHaveLength(0)
  })

  it('suppresses session/load replay updates but maps subsequent live updates', async () => {
    const h = harness()
    await h.host.open('workspace-1', {
      cwd: '/tmp/workspace-1',
      resumeSessionId: 'session-1',
      modeId: 'default'
    })
    const update: acp.SessionUpdate = {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'old history' }
    }

    h.host.handleUpdate('session-1', update, true)
    h.host.handleUpdate('session-1', update, false)

    expect(h.mapped).toHaveBeenCalledOnce()
    expect(h.mapped.mock.calls[0][0].events[0]).toMatchObject({
      type: 'delta',
      text: 'old history'
    })
  })

  it('answers both custom blocking reverse requests', async () => {
    const h = harness({ behavior: 'allow', updatedInput: { answers: { Choice: 'A' } } })
    await h.host.open('workspace-1', {
      cwd: '/tmp/workspace-1',
      resumeSessionId: null,
      modeId: 'plan'
    })

    await expect(
      h.host.handleCustomRequest('x.ai/ask_user_question', {
        session_id: 'session-1',
        question: 'Choose one'
      })
    ).resolves.toEqual({ answers: { Choice: 'A' } })
    await expect(
      h.host.handleCustomRequest('x.ai/exit_plan_mode', { sessionId: 'session-1' })
    ).resolves.toEqual({ approved: true })
    expect(h.permissions.map((request) => request.kind)).toEqual(['question', 'plan'])
  })

  it('passes extension method_not_found downgrades through as unsupported', async () => {
    const h = harness()
    await expect(h.host.ext('x.ai/rewind/points', { sessionId: 'session-1' })).resolves.toEqual({
      supported: false,
      reason: 'method_not_found'
    })
  })
})

describe('GrokHost side questions', () => {
  // /btw 의 계약은 "메인 대화를 건드리지 않는다" 이다. interject 로 구현하면 질문과 답이 그대로
  // 메인 대화에 남으므로, 별도 세션으로 가는지와 트랜스크립트로 새지 않는지를 함께 본다.
  it('asks in a separate session and never reaches the transcript', async () => {
    const h = harness()
    await h.host.open('workspace-1', {
      cwd: '/tmp/workspace-1',
      resumeSessionId: null,
      modeId: 'default'
    })
    h.mapped.mockClear()

    // fork 가 없는 빌드에서도 답은 나와야 한다 — 빈 세션으로 내려간다.
    const asideSession = 'session-aside'
    h.connection.newSession = vi.fn(async () => ({ sessionId: asideSession })) as never

    const chunks: string[] = []
    let release = (): void => undefined
    h.connection.prompt = vi.fn(
      () => new Promise((resolve) => (release = () => resolve({ stopReason: 'end_turn' })))
    ) as never

    const asking = h.host.aside('session-1', '/tmp/workspace-1', 'What is this repo?', (text) =>
      chunks.push(text)
    )
    // 세션이 열리고 수집기가 등록될 때까지 기다린 뒤에야 업데이트를 흘려보낼 수 있다.
    await vi.waitFor(() => expect(h.connection.prompt).toHaveBeenCalled())
    h.host.handleUpdate(
      asideSession,
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'A desktop app.' } },
      false
    )
    release()
    await asking

    expect(chunks).toEqual(['A desktop app.'])
    // 사이드 세션의 말은 대화 매핑을 한 번도 타지 않는다.
    expect(h.mapped).not.toHaveBeenCalled()
    // 메인 대화에 합치는 interject 로 가지 않았다.
    expect(h.calls.map((call) => call.method)).not.toContain('x.ai/interject')
    expect(h.connection.closeSession).toHaveBeenCalledWith(asideSession)
  })

  it('prefers forking so the side question inherits context', async () => {
    const h = harness()
    h.connection.ext = (async (method: string) =>
      method === 'x.ai/session/fork'
        ? { supported: true, value: { sessionId: 'session-forked' } }
        : { supported: false, reason: 'method_not_found' }) as never

    await h.host.aside('session-1', '/tmp/workspace-1', 'Why?', () => undefined)

    expect(h.connection.newSession).not.toHaveBeenCalled()
    expect(h.connection.closeSession).toHaveBeenCalledWith('session-forked')
  })
})
