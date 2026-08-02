import { describe, it, expect } from 'vitest'
import type { ReviewProgressItem } from '@shared/types'
import { createCodexReader, strictSchema } from './runCodex'
import { coerceArtifact } from './artifact'
import { REVIEW_OUTPUT_SCHEMA } from './prompt'

/**
 * `codex exec --json` 의 JSONL 을 읽는 부분만 떼어 검증한다.
 *
 * 픽스처는 실제 codex CLI 출력을 그대로 옮긴 것이다 — 이 스키마는 우리가 정하지 않으므로,
 * 필드 이름을 추측으로 바꾸면 조용히 아무 진행 상황도 안 보이는 리뷰가 된다.
 */

function read(lines: string[]): {
  out: ReturnType<typeof createCodexReader>['out']
  progress: ReviewProgressItem[]
} {
  const progress: ReviewProgressItem[] = []
  const r = createCodexReader((item) => progress.push(item))
  for (const l of lines) r.push(`${l}\n`)
  r.end()
  return { out: r.out, progress }
}

const THREAD = '{"type":"thread.started","thread_id":"019fc329-208c-7b63-b17c-d941701d7d58"}'
const ARTIFACT = JSON.stringify({
  type: 'item.completed',
  item: {
    id: 'item_2',
    type: 'agent_message',
    text: JSON.stringify({ summary: 'Looks good.', general: [], inline: [] })
  }
})

describe('codex exec JSONL 읽기', () => {
  it('thread id 를 잡는다 — 후속 턴을 resume 할 유일한 열쇠다', () => {
    expect(read([THREAD]).out.threadId).toBe('019fc329-208c-7b63-b17c-d941701d7d58')
  })

  it('구조화된 agent_message 를 결과로 삼고 진행 로그에는 흘리지 않는다', () => {
    const { out, progress } = read([THREAD, ARTIFACT])
    expect(out.artifact?.summary).toBe('Looks good.')
    expect(progress).toEqual([])
    // JSON 은 사용자에게 보여 줄 말이 아니다.
    expect(out.rawText).toBe('')
  })

  it('마지막 구조화 메시지가 이긴다(중간 경과도 JSON 으로 온다)', () => {
    const first = JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: JSON.stringify({ summary: 'Reading…' }) }
    })
    expect(read([THREAD, first, ARTIFACT]).out.artifact?.summary).toBe('Looks good.')
  })

  it('JSON 이 아닌 agent_message 는 사용자에게 보여 줄 말로 취급한다', () => {
    const plain = JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: 'I could not finish.' }
    })
    const { out, progress } = read([plain])
    expect(out.rawText.trim()).toBe('I could not finish.')
    expect(progress[0]).toMatchObject({ kind: 'text', text: 'I could not finish.' })
  })

  it('명령 실행을 진행 로그 한 줄로 줄인다', () => {
    const started = JSON.stringify({
      type: 'item.started',
      item: {
        id: 'item_1',
        type: 'command_execution',
        command: "/bin/zsh -lc 'ls package.json'",
        status: 'in_progress'
      }
    })
    const { progress } = read([started])
    expect(progress).toHaveLength(1)
    expect(progress[0]).toMatchObject({ kind: 'tool', text: "$ /bin/zsh -lc 'ls package.json'" })
  })

  // 항목 하나가 started·completed 로 두 번 온다. 그대로 두면 진행 로그가 전부 겹쳐 보인다.
  it('같은 항목의 started·completed 를 한 번만 남긴다', () => {
    const item = {
      id: 'item_1',
      type: 'command_execution',
      command: 'ls',
      status: 'completed'
    }
    const { progress } = read([
      JSON.stringify({ type: 'item.started', item }),
      JSON.stringify({ type: 'item.completed', item })
    ])
    expect(progress).toHaveLength(1)
  })

  it('청크 중간에서 끊긴 줄을 이어 붙인다', () => {
    const progress: ReviewProgressItem[] = []
    const r = createCodexReader((item) => progress.push(item))
    r.push(THREAD.slice(0, 20))
    r.push(`${THREAD.slice(20)}\n`)
    r.end()
    expect(r.out.threadId).toBe('019fc329-208c-7b63-b17c-d941701d7d58')
  })

  it('마지막 줄에 개행이 없어도 읽는다', () => {
    const progress: ReviewProgressItem[] = []
    const r = createCodexReader((item) => progress.push(item))
    r.push(ARTIFACT)
    r.end()
    expect(r.out.artifact?.summary).toBe('Looks good.')
  })

  it('JSONL 이 아닌 줄은 조용히 버린다', () => {
    const { out } = read(['Reading prompt from stdin...', THREAD])
    expect(out.error).toBeNull()
    expect(out.threadId).not.toBeNull()
  })

  it('턴 실패를 에러로 올린다', () => {
    const failed = JSON.stringify({ type: 'turn.failed', error: { message: 'usage limit hit' } })
    const { out, progress } = read([THREAD, failed])
    expect(out.error).toBe('usage limit hit')
    expect(progress[0]).toMatchObject({ kind: 'error' })
  })

  it('reasoning 처럼 보여 줄 것이 없는 항목은 진행 로그를 더럽히지 않는다', () => {
    const reasoning = JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_3', type: 'reasoning', text: 'thinking about the diff' }
    })
    expect(read([reasoning]).progress).toEqual([])
  })
})

