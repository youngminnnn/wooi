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
