import { describe, it, expect } from 'vitest'
import {
  answersFor,
  createMapperState,
  mapCommandApproval,
  mapFileChangeApproval,
  mapNotification,
  mapUserInputRequest,
  rememberOptimisticUser,
  toCodexDecision,
  PLAN_SNAPSHOT_TOOL,
  type MapperState
} from './mapping'
import { NOTIFY } from './wire'
import type { ChatItem } from '@shared/types'

/**
 * 이 파일이 Codex 백엔드의 계약서다 — 실제 codex 없이 렌더링 경로 전체를 고정한다.
 * 프로토콜이 바뀌면 앱이 이상해지기 전에 여기가 먼저 깨져야 한다.
 */

function map(method: string, params: unknown, state: MapperState = createMapperState()) {
  return mapNotification(method, params, state)
}

/** 이벤트에서 아이템만 추려 낸다(대부분의 단언이 아이템 모양을 본다). */
function items(result: ReturnType<typeof map>): ChatItem[] {
  return result.events.flatMap((e) => (e.type === 'item' ? [e.item] : []))
}

describe('스레드·턴 수명주기', () => {
  it('thread/started 의 threadId 를 resume 토큰으로 넘긴다', () => {
    const r = map(NOTIFY.threadStarted, { threadId: 'thr_123' })
    expect(r.events).toEqual([{ type: 'session', sessionId: 'thr_123' }])
  })

  it('turn/started 는 running 으로 전환한다', () => {
    expect(map(NOTIFY.turnStarted, {}).events).toEqual([{ type: 'status', status: 'running' }])
  })

  it('turn/completed 는 요약 카드와 idle 을 남긴다', () => {
    const r = map(NOTIFY.turnCompleted, { turn: { id: 't1', status: 'completed' } })
    const result = items(r)[0]
    expect(result.type).toBe('result')
    expect(r.events.at(-1)).toEqual({ type: 'status', status: 'idle' })
    expect(r.persist).toHaveLength(1)
  })

  // Codex 는 USD 원가를 주지 않는다. 0 을 넣으면 Overview 합계가 실제보다 낮게 보인다.
  it('요약 카드에 costUsd 를 넣지 않는다', () => {
    const r = map(NOTIFY.turnCompleted, { turn: { status: 'completed' } })
    const result = items(r)[0] as Extract<ChatItem, { type: 'result' }>
    expect(result.costUsd).toBeUndefined()
  })

  it('실패한 턴은 에러 카드 + error 상태를 낸다', () => {
    const r = map(NOTIFY.turnCompleted, {
      turn: { status: 'failed', error: { message: 'upstream exploded' } }
    })
    expect(items(r)[0]).toMatchObject({ type: 'error', text: 'upstream exploded' })
    expect(r.events.at(-1)).toEqual({ type: 'status', status: 'error' })
  })

  it('분류된 오류에는 실행 가능한 안내를 덧붙인다', () => {
    const r = map(NOTIFY.turnCompleted, {
      turn: {
        status: 'failed',
        error: { message: 'limit', codexErrorInfo: 'usageLimitExceeded' }
      }
    })
    expect((items(r)[0] as { text: string }).text).toMatch(/usage limit/i)
  })

  it('구버전 PascalCase 오류 분류도 안내한다', () => {
    const r = map(NOTIFY.turnCompleted, {
      turn: {
        status: 'failed',
        error: { message: 'limit', codexErrorInfo: 'UsageLimitExceeded' }
      }
    })
    expect((items(r)[0] as { text: string }).text).toMatch(/usage limit/i)
  })

  it('모르는 오류 분류는 원문만 보여 준다', () => {
    const r = map(NOTIFY.turnCompleted, {
      turn: { status: 'failed', error: { message: 'weird', codexErrorInfo: 'SomethingNew' } }
    })
    expect((items(r)[0] as { text: string }).text).toBe('weird')
  })
})

describe('어시스턴트 메시지', () => {
  it('진행 중 아이템은 화면에만, 확정된 것만 트랜스크립트에', () => {
    const started = map(NOTIFY.itemStarted, { item: { id: 'i1', type: 'agentMessage', text: '' } })
    expect(started.persist).toHaveLength(0)
    expect(items(started)[0]).toMatchObject({ type: 'assistant', streaming: true })

    const done = map(NOTIFY.itemCompleted, {
      item: { id: 'i1', type: 'agentMessage', text: 'hello' }
    })
    expect(done.persist).toHaveLength(1)
    expect(items(done)[0]).toMatchObject({ type: 'assistant', text: 'hello' })
  })

  it('델타는 같은 id 로 이어 붙는다', () => {
    const r = map(NOTIFY.agentMessageDelta, { itemId: 'i1', delta: 'wor' })
    expect(r.events).toEqual([
      { type: 'delta', id: 'codex:i1', itemType: 'assistant', text: 'wor' }
    ])
  })

  it('started 와 delta 의 id 가 일치해야 이어 붙는다', () => {
    const started = items(map(NOTIFY.itemStarted, { item: { id: 'i1', type: 'agentMessage' } }))[0]
    const delta = map(NOTIFY.agentMessageDelta, { itemId: 'i1', delta: 'x' }).events[0]
    expect(delta).toMatchObject({ id: started.id })
  })

  it('빈 델타는 무시한다', () => {
    expect(map(NOTIFY.agentMessageDelta, { itemId: 'i1', delta: '' }).events).toHaveLength(0)
  })
})

