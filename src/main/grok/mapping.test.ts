import { describe, expect, it } from 'vitest'
import { createAcpMapperState } from '../acp/mapping'
import { isBlockingGrokRequest, mapGrokNotification, mapGrokSessionUpdate } from './mapping'

describe('Grok mapping', () => {
  it('delegates standard ACP updates to the common mapper', () => {
    const result = mapGrokSessionUpdate(
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } },
      createAcpMapperState(),
      10
    )
    expect(result.events).toEqual([
      { type: 'delta', id: 'grok:assistant:current', itemType: 'assistant', text: 'hello' }
    ])
  })

  it('maps subagent spawn and progress notifications to one task card', () => {
    const spawned = mapGrokNotification(
      {
        type: 'subagent_spawned',
        task_id: 'child-1',
        agent_type: 'explore',
        prompt: 'Inspect ACP'
      },
      10
    )
    const progress = mapGrokNotification(
      {
        update: {
          type: 'subagent_progress',
          task_id: 'child-1',
          message: 'Reading files',
          total_tokens: 120,
          tool_uses: 3
        }
      },
      20
    )
    expect(spawned.persist[0]).toMatchObject({
      id: 'grok:subagent:child-1',
      type: 'task',
      status: 'running',
      name: 'explore',
      description: 'Inspect ACP'
    })
    expect(progress.persist[0]).toMatchObject({
      id: 'grok:subagent:child-1',
      status: 'running',
      description: 'Reading files',
      totalTokens: 120,
      toolUses: 3
    })
  })

  it('maps subagent completion and plan approval signals', () => {
    expect(
      mapGrokNotification(
        { event: 'subagent_finished', subagent_id: 'child-2', output: 'Done', duration_ms: 42 },
        30
      ).persist[0]
    ).toMatchObject({
      id: 'grok:subagent:child-2',
      status: 'completed',
      summary: 'Done',
      durationMs: 42
    })
    expect(
      mapGrokNotification(
        { notificationType: 'exit_plan_mode', request_id: 'plan-1', planContent: 'Ship it' },
        40
      ).persist[0]
    ).toMatchObject({ id: 'grok:plan-approval:plan-1', type: 'system', text: 'Ship it' })
  })

  it('marks both Grok reverse requests as blocking', () => {
    expect(isBlockingGrokRequest('x.ai/ask_user_question')).toBe(true)
    expect(isBlockingGrokRequest('x.ai/exit_plan_mode')).toBe(true)
    expect(isBlockingGrokRequest('x.ai/session_notification')).toBe(false)
  })
})
