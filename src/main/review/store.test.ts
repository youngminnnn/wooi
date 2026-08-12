import { describe, it, expect } from 'vitest'
import type { ReviewActivityItem, ReviewDiff, ReviewFileDiff, ReviewFinding } from '@shared/types'
import { fileDiffHash, isFileViewed, viewedFilePaths } from '@shared/reviewViewed'
import { __test } from './store'

const { parseJsonl, toBundle, serialize, DIFF_ID, diffId, viewedId } = __test

const DIFF: ReviewDiff = { files: [] }

function fileDiff(path: string, text = 'a'): ReviewFileDiff {
  return {
    path,
    oldPath: null,
    status: 'modified',
    additions: 1,
    deletions: 0,
    binary: false,
    hunks: [
      {
        header: '@@ -1 +1 @@',
        rows: [{ kind: 'add', text, oldLine: null, newLine: 1 }]
      }
    ]
  }
}

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
    expect(b.diffs.map((d) => d.diff)).toEqual([DIFF])
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
    expect(b.diffs).toHaveLength(1)
    expect(b.diffs[0].diff.files).toHaveLength(1)
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
    expect(b).toEqual({ diffs: [], findings: [], activity: [], viewed: {} })
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

describe('파일 봤음 표시', () => {
  const A = fileDiff('a.ts')

  it('표시를 켜고 끄기를 되풀이해도 마지막 줄이 이긴다', () => {
    const id = viewedId('a.ts')
    const hash = fileDiffHash(A)
    const text = jsonl(
      { id, rec: 'file-viewed', path: 'a.ts', hash },
      { id, rec: 'file-unviewed', path: 'a.ts' },
      { id, rec: 'file-viewed', path: 'a.ts', hash }
    )
    expect(toBundle(parseJsonl(text)).viewed).toEqual({ 'a.ts': hash })

    // 마지막이 해제면 표시가 남지 않는다.
    const off = text + jsonl({ id, rec: 'file-unviewed', path: 'a.ts' })
    expect(toBundle(parseJsonl(off)).viewed).toEqual({})
  })

  /** 이 방식의 존재 이유 — 새 커밋으로 파일이 바뀌면 리셋 코드 없이 표시가 풀려야 한다. */
  it('내용이 바뀌면 남아 있는 표시를 무시한다', () => {
    const b = toBundle(
      parseJsonl(
        jsonl({ id: viewedId('a.ts'), rec: 'file-viewed', path: 'a.ts', hash: fileDiffHash(A) })
      )
    )
    expect(isFileViewed(b.viewed, A)).toBe(true)

    const changed = fileDiff('a.ts', 'a changed')
    expect(isFileViewed(b.viewed, changed)).toBe(false)
    expect(viewedFilePaths(b.viewed, [{ files: [changed] }])).toEqual(new Set())
  })

  it('경로가 같아도 다른 파일의 표시는 서로 건드리지 않는다', () => {
    const B = fileDiff('b.ts')
    const text = jsonl(
      { id: viewedId('a.ts'), rec: 'file-viewed', path: 'a.ts', hash: fileDiffHash(A) },
      { id: viewedId('b.ts'), rec: 'file-viewed', path: 'b.ts', hash: fileDiffHash(B) },
      { id: viewedId('a.ts'), rec: 'file-unviewed', path: 'a.ts' }
    )
    expect(viewedFilePaths(toBundle(parseJsonl(text)).viewed, [{ files: [A, B] }])).toEqual(
      new Set(['b.ts'])
    )
  })

  /** toBundle 주석이 경고하는 함정 — 종류를 안 가리면 새 레코드가 활동 타임라인에 샌다. */
  it('viewed 레코드가 활동 타임라인에 섞이지 않는다', () => {
    const text = jsonl(
      { id: 'a1', rec: 'activity', item: turn('a1', 'hello') },
      { id: viewedId('a.ts'), rec: 'file-viewed', path: 'a.ts', hash: fileDiffHash(A) },
      { id: viewedId('b.ts'), rec: 'file-unviewed', path: 'b.ts' }
    )
    const b = toBundle(parseJsonl(text))
    expect(b.activity.map((a) => a.id)).toEqual(['a1'])
    expect(b.findings).toEqual([])
  })

  it('손상된 줄이 섞여도 나머지 표시를 살린다', () => {
    const text =
      jsonl({ id: viewedId('a.ts'), rec: 'file-viewed', path: 'a.ts', hash: fileDiffHash(A) }) +
      '{"id":"viewed:b.ts","rec":"file-vie\n' +
      jsonl({ id: 'f1', rec: 'finding', finding: finding('f1') })
    const b = toBundle(parseJsonl(text))
    expect(b.viewed).toEqual({ 'a.ts': fileDiffHash(A) })
    expect(b.findings.map((f) => f.id)).toEqual(['f1'])
  })

  /**
   * 지문은 main(저장)과 렌더러(표시)가 각자 계산한다 — 같은 내용이면 반드시 같은 값이어야
   * 하고, 조금이라도 달라지면 달라져야 한다.
   */
  it('지문은 내용에만 달려 있다', () => {
    expect(fileDiffHash(fileDiff('a.ts'))).toBe(fileDiffHash(fileDiff('b.ts')))
    expect(fileDiffHash(A)).not.toBe(fileDiffHash(fileDiff('a.ts', 'a ')))

    // 바이너리는 hunks 가 비어 있어 hunks 만 보면 무엇이 바뀌어도 같은 값이 나온다.
    const bin = (additions: number): ReviewFileDiff => ({
      ...fileDiff('img.png'),
      binary: true,
      hunks: [],
      additions
    })
    expect(fileDiffHash(bin(1))).not.toBe(fileDiffHash(bin(2)))
  })
})

