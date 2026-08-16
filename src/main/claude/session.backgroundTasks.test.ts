import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent, RunningAgent } from '@shared/types'
import { AsyncQueue } from './asyncQueue'
import { testWooiMcp as wooiMcp } from './testWooiMcp'

class FakeQuery {
  readonly out = new AsyncQueue<Record<string, unknown>>()
  readonly stopTask = vi.fn(async (_taskId: string) => {})
  async getContextUsage(): Promise<Record<string, number>> {
    return { totalTokens: 0, maxTokens: 200_000, percentage: 0, autoCompactThreshold: 167_000 }
  }
  async interrupt(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  [Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
    return this.out[Symbol.asyncIterator]()
  }
}

let query: FakeQuery

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    query = new FakeQuery()
    return query
  }
}))
vi.mock('./executable', () => ({ resolveClaudeExecutable: () => null }))

const tick = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

async function start(): Promise<{
  session: InstanceType<typeof import('./session').ClaudeSession>
  events: ChatEvent[]
}> {
  const { ClaudeSession } = await import('./session')
  const events: ChatEvent[] = []
  const session = new ClaudeSession({
    cwd: process.cwd(),
    repoPath: null,
    mcpSettings: { servers: [], disabledInherited: [] },
    model: null,
    effort: null,
    fastMode: false,
    permissionMode: 'default',
    autoCompact: false,
    peer: { name: 'wooi/repo/test', inbound: 'refuse' },
    resumeSessionId: null,
    additionalDirs: [],
    wooiMcp,
    emit: (event) => events.push(event),
    persist: () => {},
    requestPermission: async () => ({ behavior: 'deny' as const }),
    onSessionId: () => {},
    onPermissionMode: () => {},
    settleIdle: () => {}
  })
  session.send('start')
  await tick()
  return { session, events }
}

function system(subtype: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { type: 'system', subtype, uuid: `${subtype}-uuid`, session_id: 'session', ...fields }
}

function latestAgents(events: ChatEvent[]): RunningAgent[] {
  return [...events].reverse().find((event) => event.type === 'agents')?.agents ?? []
}

describe('ClaudeSession background tasks', () => {
  beforeEach(() => vi.clearAllMocks())

  it('snapshot 이 이전 목록을 교체하고 빈 snapshot 이 전부 지운다', async () => {
    const { session, events } = await start()
    query.out.push(
      system('background_tasks_changed', {
        tasks: [
          { task_id: 'one', task_type: 'local_bash', description: 'Build' },
          { task_id: 'two', task_type: 'local_bash', description: 'Test' }
        ]
      })
    )
    await tick()
    expect(latestAgents(events).map((task) => task.taskId)).toEqual(['one', 'two'])

    query.out.push(
      system('background_tasks_changed', {
        tasks: [{ task_id: 'two', task_type: 'local_bash', description: 'Test again' }]
      })
    )
    await tick()
    expect(latestAgents(events).map((task) => [task.taskId, task.description])).toEqual([
      ['two', 'Test again']
    ])

    query.out.push(system('background_tasks_changed', { tasks: [] }))
    await tick()
    expect(latestAgents(events)).toEqual([])
    session.dispose()
  })

  it('local_bash 는 보이되 같은 task id 의 subagent 는 한 번만 보인다', async () => {
    const { session, events } = await start()
    query.out.push(
      system('background_tasks_changed', {
        tasks: [
          { task_id: 'bash', task_type: 'local_bash', description: 'Run tests' },
          { task_id: 'agent', task_type: 'agent', description: 'Explore code' }
        ]
      })
    )
    query.out.push(
      system('task_started', {
        task_id: 'agent',
        task_type: 'agent',
        subagent_type: 'Explore',
        description: 'Explore code'
      })
    )
    await tick()

    expect(latestAgents(events).map((task) => task.taskId).sort()).toEqual(['agent', 'bash'])
    expect(latestAgents(events).find((task) => task.taskId === 'agent')?.taskType).toBeUndefined()
    expect(latestAgents(events).find((task) => task.taskId === 'bash')?.taskType).toBe('local_bash')
    session.dispose()
  })

  it('stop 요청을 query 에 전달하고 종료 알림에서 표시를 제거한다', async () => {
    const { session, events } = await start()
    query.out.push(
      system('background_tasks_changed', {
        tasks: [{ task_id: 'bash', task_type: 'local_bash', description: 'Run tests' }]
      })
    )
    await tick()
    await session.stopTask('bash')
    expect(query.stopTask).toHaveBeenCalledWith('bash')

    query.out.push({
      type: 'result',
      subtype: 'success',
      uuid: 'result',
      session_id: 'session',
      num_turns: 1,
      duration_ms: 1,
      total_cost_usd: 0,
      result: 'backgrounded',
      usage: { input_tokens: 0, output_tokens: 0 }
    })
    await tick()

    query.out.push(
      system('task_notification', {
        task_id: 'bash',
        status: 'completed',
        output_file: '/tmp/output',
        summary: 'done'
      })
    )
    await tick()
    expect(latestAgents(events)).toEqual([])
    expect(events).toContainEqual({ type: 'status', status: 'idle' })
    session.dispose()
  })
})
