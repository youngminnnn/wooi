import { describe, it, expect } from 'vitest'
import { buildFindings } from './manager'
import { parseReviewDiff } from './diff'
import type { ReviewArtifact, ReviewLayerDiff } from '@shared/types'

/**
 * 지적이 **어느 PR 로 가는가**를 정하는 자리. 인라인은 앵커가 정하고, 전반 지적은 에이전트가
 * 지목한 레이어가, 스택 지적은 그것이 관련짓는 가장 아래 레이어가 정한다.
 */

function layer(prNumber: number, path: string, lines: number): ReviewLayerDiff {
  const body = Array.from({ length: lines }, (_, i) => `+l${i + 1}`).join('\n')
  const raw = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines} @@`,
    body,
    ''
  ].join('\n')
  return { prNumber, diff: parseReviewDiff(raw) }
}

const artifact = (over: Partial<ReviewArtifact>): ReviewArtifact => ({
  summary: '',
  reply: '',
  general: [],
  inline: [],
  stack: [],
  layers: [],
  updates: [],
  discards: [],
  ...over
})

const LAYERS = [{ prNumber: 12 }, { prNumber: 13 }, { prNumber: 14 }]
const DIFFS = [layer(12, 'a.ts', 3), layer(13, 'b.ts', 3), layer(14, 'c.ts', 3)]

describe('buildFindings — 인라인', () => {
  it('앵커가 확정한 PR 을 지적에도 남긴다', () => {
    const [f] = buildFindings(
      DIFFS,
      artifact({
        inline: [
          {
            severity: 'major',
            title: 't',
            body: 'b',
            prNumber: 13,
            file: 'b.ts',
            line: 2,
            side: 'RIGHT'
          }
        ]
      }),
      LAYERS
    )
    expect(f.anchor).toMatchObject({ prNumber: 13, file: 'b.ts', line: 2 })
    expect(f.prNumber).toBe(13)
  })

  /** 위치를 못 찾았다고 리뷰 내용까지 버리면, 사용자는 무엇을 놓쳤는지도 모른다. */
  it('앵커에 실패하면 버리지 않고 전반 지적으로 강등하며 원래 위치를 본문에 남긴다', () => {
    const [f] = buildFindings(
      DIFFS,
      artifact({
        inline: [
          {
            severity: 'major',
            title: 't',
            body: 'real content',
            prNumber: 13,
            file: 'b.ts',
            line: 900,
            side: 'RIGHT'
          }
        ]
      }),
      LAYERS
    )
    expect(f.anchor).toBeNull()
    expect(f.body).toContain('real content')
    expect(f.body).toContain('#13 b.ts:900')
    // 강등돼도 어디에 올릴지는 정해져야 한다.
    expect(f.prNumber).toBe(13)
  })
})

describe('buildFindings — 스택 지적', () => {
  it('가장 아래 레이어에 올리고, 관련 레이어를 순서대로 남긴다', () => {
    const [f] = buildFindings(
      DIFFS,
      artifact({
        stack: [
          {
            severity: 'major',
            title: 'Layer 13 depends on 14',
            body: 'Move the helper down.',
            // 모델이 순서를 뒤섞어 줘도 스택 순서로 다시 세운다.
            stackPrNumbers: [14, 13]
          }
        ]
      }),
      LAYERS
    )
    expect(f.stackPrNumbers).toEqual([13, 14])
    expect(f.prNumber).toBe(13)
  })

  /**
   * 게시된 코멘트는 PR 하나의 타임라인에 홀로 놓인다. 스택 전체에 대한 말이라는 사실이 본문에
   * 없으면 받는 쪽은 그 PR 하나에 대한 지적으로 읽는다.
   */
  it('본문 앞에 어느 레이어들에 대한 말인지 박는다', () => {
    const [f] = buildFindings(
      DIFFS,
      artifact({
        stack: [
          { severity: 'major', title: 't', body: 'Fold these together.', stackPrNumbers: [12, 13] }
        ]
      }),
      LAYERS
    )
    expect(f.body).toBe('**Stack review** · #12 → #13\n\nFold these together.')
  })

  /** 모델이 이 리뷰에 없는 번호를 지어내면 게시 대상이 사라진다 — 걸러 내고 맨 위로 떨어뜨린다. */
  it('스택에 없는 PR 번호는 무시한다', () => {
    const [f] = buildFindings(
      DIFFS,
      artifact({
        stack: [{ severity: 'minor', title: 't', body: 'b', stackPrNumbers: [99, 13] }]
      }),
      LAYERS
    )
    expect(f.stackPrNumbers).toEqual([13])
    expect(f.prNumber).toBe(13)
  })

  it('관련 레이어를 하나도 못 주면 맨 위로 떨어진다', () => {
    const [f] = buildFindings(
      DIFFS,
      artifact({ stack: [{ severity: 'minor', title: 't', body: 'b' }] }),
      LAYERS
    )
    expect(f.prNumber).toBe(14)
    expect(f.stackPrNumbers).toBeUndefined()
    // 붙일 레이어를 모르면 머리글도 붙이지 않는다 — 빈 화살표는 아무 정보가 아니다.
    expect(f.body).toBe('b')
  })
})

describe('buildFindings — 전반 지적', () => {
  it('에이전트가 지목한 레이어로 간다', () => {
    const [f] = buildFindings(
      DIFFS,
      artifact({ general: [{ severity: 'minor', title: 't', body: 'b', prNumber: 12 }] }),
      LAYERS
    )
    expect(f.prNumber).toBe(12)
  })

  it('레이어를 안 주면 맨 위로 간다', () => {
    const [f] = buildFindings(
      DIFFS,
      artifact({ general: [{ severity: 'minor', title: 't', body: 'b' }] }),
      LAYERS
    )
    expect(f.prNumber).toBe(14)
  })
})