describe('추론 요약', () => {
  it('summary 배열을 thinking 으로 합친다', () => {
    const r = map(NOTIFY.itemCompleted, {
      item: { id: 'r1', type: 'reasoning', summary: ['first', 'second'] }
    })
    expect(items(r)[0]).toMatchObject({ type: 'thinking', text: 'first\n\nsecond' })
  })

  it('summary 가 문자열로 와도 받는다', () => {
    const r = map(NOTIFY.itemCompleted, { item: { id: 'r1', type: 'reasoning', summary: 'solo' } })
    expect(items(r)[0]).toMatchObject({ text: 'solo' })
  })

  it('요약 델타는 thinking 버블로 흐른다', () => {
    const r = map(NOTIFY.reasoningSummaryDelta, { itemId: 'r1', delta: 'think' })
    expect(r.events[0]).toMatchObject({ type: 'delta', itemType: 'thinking', text: 'think' })
  })
})

describe('명령 실행', () => {
  it('시작 → 출력 델타 → 완료가 하나의 카드로 자란다', () => {
    const state = createMapperState()

    const started = map(
      NOTIFY.itemStarted,
      { item: { id: 'c1', type: 'commandExecution', command: 'npm test', cwd: '/repo' } },
      state
    )
    expect(items(started)[0]).toMatchObject({
      type: 'bash',
      agent: true,
      command: 'npm test',
      cwd: '/repo',
      running: true
    })

    map(NOTIFY.commandOutputDelta, { itemId: 'c1', delta: 'PASS ' }, state)
    const mid = map(NOTIFY.commandOutputDelta, { itemId: 'c1', delta: 'a.test' }, state)
    // 출력이 누적되고, 명령·cwd 는 델타에도 유지된다.
    expect(items(mid)[0]).toMatchObject({
      output: 'PASS a.test',
      command: 'npm test',
      cwd: '/repo',
      running: true
    })
    expect(mid.persist).toHaveLength(0)

    const done = map(
      NOTIFY.itemCompleted,
      {
        item: {
          id: 'c1',
          type: 'commandExecution',
          command: 'git status',
          status: 'completed',
          exitCode: 0
        }
      },
      state
    )
    expect(items(done)[0]).toMatchObject({ running: false, exitCode: 0, output: 'PASS a.test' })
    expect(done.persist).toHaveLength(1)
  })

  it('완료 시 서버의 전체 출력이 델타 버퍼보다 우선한다', () => {
    const state = createMapperState()
    map(NOTIFY.itemStarted, { item: { id: 'c1', type: 'commandExecution', command: 'x' } }, state)
    map(NOTIFY.commandOutputDelta, { itemId: 'c1', delta: 'partial' }, state)
    const done = map(
      NOTIFY.itemCompleted,
      {
        item: {
          id: 'c1',
          type: 'commandExecution',
          status: 'completed',
          exitCode: 0,
          aggregatedOutput: 'full output'
        }
      },
      state
    )
    expect(items(done)[0]).toMatchObject({ output: 'full output' })
  })

  it('사용자 shell 출처는 agent 카드로 오인하지 않는다', () => {
    const state = createMapperState()
    const started = map(
      NOTIFY.itemStarted,
      {
        item: {
          id: 'c1',
          type: 'commandExecution',
          source: 'userShell',
          command: 'git status'
        }
      },
      state
    )
    expect(items(started)[0]).not.toHaveProperty('agent')

    const mid = map(NOTIFY.commandOutputDelta, { itemId: 'c1', delta: 'clean' }, state)
    expect(items(mid)[0]).not.toHaveProperty('agent')

    const done = map(
      NOTIFY.itemCompleted,
      { item: { id: 'c1', type: 'commandExecution', status: 'completed', exitCode: 0 } },
      state
    )
    expect(items(done)[0]).not.toHaveProperty('agent')
  })

  it('출처 필드가 없는 옛 app-server 결과는 에이전트 명령으로 유지한다', () => {
    const r = map(NOTIFY.itemCompleted, {
      item: { id: 'c1', type: 'commandExecution', command: 'pwd', status: 'completed' }
    })
    expect(items(r)[0]).toMatchObject({ type: 'bash', agent: true })
  })

  it('완료 후 버퍼를 비워 메모리가 새지 않게 한다', () => {
    const state = createMapperState()
    map(NOTIFY.itemStarted, { item: { id: 'c1', type: 'commandExecution', command: 'x' } }, state)
    map(NOTIFY.commandOutputDelta, { itemId: 'c1', delta: 'out' }, state)
    map(
      NOTIFY.itemCompleted,
      { item: { id: 'c1', type: 'commandExecution', status: 'completed', exitCode: 0 } },
      state
    )
    expect(state.output.size).toBe(0)
    expect(state.command.size).toBe(0)
  })

  it('거절된 명령은 실행되지 않았음을 남긴다', () => {
    const state = createMapperState()
    const done = map(
      NOTIFY.itemCompleted,
      { item: { id: 'c1', type: 'commandExecution', command: 'rm -rf /', status: 'declined' } },
      state
    )
    expect(items(done)[0]).toMatchObject({ running: false, exitCode: -1 })
  })
})

