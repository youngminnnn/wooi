import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent, RunningAgent } from '@shared/types'
import { AsyncQueue } from './asyncQueue'
import { testWooiMcp as wooiMcp } from './testWooiMcp'

class FakeQuery {
  readonly out = new AsyncQueue<Record<string, unknown>>()
  readonly stopTask = vi.fn(async (_taskId: string) => {})
  /**
   * 설정하면 getContextUsage 가 이 promise 를 먼저 기다린다. settleTurn 이 컨텍스트 확인을
   * 기다리는 창을 테스트가 직접 벌려, 그 사이에 SDK 가 스스로 여는 턴을 재현하는 데 쓴다.
   */
  contextGate: Promise<void> | null = null
  async getContextUsage(): Promise<Record<string, number>> {
    if (this.contextGate) await this.contextGate
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

async function start(opts: { autoCompact?: boolean } = {}): Promise<{
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
    autoCompact: opts.autoCompact ?? false,
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

function statuses(events: ChatEvent[]): string[] {
  return events.flatMap((event) => (event.type === 'status' ? [event.status] : []))
}

const RESULT = {
  type: 'result',
  subtype: 'success',
  uuid: 'result',
  session_id: 'session',
  num_turns: 1,
  duration_ms: 1,
  total_cost_usd: 0,
  result: 'done',
  usage: { input_tokens: 0, output_tokens: 0 }
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

    expect(
      latestAgents(events)
        .map((task) => task.taskId)
        .sort()
    ).toEqual(['agent', 'bash'])
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

  /**
   * 회귀: 중단 버튼처럼 메인이 화면을 직접 idle 로 돌린 뒤, 살아 있는 백그라운드 작업 때문에
   * 세션이 idle 을 방출하지 않으면 세션의 기억(busy)과 화면이 어긋난 채 굳는다. 그 상태에서
   * 다음 턴의 running 까지 삼켜지면 그 워크스페이스는 영영 '진행 중' 표시 없이 돌아간다.
   */
  it('강제 idle 뒤에도 다음 턴은 running 을 다시 방출한다', async () => {
    const { session, events } = await start()
    // 백그라운드 서브에이전트가 살아 있으면 턴이 끝나도 idle 로 가지 않는다(설계). 백그라운드
    // 셸(local_bash)로는 이 함정을 재현할 수 없다 — 그쪽은 애초에 상태를 붙잡지 않는다.
    query.out.push(
      system('background_tasks_changed', {
        tasks: [{ task_id: 'agent', task_type: 'agent', description: 'Explore code' }]
      })
    )
    await tick()
    query.out.push({ ...RESULT })
    await tick()
    expect(statuses(events)).toEqual(['running'])

    // 사용자가 중단을 눌렀다 — 메인이 store/렌더러를 idle 로 확정하고 세션에도 알린다.
    session.noteForcedIdle()
    const seen = events.length

    session.send('이어서')
    await tick()
    expect(statuses(events.slice(seen))).toContain('running')
    session.dispose()
  })

  /**
   * 회귀: 서브에이전트의 종료 엣지(task_updated/task_notification)를 놓쳐도 턴이 끝나면 idle 로
   * 간다. 엣지로 상태를 판단하던 시절에는 그 유실 하나가 워크스페이스를 영영 '진행 중' 에 가뒀다 —
   * result 가 와도 agentTasks 가 비지 않아 shouldRun 이 계속 true 였다.
   */
  it('서브에이전트 종료 알림을 놓쳐도 턴이 끝나면 idle 로 간다', async () => {
    const { session, events } = await start()
    query.out.push(
      system('task_started', {
        task_id: 'agent',
        task_type: 'agent',
        subagent_type: 'Explore',
        description: 'Explore code'
      })
    )
    await tick()
    // 종료 엣지 없이 턴만 끝난다.
    query.out.push({ ...RESULT })
    await tick()

    expect(statuses(events)).toEqual(['running', 'idle'])
    session.dispose()
  })

  /**
   * 회귀: 백그라운드 작업 목록은 CLI 프로세스 단위다. 프로세스를 갈아 끼우고도(재시도) 앞
   * 프로세스의 목록을 들고 있으면 그것을 지워 줄 이벤트가 영영 오지 않아, 그 워크스페이스는
   * 이후 모든 턴이 끝나도 idle 로 돌아오지 못한다.
   */
  it('프로세스를 다시 띄우면 앞 프로세스의 백그라운드 목록을 버린다', async () => {
    const { session, events } = await start()
    // 셸과 서브에이전트를 함께 둔다 — 목록이 비는 것(셸)과 상태가 풀리는 것(서브에이전트)을
    // 한 번에 지킨다. 셸만으로는 상태 회귀를 못 잡는다(셸은 상태를 붙잡지 않는다).
    query.out.push(
      system('background_tasks_changed', {
        tasks: [
          { task_id: 'dev', task_type: 'local_bash', description: 'npm run dev' },
          { task_id: 'agent', task_type: 'agent', description: 'Explore code' }
        ]
      })
    )
    await tick()
    expect(latestAgents(events).map((task) => task.taskId)).toEqual(['dev', 'agent'])

    // 산출 없이 스트림이 닫힌다 — 세션은 같은 메시지를 새 프로세스에서 한 번 더 돌린다.
    const first = query
    query.out.close()
    await tick()
    expect(query).not.toBe(first)

    // 새 프로세스의 턴이 끝났다. 앞 프로세스의 목록은 여기 없으므로 idle 이어야 한다.
    query.out.push({ ...RESULT })
    await tick()

    expect(latestAgents(events)).toEqual([])
    expect(statuses(events).at(-1)).toBe('idle')
    session.dispose()
  })

  /**
   * 회귀: 백그라운드 셸은 상태를 붙잡지 않는다.
   *
   * 셸까지 세던 시절에는 "에이전트가 할 말을 다 하고 턴을 닫았는데도 워크스페이스가 진행 중" 인
   * 상태가 만들어졌다. 실제로 겪은 모습은 `until … gh pr checks …` 폴링 셸을 띄운 채 최종 보고를
   * 마친 경우 — 대화는 끝났는데 사이드바만 몇 분을 더 돌았고, 중지를 눌러도 셸은 죽지 않아
   * 그것이 끝나며 모델을 깨우면 스스로 진행 중으로 되돌아갔다.
   *
   * 셸이 사라지는 것이 아니라 **자리를 옮기는** 것이 요점이다: 상태는 idle 로 가되, 목록에는
   * 그대로 남아 사용자가 무엇이 도는지 보고 개별로 중지할 수 있어야 한다.
   */
  it('백그라운드 셸만 남으면 턴이 끝날 때 idle 로 가고, 목록에는 남는다', async () => {
    const { session, events } = await start()
    query.out.push(
      system('background_tasks_changed', {
        tasks: [{ task_id: 'poll', task_type: 'local_bash', description: 'gh pr checks' }]
      })
    )
    await tick()
    query.out.push({ ...RESULT })
    await tick()

    expect(statuses(events)).toEqual(['running', 'idle'])
    expect(latestAgents(events).map((task) => task.taskId)).toEqual(['poll'])
    session.dispose()
  })

  /** 뒤집힌 짝: 백그라운드로 돌린 **서브에이전트**는 여전히 상태를 붙잡는다(실제로 일하는 중이다). */
  it('백그라운드 서브에이전트가 남으면 턴이 끝나도 running 을 유지한다', async () => {
    const { session, events } = await start()
    query.out.push(
      system('background_tasks_changed', {
        tasks: [
          { task_id: 'poll', task_type: 'local_bash', description: 'gh pr checks' },
          { task_id: 'agent', task_type: 'agent', description: 'Explore code' }
        ]
      })
    )
    await tick()
    query.out.push({ ...RESULT })
    await tick()

    expect(statuses(events)).toEqual(['running'])

    // 서브에이전트가 끝나면 셸만 남는다 — 그때 idle 로 확정된다.
    query.out.push(
      system('background_tasks_changed', {
        tasks: [{ task_id: 'poll', task_type: 'local_bash', description: 'gh pr checks' }]
      })
    )
    await tick()
    expect(statuses(events)).toEqual(['running', 'idle'])
    session.dispose()
  })

  /**
   * 회귀: SDK 가 우리의 send() 없이 스스로 연 턴을, 앞 턴의 뒤늦은 settleTurn 이 꺼뜨리면 안 된다.
   *
   * settleTurn 은 getContextUsage(최대 5초)를 기다린 뒤 activeSeq 로 "기다리는 사이 새 턴이
   * 시작됐나" 를 가린다. 그 카운터는 markActive 만 올리는데, 백그라운드 작업 완료로 SDK 가 스스로
   * 여는 턴은 handleMessage 의 안전망을 타므로 한때 카운터를 건너뛰었다 — 그러면 뒤늦게 깨어난
   * settleTurn 이 살아서 도는 턴을 idle 로 방출하고, 렌더러는 그 idle 을 신호로 대기 큐를 풀어
   * 사용자의 다음 메시지를 도는 턴 위에 얹는다.
   */
  it('정산을 기다리는 사이 SDK 가 연 턴은 뒤늦은 idle 로 꺼지지 않는다', async () => {
    const { session, events } = await start({ autoCompact: true })
    let release!: () => void
    query.contextGate = new Promise<void>((resolve) => (release = resolve))

    // 턴이 끝난다 — settleTurn 이 컨텍스트 확인에서 멈춘다.
    query.out.push({ ...RESULT })
    await tick()
    expect(statuses(events)).toEqual(['running'])

    // 그 사이 백그라운드 작업이 끝나 SDK 가 스스로 다음 턴을 연다(산출이 먼저 흐른다).
    query.out.push({
      type: 'assistant',
      uuid: 'assistant-1',
      session_id: 'session',
      message: { id: 'api-1', content: [{ type: 'text', text: '이어서 확인했습니다' }] }
    })
    await tick()

    // 이제 앞 턴의 정산이 깨어난다 — 새 턴이 도는 중이므로 idle 을 방출하면 안 된다.
    release()
    await tick()
    expect(statuses(events)).toEqual(['running'])
    session.dispose()
  })
})
