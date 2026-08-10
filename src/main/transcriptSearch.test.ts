import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { searchTranscripts } from './transcriptSearch'
import type { ChatItem } from '@shared/types'

let dir = ''

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wooi-search-test-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const user = (id: string, text: string, ts = 1): ChatItem => ({ id, type: 'user', text, ts })
const assistant = (id: string, text: string, ts = 1): ChatItem =>
  ({ id, type: 'assistant', text, ts }) as ChatItem

/** JSONL 파일을 쓴다. 문자열을 그대로 넘기면(손상된 줄 흉내) 그 줄이 날것으로 들어간다. */
function writeTranscript(workspaceId: string, lines: (ChatItem | string)[]): void {
  const body = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n'
  writeFileSync(join(dir, `${workspaceId}.jsonl`), body)
}

const search = (
  query: string,
  workspaceIds: string[],
  opts?: { maxHits?: number; maxPerWorkspace?: number }
) => searchTranscripts({ dir, workspaceIds, query, ...opts })

describe('searchTranscripts', () => {
  it('대소문자를 가리지 않고 찾는다', async () => {
    writeTranscript('case', [user('u1', 'We picked PostgreSQL for the queue')])

    const upper = await search('POSTGRESQL', ['case'])
    const lower = await search('postgresql', ['case'])

    expect(upper.hits.map((h) => h.itemId)).toEqual(['u1'])
    expect(lower.hits.map((h) => h.itemId)).toEqual(['u1'])
  })

  it('여러 워크스페이스에 걸쳐 찾고, 최근 매치가 있는 쪽을 앞에 둔다', async () => {
    writeTranscript('older', [user('a1', 'the retry budget decision', 100)])
    writeTranscript('newer', [assistant('b1', 'Revisiting the retry budget', 500)])

    const res = await search('retry budget', ['older', 'newer'])

    expect(res.hits.map((h) => `${h.workspaceId}:${h.itemId}`)).toEqual(['newer:b1', 'older:a1'])
    expect(res.scanned).toBe(2)
    expect(res.truncated).toBe(false)
  })

  /**
   * JSONL 은 append-only 라 같은 id 의 갱신이 새 줄로 쌓인다. 검색이 last-wins 를 따르지 않으면
   * 이미 고쳐 쓴 옛 내용이 결과로 잡혀, 눌러 들어가면 그 문구가 화면에 없는 상태가 된다.
   */
  it('갱신된 항목은 옛 내용으로 잡히지 않는다', async () => {
    writeTranscript('lastwins', [
      assistant('s1', 'draft: use Redis for sessions'),
      assistant('s1', 'final: use Postgres for sessions')
    ])

    const stale = await search('Redis', ['lastwins'])
    const current = await search('Postgres', ['lastwins'])

    expect(stale.hits).toEqual([])
    expect(current.hits.map((h) => h.itemId)).toEqual(['s1'])
    expect(current.hits[0].snippet).toContain('final:')
  })

  it('스트리밍 중 매치한 항목이 뒤에서 갱신돼도 마지막 내용만 남는다', async () => {
    writeTranscript('growing', [
      assistant('s1', 'the sharding plan'),
      user('u1', 'unrelated'),
      assistant('s1', 'the sharding plan, revised twice'),
      assistant('s1', 'the sharding plan, revised twice and finalized')
    ])

    const res = await search('sharding', ['growing'])

    expect(res.hits).toHaveLength(1)
    expect(res.hits[0].snippet).toContain('finalized')
  })

  it('손상된 줄이 섞여 있어도 나머지를 읽는다', async () => {
    writeTranscript('broken', [
      user('u1', 'first mention of kafka'),
      '{"id":"u2","type":"user","text":"partial appen', // 크래시 중 잘린 줄
      '',
      'not json at all',
      user('u3', 'second mention of kafka')
    ])

    const res = await search('kafka', ['broken'])

    expect(res.hits.map((h) => h.itemId)).toEqual(['u1', 'u3'])
  })

  it('결과 상한에 걸리면 truncated 로 알린다', async () => {
    writeTranscript(
      'many',
      Array.from({ length: 30 }, (_, i) => user(`m${i}`, `budget line ${i}`))
    )

    const capped = await search('budget', ['many'], { maxHits: 5, maxPerWorkspace: 5 })
    const roomy = await search('budget', ['many'], { maxHits: 50, maxPerWorkspace: 50 })

    expect(capped.hits).toHaveLength(5)
    expect(capped.truncated).toBe(true)
    expect(roomy.hits).toHaveLength(30)
    expect(roomy.truncated).toBe(false)
  })

  it('전체 상한을 채우면 남은 워크스페이스는 훑지 않고 그 사실을 알린다', async () => {
    writeTranscript('full', [user('f1', 'quota note'), user('f2', 'quota note again')])
    writeTranscript('unseen', [user('x1', 'quota note elsewhere')])

    const res = await search('quota', ['full', 'unseen'], { maxHits: 2, maxPerWorkspace: 2 })

    expect(res.hits.map((h) => h.workspaceId)).toEqual(['full', 'full'])
    expect(res.scanned).toBe(1)
    expect(res.skipped).toBe(1)
    expect(res.truncated).toBe(true)
  })

  it('워크스페이스 하나가 결과를 독점하지 않는다', async () => {
    writeTranscript(
      'chatty',
      Array.from({ length: 10 }, (_, i) => user(`c${i}`, `throttle ${i}`, 900))
    )
    writeTranscript('quiet', [user('q1', 'throttle once', 100)])

    const res = await search('throttle', ['chatty', 'quiet'], { maxPerWorkspace: 3 })

    expect(res.hits.filter((h) => h.workspaceId === 'chatty')).toHaveLength(3)
    expect(res.hits.filter((h) => h.workspaceId === 'quiet')).toHaveLength(1)
    expect(res.truncated).toBe(true)
  })

  it('스니펫은 매치 주변만 담고 하이라이트 위치를 함께 준다', async () => {
    const padding = 'x'.repeat(400)
    writeTranscript('snip', [user('s1', `${padding}\n  needle  \n${padding}`)])

    const [hit] = (await search('needle', ['snip'])).hits

    expect(hit.snippet.length).toBeLessThan(250)
    expect(hit.snippet.startsWith('…')).toBe(true)
    expect(hit.snippet.endsWith('…')).toBe(true)
    expect(hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength)).toBe('needle')
  })

  it('도구 호출은 이름과 대상 경로로도 찾힌다', async () => {
    writeTranscript('tools', [
      {
        id: 't1',
        type: 'tool_use',
        toolId: 'x',
        name: 'Edit',
        input: { file_path: 'src/main/auth.ts' },
        ts: 1
      } as ChatItem
    ])

    const res = await search('auth.ts', ['tools'])

    expect(res.hits.map((h) => h.itemId)).toEqual(['t1'])
    expect(res.hits[0].kind).toBe('tool_use')
  })

  it('빈 질의는 아무것도 훑지 않는다', async () => {
    writeTranscript('idle', [user('i1', 'anything')])

    const res = await search('   ', ['idle'])

    expect(res).toEqual({ hits: [], truncated: false, scanned: 0, skipped: 0 })
  })

  it('기록이 없는 워크스페이스는 조용히 건너뛴다', async () => {
    const res = await search('anything', ['no-such-workspace'])

    expect(res.hits).toEqual([])
    expect(res.scanned).toBe(1)
  })

  /** 한 번도 연 적 없어 .jsonl 로 마이그레이션되지 않은 옛 기록도 검색에 걸려야 한다. */
  it('레거시 JSON 배열 기록도 훑는다', async () => {
    writeFileSync(join(dir, 'legacy.json'), JSON.stringify([user('l1', 'the old migration note')]))

    const res = await search('migration', ['legacy'])

    expect(res.hits.map((h) => h.itemId)).toEqual(['l1'])
  })
})
