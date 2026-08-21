import { describe, it, expect } from 'vitest'
import {
  buildFollowUpPrompt,
  buildResumePrompt,
  buildReviewPrompt,
  crossLayerFiles,
  renderFindingInventory,
  reviewOutputSchema
} from './prompt'
import type { PromptFinding, ReviewPromptLayer } from './prompt'
import { parseReviewDiff } from './diff'
import type { ReviewLayerDiff } from '@shared/types'

function fileDiff(path: string, lines: number): string {
  const body = Array.from({ length: lines }, (_, i) => `+line ${i + 1}`).join('\n')
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines} @@`,
    body,
    ''
  ].join('\n')
}

function layerDiff(prNumber: number, files: Array<[string, number]>): ReviewLayerDiff {
  return { prNumber, diff: parseReviewDiff(files.map(([p, n]) => fileDiff(p, n)).join('')) }
}

function promptLayer(number: number, over: Partial<ReviewPromptLayer> = {}): ReviewPromptLayer {
  return {
    number,
    title: `Layer ${number}`,
    baseRefName: 'main',
    headRefName: `feat/${number}`,
    headSha: 'abcdef1234567890',
    localRef: `refs/wooi/review/r1/pr-${number}`,
    baseRef: 'origin/main',
    ...over
  }
}

describe('crossLayerFiles', () => {
  /** 여러 층이 만진 파일이 곧 "나중 층이 앞선 층을 되돌렸나" 라는 질문의 후보다. */
  it('여러 레이어가 건드린 경로만 아래→위 순서로 모은다', () => {
    const diffs = [
      layerDiff(12, [
        ['store.ts', 2],
        ['a.ts', 2]
      ]),
      layerDiff(13, [
        ['store.ts', 2],
        ['b.ts', 2]
      ]),
      layerDiff(14, [['store.ts', 2]])
    ]
    expect(crossLayerFiles(diffs)).toEqual([{ path: 'store.ts', prNumbers: [12, 13, 14] }])
  })

  it('한 레이어만 건드린 파일은 나오지 않는다', () => {
    expect(crossLayerFiles([layerDiff(12, [['a.ts', 1]])])).toEqual([])
  })
})

describe('buildReviewPrompt — 단일 PR', () => {
  const meta = { layers: [promptLayer(12)] }
  const diffs = [layerDiff(12, [['a.ts', 3]])]

  /** 스택 절이 통째로 빠져야 흔한 단일 PR 리뷰가 예전과 같은 프롬프트를 받는다. */
  it('스택 관련 절을 넣지 않는다', () => {
    const { text } = buildReviewPrompt({ userPrompt: 'Review this.', meta, diffs })
    expect(text).toContain('You are reviewing GitHub pull request #12')
    expect(text).not.toContain('What a stack review is for')
    expect(text).not.toContain('prNumber')
  })

  it('파일 헤더에 PR 번호를 붙이지 않는다', () => {
    const { text } = buildReviewPrompt({ userPrompt: 'x', meta, diffs })
    expect(text).toContain('=== a.ts (modified)')
    expect(text).not.toContain('[#12]')
  })

  it('사용자 프롬프트가 맨 앞에 온다', () => {
    const { text } = buildReviewPrompt({ userPrompt: 'Look at the retry loop.', meta, diffs })
    expect(text.startsWith('Look at the retry loop.')).toBe(true)
  })
})

describe('buildReviewPrompt — 스택', () => {
  const meta = {
    layers: [
      promptLayer(12),
      promptLayer(13, { baseRef: 'refs/wooi/review/r1/pr-12' }),
      promptLayer(14, { baseRef: 'refs/wooi/review/r1/pr-13' })
    ]
  }
  const diffs = [
    layerDiff(12, [['store.ts', 3]]),
    layerDiff(13, [
      ['store.ts', 3],
      ['b.ts', 3]
    ]),
    layerDiff(14, [['c.ts', 3]])
  ]
  const built = buildReviewPrompt({ userPrompt: 'Review this stack.', meta, diffs })

  it('N 개의 리뷰가 아니라 하나의 리뷰라고 말한다', () => {
    expect(built.text).toContain('stack of 3 pull requests')
    expect(built.text).toContain('not 3 separate reviews')
  })

  it('스택에서만 나올 수 있는 질문들을 딜리버러블로 세운다', () => {
    for (const q of ['Ordering', 'Independence', 'Invalidation', 'Granularity', 'Churn']) {
      expect(built.text).toContain(q)
    }
  })

  it('골격에 레이어별 파일 목록과 로컬 ref 를 싣는다', () => {
    expect(built.text).toContain('Layer 1 of 3 — PR #12')
    expect(built.text).toContain('refs: origin/main...refs/wooi/review/r1/pr-12')
    // 위 레이어의 base 는 아래 레이어의 ref 여야 한다 — 아니면 아래 변경이 섞여 나온다.
    expect(built.text).toContain('refs: refs/wooi/review/r1/pr-12...refs/wooi/review/r1/pr-13')
  })

  it('여러 레이어가 건드린 파일을 표로 뽑아 준다', () => {
    expect(built.text).toContain('Files touched by more than one layer')
    expect(built.text).toContain('store.ts  —  #12, #13')
  })

  it('파일 헤더마다 PR 번호를 박아 앵커를 셀 필요를 없앤다', () => {
    expect(built.text).toContain('=== [#12] store.ts')
    expect(built.text).toContain('=== [#13] store.ts')
    expect(built.text).toContain('=== [#14] c.ts')
  })

  it('예산 안에 다 들어가면 잘린 파일이 없다', () => {
    expect(built.truncatedFiles).toBe(0)
    expect(built.text).not.toContain('did not fit in the prompt')
  })
})

describe('buildReviewPrompt — 컨텍스트 예산', () => {
  /**
   * 조용히 자르지 않는 것이 규칙이다. 60% 만 보고 "괜찮아 보인다" 고 말하는 리뷰보다,
   * 무엇을 못 봤는지 말하는 리뷰가 낫다.
   */
  it('예산을 넘긴 파일은 이름과 읽는 방법을 남긴다', () => {
    const huge: Array<[string, number]> = [
      ['big-a.ts', 40_000],
      ['big-b.ts', 40_000],
      ['big-c.ts', 40_000]
    ]
    const meta = { layers: [promptLayer(12), promptLayer(13)] }
    const diffs = [layerDiff(12, huge), layerDiff(13, huge)]
    const built = buildReviewPrompt({ userPrompt: 'x', meta, diffs })

    expect(built.truncatedFiles).toBeGreaterThan(0)
    expect(built.text).toContain('did not fit in the prompt')
    expect(built.text).toContain('git diff origin/main...refs/wooi/review/r1/pr-12 -- <path>')
  })

  /** 골격은 잘리지 않는다 — 스택 질문의 답이 대부분 거기서 나온다. */
  it('diff 를 못 실어도 레이어 목록과 파일 이름은 전부 남는다', () => {
    const huge: Array<[string, number]> = [['big.ts', 200_000]]
    const meta = { layers: [promptLayer(12), promptLayer(13)] }
    const built = buildReviewPrompt({
      userPrompt: 'x',
      meta,
      diffs: [layerDiff(12, huge), layerDiff(13, huge)]
    })
    expect(built.text).toContain('Layer 1 of 2 — PR #12')
    expect(built.text).toContain('Layer 2 of 2 — PR #13')
    expect(built.text).toContain('big.ts  (modified')
  })

  /** 큰 레이어가 작은 레이어를 통째로 밀어내면 그 층은 리뷰되지 않은 것이나 마찬가지다. */
  it('작은 레이어도 자기 몫을 받는다', () => {
    const meta = { layers: [promptLayer(12), promptLayer(13)] }
    const built = buildReviewPrompt({
      userPrompt: 'x',
      meta,
      diffs: [layerDiff(12, [['huge.ts', 120_000]]), layerDiff(13, [['tiny.ts', 3]])]
    })
    expect(built.text).toContain('=== [#13] tiny.ts')
  })
})

describe('reviewOutputSchema', () => {
  const props = (s: Record<string, unknown>): Record<string, unknown> =>
    s.properties as Record<string, unknown>

  it('단일 PR 은 스택 필드를 요구하지 않는다', () => {
    const s = reviewOutputSchema(1)
    expect(s.required).toEqual(['summary', 'general', 'inline'])
    expect(props(s)).not.toHaveProperty('stack')
    expect(props(s)).not.toHaveProperty('layers')
  })

  /** 번호가 없으면 같은 경로·줄을 가진 다른 레이어에 코멘트가 갈 수 있다 — 필수로 올린다. */
  it('스택은 인라인 지적에 PR 번호를 요구한다', () => {
    const s = reviewOutputSchema(3)
    const inline = props(s).inline as Record<string, unknown>
    const items = inline.items as Record<string, unknown>
    expect(items.required).toContain('prNumber')
    expect(s.required).toContain('stack')
    expect(s.required).toContain('layers')
  })

  /** 일부 스키마 강제 구현이 ["integer","null"] 을 거부한다 — 선택은 required 에서 빼는 것으로만. */
  it('nullable union 을 쓰지 않는다', () => {
    const seen: unknown[] = []
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk)
      if (!node || typeof node !== 'object') return
      const o = node as Record<string, unknown>
      if (Array.isArray(o.type)) seen.push(o.type)
      Object.values(o).forEach(walk)
    }
    walk(reviewOutputSchema(3))
    expect(seen).toEqual([])
  })

  it('reply 는 어느 쪽에서도 필수가 아니다(최초 리뷰에는 답할 것이 없다)', () => {
    expect(reviewOutputSchema(1).required).not.toContain('reply')
    expect(reviewOutputSchema(3).required).not.toContain('reply')
  })
})

describe('buildResumePrompt', () => {
  /**
   * 이어서 돌리는 프롬프트의 일은 두 가지뿐이다 — 끊긴 것이지 그만둔 것이 아님을 알리고,
   * 원래 무엇을 부탁받았는지 되짚어 주는 것.
   */
  it('끊긴 턴을 마저 끝내라고 지시하고 최초 프롬프트를 그대로 싣는다', () => {
    const text = buildResumePrompt('Look for race conditions.', [])

    expect(text).toContain('interrupted')
    expect(text).toContain('Look for race conditions.')
    expect(text).toContain('Do not redo work you already completed')
    // diff 를 다시 싣지 않는다 — resume 로 앞선 대화를 그대로 이어받는다.
    expect(text).not.toContain('diff --git')
  })

  it('멈춰 있는 동안 벌어진 일이 있으면 함께 알린다', () => {
    const text = buildResumePrompt('Review this.', ['@someone replied on a.ts:12:\nfixed'])

    expect(text).toContain('What happened while you were stopped')
    expect(text).toContain('@someone replied')
  })
})

describe('renderFindingInventory', () => {
  const pending: PromptFinding = {
    handle: 'a1b2c3d4',
    severity: 'major',
    title: 'Race between save and load',
    where: 'src/main/store.ts:42',
    state: 'pending',
    locked: false
  }
  const posted: PromptFinding = {
    handle: 'e5f6a7b8',
    severity: 'nit',
    title: 'Typo in the comment',
    where: 'general',
    state: 'posted · resolved',
    locked: true
  }

  it('핸들·자리·상태를 한 줄에 싣는다 — 셋이 다 있어야 지목할 수 있다', () => {
    const text = renderFindingInventory([pending])
    expect(text).toContain('[a1b2c3d4]')
    expect(text).toContain('src/main/store.ts:42')
    expect(text).toContain('pending')
    expect(text).toContain('Race between save and load')
  })

  /** 게시된 것을 고쳐 쓰라고 시키면 지시가 통째로 무시된다 — 시키기 전에 말려야 한다. */
  it('게시된 지적이 있으면 손댈 수 없다고 못 박는다', () => {
    const text = renderFindingInventory([pending, posted])
    expect(text).toMatch(/cannot be rewritten or withdrawn/)
  })

  it('게시된 것이 없으면 그 경고를 붙이지 않는다', () => {
    expect(renderFindingInventory([pending])).not.toMatch(/cannot be rewritten/)
  })

  it('지적이 없으면 아무것도 싣지 않는다', () => {
    expect(renderFindingInventory([])).toBe('')
  })
})

describe('buildFollowUpPrompt', () => {
  it('사용자의 말이 맨 앞에 온다 — 프롬프트의 주제를 정하는 것은 그쪽이다', () => {
    expect(buildFollowUpPrompt('다시 봐줘', [])).toMatch(/^다시 봐줘/)
  })

  it('지적 목록이 있으면 고쳐 쓰기·거둬들이기를 안내한다', () => {
    const text = buildFollowUpPrompt(
      '다시 봐줘',
      [],
      [
        {
          handle: 'a1b2c3d4',
          severity: 'major',
          title: 'Race',
          where: 'a.ts:1',
          state: 'pending',
          locked: false
        }
      ]
    )
    expect(text).toContain('[a1b2c3d4]')
    expect(text).toMatch(/discards/)
    expect(text).toMatch(/updates/)
  })

  it('지적이 없으면 목록 절을 통째로 뺀다', () => {
    expect(buildFollowUpPrompt('질문 하나', [])).not.toMatch(/Findings you have already reported/)
  })
})

describe('reviewOutputSchema — 고쳐 쓰기 칸', () => {
  const propsOf = (n: number): Record<string, { items?: { required?: string[] } }> =>
    reviewOutputSchema(n).properties as Record<string, { items?: { required?: string[] } }>

  /** 단일 PR 리뷰야말로 "고쳤으니 다시 봐줘" 가 가장 흔한 자리다. */
  it('단일 PR 리뷰에도 updates·discards 칸이 있다', () => {
    expect(propsOf(1).updates).toBeTruthy()
    expect(propsOf(1).discards).toBeTruthy()
  })

  /** 질문 하나에 답하는 턴까지 두 칸을 채우게 만들면 모델이 없는 지시를 지어낸다. */
  it('둘 다 required 가 아니다', () => {
    for (const n of [1, 3]) {
      expect(reviewOutputSchema(n).required).not.toContain('updates')
      expect(reviewOutputSchema(n).required).not.toContain('discards')
    }
  })

  it('거둬들이기는 이유를 요구한다 — 이유 없이 사라지면 되짚을 근거가 없다', () => {
    expect(propsOf(1).discards.items?.required).toEqual(['id', 'reason'])
  })
})