/**
 * `--output-schema` 는 Responses API 의 strict json_schema 로 그대로 넘어간다. 규칙을 어기면
 * 리뷰가 시작하자마자 400 으로 죽는데(실제로 `startLine` 때문에 죽었다) 그 실패는 유닛
 * 테스트가 아니라 실행 중에만 드러난다 — 그래서 규칙 자체를 여기서 못 박아 둔다.
 */
describe('strictSchema', () => {
  type Node = Record<string, unknown>

  function eachObject(node: unknown, visit: (o: Node) => void): void {
    if (Array.isArray(node)) {
      for (const n of node) eachObject(n, visit)
      return
    }
    if (!node || typeof node !== 'object') return
    visit(node as Node)
    for (const value of Object.values(node as Node)) eachObject(value, visit)
  }

  const strict = strictSchema(REVIEW_OUTPUT_SCHEMA) as Node
  const props = strict.properties as Node
  const inlineItem = (props.inline as Node).items as Node

  it('중첩된 곳까지 properties 의 모든 키를 required 에 올린다', () => {
    eachObject(strict, (o) => {
      if (!o.properties || typeof o.properties !== 'object') return
      expect(o.required).toEqual(Object.keys(o.properties as Node))
    })
  })

  it('원래 선택이던 필드는 null 을 허용해 안 낼 자유를 남긴다', () => {
    expect((props.reply as Node).type).toEqual(['string', 'null'])
    expect(((inlineItem.properties as Node).startLine as Node).type).toEqual(['integer', 'null'])
  })

  it('원래 필수이던 필드의 타입과 나머지 키는 그대로 둔다', () => {
    expect((props.summary as Node).type).toBe('string')
    const severity = (inlineItem.properties as Node).severity as Node
    expect(severity.type).toBe('string')
    expect(severity.enum).toContain('blocker')
    expect(inlineItem.additionalProperties).toBe(false)
  })

  it('원본 스키마는 건드리지 않는다 — Claude 쪽은 이 제약이 없다', () => {
    expect(REVIEW_OUTPUT_SCHEMA.required).not.toContain('reply')
  })

  it('codex 가 null 로 채워 보낸 선택 필드는 없는 값으로 읽힌다', () => {
    // 실제 codex 응답을 그대로 옮긴 것이다.
    const artifact = coerceArtifact({
      summary: 'The PR looks fine.',
      reply: null,
      general: [],
      inline: [
        {
          file: 'a.ts',
          side: 'RIGHT',
          line: 3,
          startLine: null,
          severity: 'nit',
          title: 't',
          body: 'b'
        }
      ]
    })
    expect(artifact?.reply).toBe('')
    expect(artifact?.inline[0]).not.toHaveProperty('startLine')
    expect(artifact?.inline[0].line).toBe(3)
  })
})