describe('서브에이전트 조율 (collabAgentToolCall)', () => {
  // 매핑이 없으면 조용히 버려져, 서브에이전트를 돌리는 동안 대화가 텅 빈 것처럼 보인다.
  it('도구 호출 카드로 남긴다', () => {
    const r = map(NOTIFY.itemCompleted, {
      item: {
        id: 'a1',
        type: 'collabAgentToolCall',
        tool: 'spawn_agent',
        status: 'completed',
        prompt: 'Review the diff'
      }
    })
    const [use] = items(r)
    expect(use).toMatchObject({ type: 'tool_use', name: 'spawn_agent' })
    expect(use).toHaveProperty('input', { prompt: 'Review the diff' })
    expect(r.persist).toHaveLength(2)
  })

  it('도구 이름이 없어도 터지지 않는다', () => {
    expect(() =>
      map(NOTIFY.itemCompleted, { item: { id: 'a1', type: 'collabAgentToolCall' } })
    ).not.toThrow()
  })
})

describe('최신 Codex 활동 아이템', () => {
  it('dynamicToolCall을 일반 도구 카드로 남긴다', () => {
    const r = map(NOTIFY.itemCompleted, {
      item: {
        id: 'd1',
        type: 'dynamicToolCall',
        namespace: 'apps',
        tool: 'lookup',
        arguments: { q: 'x' },
        success: true,
        contentItems: [{ type: 'inputText', text: 'ok' }]
      }
    })
    expect(items(r)[0]).toMatchObject({ type: 'tool_use', name: 'apps/lookup' })
    expect(r.persist).toHaveLength(2)
  })

  it('MCP 호출은 Claude와 같은 이름 규약과 구조화 텍스트를 쓴다', () => {
    const r = map(NOTIFY.itemCompleted, {
      item: {
        id: 'm1',
        type: 'mcpToolCall',
        server: 'github',
        tool: 'get_file',
        arguments: { path: 'README.md' },
        status: 'completed',
        result: { content: [{ type: 'text', text: 'contents' }] }
      }
    })
    const [use, result] = items(r)
    expect(use).toMatchObject({ type: 'tool_use', name: 'mcp__github__get_file' })
    expect(result).toMatchObject({ type: 'tool_result', text: 'contents' })
  })

  it('이미지 조회는 경로만 작은 요약으로 싣는다', () => {
    const r = map(NOTIFY.itemCompleted, {
      item: { id: 'i1', type: 'imageView', path: '/tmp/a.png' }
    })
    expect(items(r)[1]).toMatchObject({ summary: { kind: 'view', path: '/tmp/a.png' } })
  })

  it('subAgentActivity를 실행 중 에이전트 스냅샷으로 옮긴다', () => {
    const state = createMapperState()
    const started = map(
      NOTIFY.itemCompleted,
      {
        item: {
          id: 'a1',
          type: 'subAgentActivity',
          kind: 'started',
          agentThreadId: 'thr-child',
          agentPath: 'reviewer'
        }
      },
      state
    )
    expect(started.events[0]).toMatchObject({
      type: 'agents',
      agents: [{ taskId: 'thr-child', agentType: 'reviewer' }]
    })

    const stopped = map(
      NOTIFY.itemCompleted,
      {
        item: {
          id: 'a2',
          type: 'subAgentActivity',
          kind: 'interrupted',
          agentThreadId: 'thr-child'
        }
      },
      state
    )
    expect(stopped.events[0]).toEqual({ type: 'agents', agents: [] })
  })

  it('hookPrompt를 시스템 메시지로 보여 준다', () => {
    const r = map(NOTIFY.itemCompleted, {
      item: { id: 'h1', type: 'hookPrompt', fragments: [{ text: 'run formatter' }] }
    })
    expect(items(r)[0]).toMatchObject({
      type: 'system',
      text: expect.stringContaining('formatter')
    })
  })
})

describe('파일 변경', () => {
  it('완료 시 tool_use + tool_result 를 남긴다', () => {
    const r = map(NOTIFY.itemCompleted, {
      item: {
        id: 'f1',
        type: 'fileChange',
        status: 'completed',
        changes: [{ path: 'src/a.ts', kind: 'update', diff: '@@ -1 +1 @@' }]
      }
    })
    const [use, result] = items(r)
    expect(use).toMatchObject({ type: 'tool_use', name: 'Apply patch' })
    expect(result).toMatchObject({ type: 'tool_result', isError: false })
    expect((result as { text: string }).text).toContain('src/a.ts')
    expect(r.persist).toHaveLength(2)
  })

  it('실패한 패치는 오류로 표시한다', () => {
    const r = map(NOTIFY.itemCompleted, {
      item: { id: 'f1', type: 'fileChange', status: 'failed', changes: [] }
    })
    expect(items(r)[1]).toMatchObject({ isError: true })
  })
})

