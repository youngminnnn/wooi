import { describe, it, expect } from 'vitest'
import type { ReviewActivityItem, ReviewDiff, ReviewFinding } from '@shared/types'
import { __test } from './store'

const { parseJsonl, toBundle, serialize, DIFF_ID } = __test

const DIFF: ReviewDiff = { files: [] }

function finding(id: string, title = id): ReviewFinding {
  return { id, severity: 'minor', title, body: 'b', anchor: null }
}

function turn(id: string, text: string): ReviewActivityItem {
  return { id, kind: 'turn', role: 'user', text, ts: 1 }
}

/** 실제 파일 내용을 흉내 낸다 — 레코드를 줄 단위로 이어 붙인 것. */
function jsonl(...recs: Parameters<typeof serialize>[0][]): string {
  return recs.map(serialize).join('')
}

describe('사이드카 JSONL', () => {
  it('diff·지적·활동을 번들로 되살린다', () => {
    const text = jsonl(
      { id: DIFF_ID, rec: 'diff', diff: DIFF },
      { id: 'f1', rec: 'finding', finding: finding('f1') },
      { id: 'a1', rec: 'activity', item: turn('a1', 'hello') }
    )
    const b = toBundle(parseJsonl(text))
    expect(b.diff).toEqual(DIFF)
    expect(b.findings.map((f) => f.id)).toEqual(['f1'])
    expect(b.activity.map((a) => a.id)).toEqual(['a1'])
  })

  /**
   * append 기반 upsert 의 핵심 — 같은 id 를 다시 쓰면 갱신이고, 위치는 첫 등장 자리를 지킨다.
   * 순서가 흔들리면 활동 타임라인의 시간 순서가 뒤섞인다.
   */
  it('같은 id 는 마지막 줄이 이기고 첫 등장 순서를 지킨다', () => {
    const text = jsonl(
      { id: 'f1', rec: 'finding', finding: finding('f1', 'old') },
      { id: 'f2', rec: 'finding', finding: finding('f2') },
      { id: 'f1', rec: 'finding', finding: finding('f1', 'new') }
    )
    const b = toBundle(parseJsonl(text))
    expect(b.findings.map((f) => f.id)).toEqual(['f1', 'f2'])
    expect(b.findings[0].title).toBe('new')
  })

  it('새 diff 를 덧붙이면 이전 diff 를 덮어쓴다', () => {
    const next: ReviewDiff = {
      files: [
        {
          path: 'a.ts',
          oldPath: null,
          status: 'modified',
          additions: 1,
          deletions: 0,
          binary: false,
          hunks: []
        }
      ]
    }
    const b = toBundle(
      parseJsonl(
        jsonl({ id: DIFF_ID, rec: 'diff', diff: DIFF }, { id: DIFF_ID, rec: 'diff', diff: next })
      )
    )
    expect(b.diff?.files).toHaveLength(1)
  })

  /** 크래시 도중 반쪽만 쓰인 줄이 남을 수 있다 — 그 한 줄 때문에 기록 전체를 잃으면 안 된다. */
  it('손상된 줄은 건너뛰고 나머지를 살린다', () => {
    const text =
      jsonl({ id: 'f1', rec: 'finding', finding: finding('f1') }) +
      '{"id":"f2","rec":"find\n' +
      jsonl({ id: 'f3', rec: 'finding', finding: finding('f3') })
    const b = toBundle(parseJsonl(text))
    expect(b.findings.map((f) => f.id)).toEqual(['f1', 'f3'])
  })

  it('빈 내용은 빈 번들', () => {
    const b = toBundle(parseJsonl(''))
    expect(b).toEqual({ diff: null, findings: [], activity: [] })
  })

  it('id 없는 줄은 무시한다', () => {
    const b = toBundle(parseJsonl('{"rec":"finding"}\n{"foo":1}\n'))
    expect(b.findings).toEqual([])
  })

  /** 버린 지적은 같은 id 의 묘비로 덮어쓴다 — append 전용 파일을 다시 쓰지 않기 위함이다. */
  it('묘비가 같은 id 의 지적을 목록에서 지운다', () => {
    const text = jsonl(
      { id: 'f1', rec: 'finding', finding: finding('f1') },
      { id: 'f2', rec: 'finding', finding: finding('f2') },
      { id: 'f1', rec: 'finding-dismissed' }
    )
    const b = toBundle(parseJsonl(text))
    expect(b.findings.map((f) => f.id)).toEqual(['f2'])
    // 묘비가 활동 타임라인으로 새면 빈 항목이 화면에 뜬다.
    expect(b.activity).toEqual([])
  })

  it('버린 뒤 같은 id 로 다시 들어오면 되살아난다 — 순서는 첫 등장 자리', () => {
    const text = jsonl(
      { id: 'f1', rec: 'finding', finding: finding('f1') },
      { id: 'f2', rec: 'finding', finding: finding('f2') },
      { id: 'f1', rec: 'finding-dismissed' },
      { id: 'f1', rec: 'finding', finding: finding('f1', 'back') }
    )
    const b = toBundle(parseJsonl(text))
    expect(b.findings.map((f) => f.title)).toEqual(['back', 'f2'])
  })
})