describe('레이어별 diff', () => {
  const A = { ...DIFF, files: [{ ...DIFF.files[0], path: 'a.ts' }] }
  const B = { ...DIFF, files: [{ ...DIFF.files[0], path: 'b.ts' }] }

  it('레이어마다 자기 레코드를 갖고 순서를 지킨다', () => {
    const b = toBundle(
      parseJsonl(
        jsonl(
          { id: diffId(12), rec: 'diff', diff: A, prNumber: 12 },
          { id: diffId(13), rec: 'diff', diff: B, prNumber: 13 }
        )
      )
    )
    expect(b.diffs.map((d) => d.prNumber)).toEqual([12, 13])
  })

  it('같은 레이어를 다시 받으면 그 레이어만 덮어쓴다', () => {
    const b = toBundle(
      parseJsonl(
        jsonl(
          { id: diffId(12), rec: 'diff', diff: A, prNumber: 12 },
          { id: diffId(13), rec: 'diff', diff: A, prNumber: 13 },
          { id: diffId(13), rec: 'diff', diff: B, prNumber: 13 }
        )
      )
    )
    expect(b.diffs).toHaveLength(2)
    expect(b.diffs[1].diff.files[0].path).toBe('b.ts')
  })

  /**
   * 옛 리뷰를 다시 돌리면 번호 없는 레코드와 번호 있는 레코드가 함께 남는다. 둘을 별개로 두면
   * 같은 파일이 화면에 두 벌 그려진다 — 옛 리뷰는 레이어가 하나뿐이므로 대체가 맞다.
   */
  it('번호 없는 옛 레코드는 번호 붙은 레코드가 대체한다', () => {
    const b = toBundle(
      parseJsonl(
        jsonl(
          { id: DIFF_ID, rec: 'diff', diff: A },
          { id: diffId(12), rec: 'diff', diff: B, prNumber: 12 }
        )
      )
    )
    expect(b.diffs).toHaveLength(1)
    expect(b.diffs[0]).toEqual({ prNumber: 12, diff: B })
  })
})