describe('플랜 스냅샷', () => {
  it('전체 스냅샷을 체크리스트 도구로 실어 보낸다', () => {
    const r = map(NOTIFY.turnPlanUpdated, {
      turnId: 't1',
      plan: [
        { step: 'Read code', status: 'completed' },
        { step: 'Write test', status: 'inProgress' },
        { step: 'Ship', status: 'pending' }
      ]
    })
    const use = items(r)[0] as Extract<ChatItem, { type: 'tool_use' }>
    expect(use.name).toBe(PLAN_SNAPSHOT_TOOL)
    expect(use.input).toMatchObject({
      tasks: [
        { subject: 'Read code', status: 'completed' },
        { subject: 'Write test', status: 'in_progress' },
        { subject: 'Ship', status: 'pending' }
      ]
    })
  })

  it('같은 턴의 갱신은 같은 id 로 덮어쓴다(목록이 누적되지 않도록)', () => {
    const a = items(map(NOTIFY.turnPlanUpdated, { turnId: 't1', plan: [{ step: 'a' }] }))[0]
    const b = items(map(NOTIFY.turnPlanUpdated, { turnId: 't1', plan: [{ step: 'b' }] }))[0]
    expect(a.id).toBe(b.id)
  })

  it('빈 플랜은 무시한다', () => {
    expect(map(NOTIFY.turnPlanUpdated, { plan: [] }).events).toHaveLength(0)
  })
})

describe('컨텍스트 사용량', () => {
  it('마지막 요청의 입력 토큰을 창 크기 대비로 환산한다', () => {
    const r = map(NOTIFY.tokenUsage, {
      tokenUsage: {
        // 누적(total)이 아니라 last 를 봐야 한다 — 누적을 쓰면 미터가 금세 100% 가 된다.
        total: { inputTokens: 9999, cachedInputTokens: 9999 },
        last: { inputTokens: 200, cachedInputTokens: 50 },
        modelContextWindow: 1000
      }
    })
    expect(r.events[0]).toEqual({
      type: 'context',
      usedTokens: 200,
      maxTokens: 1000,
      percentage: 0.2
    })
  })

  // 실측: totalTokens(17105) = inputTokens(17100) + outputTokens(5) 이므로 cachedInputTokens 는
  // inputTokens 의 부분집합이다. 더하면 사용량이 크게 부풀려진다.
  it('캐시된 입력을 중복으로 더하지 않는다', () => {
    const r = map(NOTIFY.tokenUsage, {
      tokenUsage: {
        last: {
          totalTokens: 17105,
          inputTokens: 17100,
          cachedInputTokens: 11008,
          outputTokens: 5
        },
        modelContextWindow: 258400
      }
    })
    expect(r.events[0]).toMatchObject({ usedTokens: 17100, maxTokens: 258400 })
  })

  it('창 크기를 모르면 아무것도 내지 않는다', () => {
    const r = map(NOTIFY.tokenUsage, {
      tokenUsage: { last: { inputTokens: 10 }, modelContextWindow: null }
    })
    expect(r.events).toHaveLength(0)
  })

  it('비율은 1 을 넘지 않는다', () => {
    const r = map(NOTIFY.tokenUsage, {
      tokenUsage: { last: { inputTokens: 500 }, modelContextWindow: 100 }
    })
    expect(r.events[0]).toMatchObject({ percentage: 1 })
  })
})

describe('압축', () => {
  it('시작은 배지로, 종료는 접을 수 있는 영속 경계로 옮긴다', () => {
    const start = map(NOTIFY.itemStarted, { item: { id: 'k1', type: 'contextCompaction' } })
    expect(start.events).toEqual([{ type: 'compacting', active: true, trigger: 'auto' }])
    expect(start.persist).toHaveLength(0)

    const end = map(NOTIFY.itemCompleted, { item: { id: 'k1', type: 'contextCompaction' } })
    expect(end.events).toEqual([
      { type: 'item', item: expect.objectContaining({ type: 'compaction', trigger: 'auto' }) },
      { type: 'compacting', active: false, trigger: 'auto' }
    ])
    expect(end.persist).toEqual([
      expect.objectContaining({ id: 'codex:k1', type: 'compaction', trigger: 'auto' })
    ])
  })
})

// 이 그룹이 이 파일에서 가장 중요하다 — codex 는 우리가 고정할 수 없는 사용자 설치본이라,
// 모르는 입력에 throw 하면 대화가 통째로 멈춘다.
describe('알 수 없는 입력에 견디기', () => {
  it('확정된 사용자 메시지와 이미지를 표시·영속화한다', () => {
    const r = map(NOTIFY.itemCompleted, {
      item: {
        id: 'u1',
        type: 'userMessage',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'localImage', path: '/tmp/screenshot.webp' }
        ]
      }
    })
    expect(items(r)[0]).toMatchObject({
      id: 'codex:u1',
      type: 'user',
      text: 'hello',
      attachments: [{ name: 'screenshot.webp', mediaType: 'image/webp' }]
    })
    expect(r.persist).toHaveLength(1)
  })

  it('진행 중인 사용자 메시지는 중복 표시하지 않는다', () => {
    expect(
      map(NOTIFY.itemStarted, {
        item: { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'hello' }] }
      }).events
    ).toHaveLength(0)
  })

  it('로컬에 즉시 표시한 사용자 메시지의 서버 echo는 중복 표시하지 않는다', () => {
    const state = createMapperState()
    rememberOptimisticUser(state, 'hello', ['screenshot.webp'])

    const r = map(
      NOTIFY.itemCompleted,
      {
        item: {
          id: 'u1',
          type: 'userMessage',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'localImage', path: '/tmp/screenshot.webp' }
          ]
        }
      },
      state
    )

    expect(r).toEqual({ events: [], persist: [] })
    expect(state.pendingUserEchoes).toEqual([])
  })

  it('모르는 아이템 타입은 조용히 넘긴다', () => {
    const r = map(NOTIFY.itemCompleted, { item: { id: 'x', type: 'someFutureThing' } })
    expect(r).toEqual({ events: [], persist: [] })
  })

  it('모르는 아이템 타입은 콜백으로 한 번 알려 준다', () => {
    const seen: string[] = []
    mapNotification(
      NOTIFY.itemCompleted,
      { item: { id: 'x', type: 'someFutureThing' } },
      createMapperState(),
      (what) => seen.push(what)
    )
    expect(seen).toEqual(['item type "someFutureThing"'])
  })

  it('모르는 알림 메서드는 조용히 넘긴다', () => {
    expect(map('some/futureNotification', { anything: true })).toEqual({ events: [], persist: [] })
  })

  it('params 가 비어 있어도 터지지 않는다', () => {
    for (const method of Object.values(NOTIFY)) {
      expect(() => map(method, undefined)).not.toThrow()
      expect(() => map(method, {})).not.toThrow()
      expect(() => map(method, null)).not.toThrow()
    }
  })

  it('아이템에 필드가 하나도 없어도 터지지 않다', () => {
    for (const type of ['agentMessage', 'reasoning', 'commandExecution', 'fileChange', 'plan']) {
      expect(() => map(NOTIFY.itemCompleted, { item: { type } })).not.toThrow()
    }
  })
})

