import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '@shared/types'

let userData = ''

vi.mock('electron', () => ({
  app: { getPath: (): string => userData }
}))

beforeAll(() => {
  userData = mkdtempSync(join(tmpdir(), 'wooi-transcripts-test-'))
})

afterAll(() => {
  rmSync(userData, { recursive: true, force: true })
})

const result = (id: string, costUsd: number): ChatItem =>
  ({ id, type: 'result', ts: 1, costUsd }) as ChatItem

const assistant = (id: string): ChatItem =>
  ({ id, type: 'assistant', ts: 1, text: '내용' }) as ChatItem

const user = (id: string, text: string): ChatItem => ({ id, type: 'user', ts: 1, text }) as ChatItem

/**
 * 비용은 화면에 숫자 하나로 나오지만, 예전에는 그걸 위해 대화 전체가 렌더러로 넘어가 매 토큰마다
 * 다시 합산됐다. 이제 메인이 증분으로 들고 있으므로, 그 증분이 실제 기록과 어긋나지 않아야 한다.
 */
describe('TranscriptStore.costOf', () => {
  it('result 항목의 비용만 더한다', async () => {
    const { getTranscripts } = await import('./transcripts')
    const t = getTranscripts()
    t.upsert('ws-1', assistant('a1'))
    t.upsert('ws-1', result('r1', 0.25))
    t.upsert('ws-1', assistant('a2'))
    t.upsert('ws-1', result('r2', 0.5))

    expect(t.costOf('ws-1')).toBeCloseTo(0.75)
  })

  it('같은 result 가 갱신되면 더하지 않고 덮어쓴다', async () => {
    const { getTranscripts } = await import('./transcripts')
    const t = getTranscripts()
    t.costOf('ws-2') // 집계를 시작시킨다(이 시점 이후의 upsert 가 증분으로 반영된다)
    t.upsert('ws-2', result('r1', 0.1))
    t.upsert('ws-2', result('r1', 0.4))

    expect(t.costOf('ws-2')).toBeCloseTo(0.4)
  })

  /**
   * 앱을 껐다 켜면 집계는 비어 있고 기록만 남는다 — 그때 파일에서 다시 세어도 같은 값이어야
   * 한다. 증분 경로와 재적재 경로가 갈리면, 재시작 때마다 비용이 바뀌어 보인다.
   */
  it('집계를 처음 물어보면 기록에서 세어 낸다', async () => {
    const { getTranscripts } = await import('./transcripts')
    const t = getTranscripts()
    t.upsert('ws-3', result('r1', 0.2))
    t.upsert('ws-3', result('r2', 0.3))
    const incremental = t.costOf('ws-3')

    // 새 인스턴스에는 집계가 없다 — 파일만 보고 같은 값을 내야 한다.
    vi.resetModules()
    const fresh = await import('./transcripts')
    expect(fresh.getTranscripts().costOf('ws-3')).toBeCloseTo(incremental)
  })

  it('비용이 없는 대화는 0 이다', async () => {
    const { getTranscripts } = await import('./transcripts')
    const t = getTranscripts()
    t.upsert('ws-4', assistant('a1'))
    expect(t.costOf('ws-4')).toBe(0)
  })

  it('워크스페이스를 지우면 집계도 사라진다', async () => {
    const { getTranscripts } = await import('./transcripts')
    const t = getTranscripts()
    t.upsert('ws-5', result('r1', 1.5))
    expect(t.costOf('ws-5')).toBeCloseTo(1.5)
    t.remove('ws-5')
    expect(t.costOf('ws-5')).toBe(0)
  })
})

describe('TranscriptStore.copy', () => {
  it('원본과 같은 기록을 읽되 이후 갱신은 서로 독립적이다', async () => {
    const { getTranscripts } = await import('./transcripts')
    const t = getTranscripts()
    t.upsert('copy-source', assistant('a1'))
    t.upsert('copy-source', result('r1', 0.2))

    t.copy('copy-source', 'copy-target')

    expect(t.load('copy-target')).toEqual(t.load('copy-source'))
    t.upsert('copy-source', assistant('source-only'))
    t.upsert('copy-target', assistant('target-only'))
    expect(t.load('copy-target').map((item) => item.id)).not.toContain('source-only')
    expect(t.load('copy-source').map((item) => item.id)).not.toContain('target-only')
  })

  it('원본 기록이 없으면 조용히 아무것도 만들지 않는다', async () => {
    const { getTranscripts } = await import('./transcripts')
    const t = getTranscripts()
    expect(() => t.copy('copy-missing', 'copy-missing-target')).not.toThrow()
    expect(t.load('copy-missing-target')).toEqual([])
  })

  it('목적지의 캐시와 비용을 버리고 복사한 파일에서 다시 계산한다', async () => {
    const { getTranscripts } = await import('./transcripts')
    const t = getTranscripts()
    t.upsert('copy-fresh-source', result('fresh', 0.75))
    t.upsert('copy-stale-target', result('stale', 9))
    expect(t.costOf('copy-stale-target')).toBe(9)

    t.copy('copy-fresh-source', 'copy-stale-target')

    expect(t.load('copy-stale-target')).toEqual(t.load('copy-fresh-source'))
    expect(t.costOf('copy-stale-target')).toBeCloseTo(0.75)
  })
})