describe('승인 요청 매핑', () => {
  it('명령 승인은 명령·cwd 와 기본 결정지를 싣는다', () => {
    const req = mapCommandApproval({ command: 'rm -rf build', cwd: '/repo', reason: 'cleanup' })
    expect(req).toMatchObject({ kind: 'command', toolName: 'Shell', decisionReason: 'cleanup' })
    expect(req.input).toEqual({ command: 'rm -rf build', cwd: '/repo' })
    expect(req.options?.map((o) => o.id)).toEqual(['accept', 'acceptForSession', 'decline'])
  })

  it('서버가 결정지를 제시하면 그것을 그대로 쓴다', () => {
    const req = mapCommandApproval({ command: 'x', availableDecisions: ['accept', 'cancel'] })
    expect(req.options?.map((o) => o.id)).toEqual(['accept', 'cancel'])
    expect(req.options?.find((o) => o.id === 'cancel')?.behavior).toBe('deny')
  })

  // 실측: availableDecisions 에는 문자열과 객체가 섞여 온다. 객체를 문자열로 다루면 버튼
  // 라벨이 "[object Object]" 가 되고, 응답도 서버가 거절한다.
  it('객체 형태의 결정지도 사람이 읽는 버튼으로 만든다', () => {
    const amendment = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['/bin/zsh'] } }
    const req = mapCommandApproval({
      command: 'x',
      availableDecisions: ['accept', amendment, 'cancel']
    })
    expect(req.options?.map((o) => o.id)).toEqual([
      'accept',
      'acceptWithExecpolicyAmendment',
      'cancel'
    ])
    const opt = req.options?.find((o) => o.id === 'acceptWithExecpolicyAmendment')
    expect(opt?.label).not.toContain('object')
    expect(opt?.behavior).toBe('allow')
  })

  it('acceptForSession 은 세션 기억 플래그를 단다', () => {
    const req = mapCommandApproval({ command: 'x' })
    expect(req.options?.find((o) => o.id === 'acceptForSession')?.rememberForSession).toBe(true)
  })

  it('파일 변경 승인은 diff 를 실어 DiffView 로 보여 줄 수 있게 한다', () => {
    const req = mapFileChangeApproval({}, [
      { path: 'a.ts', kind: 'update', diff: '@@ a @@' },
      { path: 'b.ts', kind: 'update', diff: '@@ b @@' }
    ])
    expect(req.kind).toBe('fileChange')
    expect(req.title).toContain('2 files')
    expect(req.diff).toContain('@@ a @@')
    expect(req.diff).toContain('@@ b @@')
  })

  it('파일이 하나면 제목에 경로를 그대로 쓴다', () => {
    const req = mapFileChangeApproval({}, [{ path: 'src/x.ts', kind: 'update', diff: 'd' }])
    expect(req.title).toContain('src/x.ts')
  })

  // QuestionPrompt 는 options 를 {label, description} 객체로, header 를 칩 라벨로 읽는다.
  // 문자열 배열을 그대로 넘기면 선택지가 통째로 안 그려진다.
  it('질문 요청을 QuestionPrompt 가 읽는 모양으로 옮긴다', () => {
    const req = mapUserInputRequest({
      questions: [
        {
          id: 'q1',
          header: 'Port',
          question: 'Which port?',
          options: [
            { label: '3000', description: 'dev' },
            { label: '8080', description: '' }
          ]
        }
      ]
    })
    expect(req).toMatchObject({ kind: 'question', toolName: 'AskUserQuestion' })
    expect(req.input.questions).toEqual([
      {
        id: 'q1',
        question: 'Which port?',
        header: 'Port',
        options: [
          { label: '3000', description: 'dev' },
          { label: '8080', description: '' }
        ]
      }
    ])
  })

  it('긴 질문문은 칩 라벨용으로 줄인다', () => {
    const long = 'Which of these deployment targets should we use for the staging rollout?'
    const req = mapUserInputRequest({ questions: [{ id: 'q', question: long }] })
    const header = (req.input.questions as { header: string }[])[0].header
    expect(header.length).toBeLessThanOrEqual(24)
    expect(header.endsWith('…')).toBe(true)
  })

  it('선택지가 없는 질문도 터지지 않는다', () => {
    expect(() =>
      mapUserInputRequest({ questions: [{ id: 'q', question: 'Free text?', isOther: true }] })
    ).not.toThrow()
  })
})

// QuestionPrompt 는 답을 "질문문 → 답" 객체로 돌려주는데 codex 는 질문 **순서대로의 배열**을
// 기대한다. 이 변환이 틀리면 답이 엉뚱한 질문에 붙는다.
describe('질문 답변 → codex answers 맵', () => {
  const params = {
    questions: [
      { id: 'q1', question: 'Which port?' },
      { id: 'q2', question: 'Which env?' }
    ]
  }

  // codex 는 **질문 id** 를 키로 하는 맵을 기대한다(질문문이 아니다). 여기가 틀리면 답이
  // 통째로 버려지거나 엉뚱한 질문에 붙는다.
  it('질문문 키 답변을 질문 id 키 맵으로 옮긴다', () => {
    expect(
      answersFor(params, { answers: { 'Which env?': 'prod', 'Which port?': '3000' } })
    ).toEqual({ q1: { answers: ['3000'] }, q2: { answers: ['prod'] } })
  })

  it('다중 선택은 배열로 되돌린다', () => {
    expect(answersFor(params, { answers: { 'Which port?': '3000, 8080' } })).toEqual({
      q1: { answers: ['3000', '8080'] }
    })
  })

  it('답이 없는 질문은 아예 빼놓는다', () => {
    expect(answersFor(params, { answers: { 'Which port?': '' } })).toEqual({})
  })

  it('답이 없거나 모양이 어긋나면 빈 맵', () => {
    expect(answersFor(params, undefined)).toEqual({})
    expect(answersFor(params, { answers: 'nope' })).toEqual({})
  })

  it('id 가 없는 질문은 건너뛴다(키를 만들 수 없다)', () => {
    expect(answersFor({ questions: [{ question: 'x' }] }, { answers: { x: 'y' } })).toEqual({})
  })
})

describe('권한 결정 → codex decision', () => {
  it('사용자가 고른 선택지를 그대로 돌려준다', () => {
    expect(toCodexDecision({ behavior: 'allow', optionId: 'acceptForSession' })).toBe(
      'acceptForSession'
    )
    expect(toCodexDecision({ behavior: 'deny', optionId: 'cancel' })).toBe('cancel')
  })

  it('선택지가 없으면 behavior 로 환산한다', () => {
    expect(toCodexDecision({ behavior: 'allow' })).toBe('accept')
    expect(toCodexDecision({ behavior: 'deny' })).toBe('decline')
    expect(toCodexDecision({ behavior: 'allow', rememberForSession: true })).toBe(
      'acceptForSession'
    )
  })

  it('모르는 선택지 id 는 behavior 로 폴백한다(엉뚱한 값을 서버로 보내지 않도록)', () => {
    expect(toCodexDecision({ behavior: 'allow', optionId: 'bogus' })).toBe('accept')
    expect(toCodexDecision({ behavior: 'deny', optionId: 'bogus' })).toBe('decline')
  })

  // 객체 결정은 payload 를 요구한다 — 바깥 키만 문자열로 보내면 서버가 거절한다.
  it('객체 결정은 원본을 통째로 되돌린다', () => {
    const amendment = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['/bin/zsh'] } }
    const available = ['accept', amendment, 'cancel']
    expect(
      toCodexDecision({ behavior: 'allow', optionId: 'acceptWithExecpolicyAmendment' }, available)
    ).toBe(amendment)
  })

  it('원본 목록이 있으면 문자열 결정도 그 목록에서 고른다', () => {
    expect(toCodexDecision({ behavior: 'deny', optionId: 'cancel' }, ['accept', 'cancel'])).toBe(
      'cancel'
    )
  })
})

/**
 * 여기 있는 페이로드는 전부 codex 0.146.0 스키마(`codex app-server generate-json-schema`)에서
 * 필드명과 필수 여부를 확인한 것이다. 관측한 값이 있으면 관측한 모양 그대로 썼다.
 */
describe('턴 누적 diff', () => {
  // 본문을 카드로 만들지 않는 것이 핵심이다 — Changes 패널의 정본은 git 하나로 둔다.
  it('turn/diff/updated 는 본문 없이 갱신 신호만 낸다', () => {
    const r = map(NOTIFY.turnDiffUpdated, {
      threadId: 'thr_1',
      turnId: 't1',
      diff: 'diff --git a/math.js b/math.js\n+export function subtract() {}\n'
    })
    expect(r.events).toEqual([{ type: 'workingTreeChanged' }])
    expect(r.persist).toEqual([])
  })

  it('diff 가 비면 아무것도 하지 않는다', () => {
    expect(map(NOTIFY.turnDiffUpdated, { threadId: 'thr_1', turnId: 't1' }).events).toEqual([])
  })
})