/**
 * 렌더러는 대화를 뒤에서부터 한 페이지씩 읽는다 — 며칠 이어 쓴 워크스페이스의 첫 페인트가
 * 대화 전체를 이고 가지 않게 하기 위해서다. 그 창을 만드는 쪽이 여기다.
 */
describe('TranscriptStore.loadTail', () => {
  it('최근 limit 개만 순서 그대로 돌려준다', async () => {
    const { getTranscripts } = await import('./transcripts')
    const t = getTranscripts()
    for (let i = 0; i < 10; i++) t.upsert('ws-tail', assistant(`a${i}`))

    expect(t.loadTail('ws-tail', 3).map((item) => item.id)).toEqual(['a7', 'a8', 'a9'])
  })

  it('가진 것보다 많이 요청하면 전부 준다 — 이 "적게 왔다" 가 곧 더 없다는 신호다', async () => {
    const { getTranscripts } = await import('./transcripts')
    const t = getTranscripts()
    for (let i = 0; i < 4; i++) t.upsert('ws-short', assistant(`a${i}`))

    expect(t.loadTail('ws-short', 300)).toHaveLength(4)
  })

  it('없는 워크스페이스는 빈 배열이다', async () => {
    const { getTranscripts } = await import('./transcripts')
    expect(getTranscripts().loadTail('ws-none', 300)).toEqual([])
  })

  it('같은 id 가 갱신된 뒤에도 꼬리는 합쳐진 결과 기준이다', async () => {
    const { getTranscripts } = await import('./transcripts')
    const t = getTranscripts()
    for (let i = 0; i < 5; i++) t.upsert('ws-merge', assistant(`a${i}`))
    t.upsert('ws-merge', { ...assistant('a0'), text: '고쳐 쓴 내용' } as ChatItem)

    // 같은 id 의 마지막 줄이 이기되 첫 등장 순서를 지키므로 개수는 그대로다.
    expect(t.loadTail('ws-merge', 5)).toHaveLength(5)
    expect(t.loadTail('ws-merge', 2).map((item) => item.id)).toEqual(['a3', 'a4'])
  })
})

/**
 * /rewind 의 대화 되돌리기는 append 로 굴러가던 파일에서 처음으로 "지운다" 를 요구한다.
 * 캐시만 자르고 파일을 안 자르면 앱을 다시 켰을 때 되돌린 대화가 되살아난다.
 */
describe('TranscriptStore.truncateFrom', () => {
  it('그 항목부터 뒤를 버리고, 버린 것을 돌려준다', async () => {
    const { getTranscripts } = await import('./transcripts')
    const t = getTranscripts()
    t.upsert('ws-cut', user('u1', '첫 메시지'))
    t.upsert('ws-cut', assistant('a1'))
    t.upsert('ws-cut', user('u2', '둘째 메시지'))
    t.upsert('ws-cut', assistant('a2'))

    const dropped = t.truncateFrom('ws-cut', 'u2')

    expect(dropped.map((i) => i.id)).toEqual(['u2', 'a2'])
    expect(t.load('ws-cut').map((i) => i.id)).toEqual(['u1', 'a1'])
  })

  it('디스크에도 반영된다 — 다시 읽어도 되살아나지 않는다', async () => {
    vi.resetModules()
    const { getTranscripts } = await import('./transcripts')
    const t = getTranscripts()
    t.upsert('ws-cut2', user('u1', '남을 메시지'))
    t.upsert('ws-cut2', user('u2', '버릴 메시지'))
    t.truncateFrom('ws-cut2', 'u2')

    // 캐시를 통째로 버리고 파일에서 다시 읽는다.
    vi.resetModules()
    const fresh = await import('./transcripts')
    expect(
      fresh
        .getTranscripts()
        .load('ws-cut2')
        .map((i) => i.id)
    ).toEqual(['u1'])
  })

  it('버린 턴의 비용은 집계에서 빠진다', async () => {
    const { getTranscripts } = await import('./transcripts')
    const t = getTranscripts()
    t.upsert('ws-cut3', user('u1', '첫 메시지'))
    t.upsert('ws-cut3', result('r1', 0.25))
    t.upsert('ws-cut3', user('u2', '둘째 메시지'))
    t.upsert('ws-cut3', result('r2', 0.5))
    expect(t.costOf('ws-cut3')).toBeCloseTo(0.75)

    t.truncateFrom('ws-cut3', 'u2')

    expect(t.costOf('ws-cut3')).toBeCloseTo(0.25)
  })

  it('없는 항목이면 아무것도 건드리지 않는다', async () => {
    const { getTranscripts } = await import('./transcripts')
    const t = getTranscripts()
    t.upsert('ws-cut4', user('u1', '유일한 메시지'))

    expect(t.truncateFrom('ws-cut4', 'nope')).toEqual([])
    expect(t.load('ws-cut4').map((i) => i.id)).toEqual(['u1'])
  })
})