describe('MCP 서버 기동 상태', () => {
  // 실측: 턴 하나에 12~23번 오고 대부분 starting→ready 진동이다. 전부 카드로 만들면 대화가 덮인다.
  it('starting·ready·cancelled 는 버린다', () => {
    const state = createMapperState()
    for (const status of ['starting', 'ready', 'cancelled']) {
      expect(map(NOTIFY.mcpStartupStatus, { name: 'srv', status }, state).events).toEqual([])
    }
  })

  it('failed 는 서버 이름과 원인을 담은 에러 카드를 남긴다', () => {
    const r = map(NOTIFY.mcpStartupStatus, {
      threadId: 'thr_1',
      name: 'broken-probe',
      status: 'failed',
      error: 'MCP client for `broken-probe` failed to start: No such file or directory (os error 2)'
    })
    const item = items(r)[0]
    expect(item.type).toBe('error')
    expect(item).toMatchObject({ type: 'error' })
    expect((item as Extract<ChatItem, { type: 'error' }>).text).toContain('broken-probe')
    expect((item as Extract<ChatItem, { type: 'error' }>).text).toContain('No such file')
    expect(r.persist).toHaveLength(1)
  })

  // 실측으로 서버 하나가 같은 failed 를 두 번 보냈다.
  it('같은 실패를 두 번 보여 주지 않는다', () => {
    const state = createMapperState()
    const params = { name: 'srv', status: 'failed', error: 'boom' }
    expect(map(NOTIFY.mcpStartupStatus, params, state).events).toHaveLength(1)
    expect(map(NOTIFY.mcpStartupStatus, params, state).events).toEqual([])
  })

  it('재인증이 원인이면 무엇을 해야 하는지 덧붙인다', () => {
    const r = map(NOTIFY.mcpStartupStatus, {
      name: 'srv',
      status: 'failed',
      error: 'unauthorized',
      failureReason: 'reauthenticationRequired'
    })
    expect((items(r)[0] as Extract<ChatItem, { type: 'error' }>).text).toContain('Sign in')
  })

  it('오류 문구가 비어도 카드는 남긴다', () => {
    const r = map(NOTIFY.mcpStartupStatus, { name: 'srv', status: 'failed', error: null })
    expect((items(r)[0] as Extract<ChatItem, { type: 'error' }>).text).toContain('did not start')
  })
})

describe('MCP 호출 진행 메시지', () => {
  /** 진행 알림에는 도구 이름도 인자도 없다 — 시작 스냅샷과 합쳐야 카드가 지워지지 않는다. */
  function withStartedCall(state: MapperState): void {
    map(
      NOTIFY.itemStarted,
      {
        item: {
          id: 'i1',
          type: 'mcpToolCall',
          server: 'github',
          tool: 'search',
          arguments: { q: 'wooi' }
        }
      },
      state
    )
  }

  it('진행 메시지가 와도 도구 이름과 인자를 잃지 않는다', () => {
    const state = createMapperState()
    withStartedCall(state)
    const r = map(NOTIFY.mcpToolProgress, { itemId: 'i1', message: 'Fetching page 3…' }, state)
    const item = items(r)[0] as Extract<ChatItem, { type: 'tool_use' }>
    expect(item.name).toBe('mcp__github__search')
    expect(item.input).toMatchObject({ q: 'wooi', progress: 'Fetching page 3…' })
    // 진행 스냅샷은 화면에만 — 확정 아이템이 뒤이어 트랜스크립트에 남는다.
    expect(r.persist).toEqual([])
  })

  // 이름 없는 카드를 새로 만드는 것보다 버리는 편이 낫다.
  it('시작을 못 본 itemId 는 조용히 버린다', () => {
    expect(map(NOTIFY.mcpToolProgress, { itemId: 'ghost', message: 'hi' }).events).toEqual([])
  })

  it('호출이 끝나면 스냅샷을 놓아 준다', () => {
    const state = createMapperState()
    withStartedCall(state)
    map(NOTIFY.itemCompleted, { item: { id: 'i1', type: 'mcpToolCall', result: 'ok' } }, state)
    expect(map(NOTIFY.mcpToolProgress, { itemId: 'i1', message: 'late' }, state).events).toEqual([])
  })
})

describe('패치 갱신', () => {
  it('item/fileChange/patchUpdated 는 카드를 최신 내용으로 다시 그린다', () => {
    const r = map(NOTIFY.fileChangePatchUpdated, {
      threadId: 'thr_1',
      turnId: 't1',
      itemId: 'i9',
      changes: [{ path: 'src/a.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@' }]
    })
    const item = items(r)[0] as Extract<ChatItem, { type: 'tool_use' }>
    expect(item.name).toBe('Apply patch')
    expect(item.input).toMatchObject({ paths: ['src/a.ts'] })
    // 아직 확정이 아니므로 트랜스크립트에는 남기지 않는다.
    expect(r.persist).toEqual([])
  })

  it('변경이 비면 아무것도 하지 않는다', () => {
    expect(map(NOTIFY.fileChangePatchUpdated, { itemId: 'i9', changes: [] }).events).toEqual([])
  })
})

describe('사용자 훅', () => {
  it('hook/started 는 진행 카드를 띄우되 트랜스크립트에는 남기지 않는다', () => {
    const r = map(NOTIFY.hookStarted, {
      threadId: 'thr_1',
      run: { id: 'h1', eventName: 'preToolUse', status: 'running', executionMode: 'sync' }
    })
    const item = items(r)[0] as Extract<ChatItem, { type: 'system' }>
    expect(item.type).toBe('system')
    expect(item.text).toContain('preToolUse')
    expect(r.persist).toEqual([])
  })

  // 시작과 완료가 같은 id 를 쓰므로 카드 한 장이 갱신된다(두 장 쌓이지 않는다).
  it('완료 카드가 시작 카드를 덮어쓴다', () => {
    const started = map(NOTIFY.hookStarted, { run: { id: 'h1', eventName: 'stop' } })
    const completed = map(NOTIFY.hookCompleted, {
      run: { id: 'h1', eventName: 'stop', status: 'completed', durationMs: 12 }
    })
    expect(items(started)[0].id).toBe(items(completed)[0].id)
  })

  // 훅이 매 턴 도는 것이 정상이라, 성공까지 남기면 트랜스크립트가 훅 로그가 된다.
  it('정상 종료는 트랜스크립트에 남기지 않는다', () => {
    const r = map(NOTIFY.hookCompleted, {
      run: { id: 'h1', eventName: 'postToolUse', status: 'completed', durationMs: 40 }
    })
    expect(items(r)[0].type).toBe('system')
    expect(r.persist).toEqual([])
  })

  it('턴을 막은 훅은 에러로 남기고 훅 출력을 싣는다', () => {
    const r = map(NOTIFY.hookCompleted, {
      run: {
        id: 'h2',
        eventName: 'preToolUse',
        status: 'blocked',
        entries: [{ kind: 'stderr', text: 'denied: rm -rf is not allowed' }]
      }
    })
    const item = items(r)[0] as Extract<ChatItem, { type: 'error' }>
    expect(item.type).toBe('error')
    expect(item.text).toContain('blocked')
    expect(item.text).toContain('rm -rf is not allowed')
    expect(r.persist).toHaveLength(1)
  })

  it('run 이 없으면 아무것도 하지 않는다', () => {
    expect(map(NOTIFY.hookCompleted, { threadId: 'thr_1' }).events).toEqual([])
  })
})

describe('guardian 경고', () => {
  it('guardianWarning 은 문구 그대로 보여 준다', () => {
    const r = map(NOTIFY.guardianWarning, { threadId: 'thr_1', message: 'Careful with that.' })
    expect(items(r)[0]).toMatchObject({ type: 'system', text: 'Careful with that.' })
    expect(r.persist).toHaveLength(1)
  })

  it('메시지가 없으면 빈 카드를 만들지 않는다', () => {
    expect(map(NOTIFY.guardianWarning, { threadId: 'thr_1' }).events).toEqual([])
  })
})

describe('guardian 승인 auto-review', () => {
  it('시작과 완료가 같은 modest 카드로 upsert 된다', () => {
    const started = map(NOTIFY.guardianApprovalReviewStarted, {
      threadId: 'thr_1',
      reviewId: 'review_1',
      targetItemId: 'item_1',
      startedAtMs: 100,
      action: { type: 'command', command: 'npm test', cwd: '/repo', source: 'shell' },
      review: { status: 'inProgress' }
    })
    expect(items(started)[0]).toMatchObject({
      id: 'codex:guardian-review:review_1',
      type: 'system',
      text: expect.stringContaining('auto-reviewing')
    })
    expect(started.persist).toEqual([])

    const completed = map(NOTIFY.guardianApprovalReviewCompleted, {
      threadId: 'thr_1',
      reviewId: 'review_1',
      targetItemId: 'item_1',
      startedAtMs: 100,
      completedAtMs: 150,
      review: { status: 'approved', riskLevel: 'low', rationale: 'Read-only command.' },
      action: { type: 'command', command: 'npm test', cwd: '/repo', source: 'shell' },
      decisionSource: 'guardian'
    })
    const item = items(completed)[0] as Extract<ChatItem, { type: 'system' }>
    expect(item.id).toBe('codex:guardian-review:review_1')
    expect(item.text).toContain('approved')
    expect(item.text).toContain('Risk: low')
    expect(item.text).toContain('Read-only command.')
    expect(completed.persist).toHaveLength(1)
  })

  it('불안정한 상세 필드가 없거나 예상 밖 모양이어도 lifecycle 은 매핑한다', () => {
    expect(() =>
      map(NOTIFY.guardianApprovalReviewStarted, {
        reviewId: 'review_sparse',
        targetItemId: null,
        startedAtMs: 100
      })
    ).not.toThrow()

    const completed = map(NOTIFY.guardianApprovalReviewCompleted, {
      reviewId: 'review_sparse',
      targetItemId: null,
      startedAtMs: 100,
      completedAtMs: 200,
      review: ['changed upstream'],
      action: 'changed upstream',
      decisionSource: { type: 'changed upstream' }
    })
    expect(items(completed)[0]).toMatchObject({
      id: 'codex:guardian-review:review_sparse',
      type: 'system',
      text: 'Codex auto-review completed.'
    })
  })
})

/**
 * 서버가 idle 을 직접 알려 주지만 `turn/completed` 와 같은 밀리초에 온다(실측). 둘 다 옮기면
 * 완료 이벤트가 두 번 나가고 매니저가 완료음을 두 번 울린다 — 그래서 일부러 매핑하지 않는다.
 */
describe('thread/status/changed 는 의도적으로 매핑하지 않는다', () => {
  it('idle 을 받아도 상태 이벤트를 내지 않는다', () => {
    const r = map('thread/status/changed', { threadId: 'thr_1', status: { type: 'idle' } })
    expect(r.events).toEqual([])
    expect(r.persist).toEqual([])
  })
})
