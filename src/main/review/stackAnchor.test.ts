import { describe, it, expect } from 'vitest'
import { parseReviewDiff, resolveStackAnchor } from './diff'
import type { ReviewFindingInput, ReviewLayerDiff } from '@shared/types'

/**
 * 스택 앵커링 — 이 기능에서 **틀렸을 때 가장 비싼** 부분이다.
 *
 * 잘못된 PR 에 인라인 코멘트를 걸면 GitHub 이 422 로 거절하는 것이 그나마 나은 경우다. 스택에서는
 * 같은 경로·같은 줄 번호가 여러 레이어에 존재하는 일이 흔해서, 요청이 **성공하고 엉뚱한 PR 에
 * 조용히 달릴** 수 있다. 그러면 리뷰어도 작성자도 알아채지 못한다. 아래 테스트가 지키는 규칙은
 * 전부 그 실패 모드를 겨냥한 것이다.
 */

function layer(prNumber: number, path: string, lines: string[]): ReviewLayerDiff {
  const body = lines.map((l) => `+${l}`).join('\n')
  const raw = [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body,
    ''
  ].join('\n')
  return { prNumber: prNumber, diff: parseReviewDiff(raw) }
}

const inline = (over: Partial<ReviewFindingInput>): ReviewFindingInput => ({
  severity: 'minor',
  title: 't',
  body: 'b',
  side: 'RIGHT',
  ...over
})

describe('resolveStackAnchor', () => {
  it('레이어가 하나면 PR 번호를 묻지 않고 그 레이어로 푼다', () => {
    const layers = [layer(12, 'a.ts', ['one', 'two'])]
    const { anchor } = resolveStackAnchor(layers, inline({ file: 'a.ts', line: 2 }))
    expect(anchor).toMatchObject({ prNumber: 12, file: 'a.ts', line: 2, side: 'RIGHT' })
  })

  it('에이전트가 지목한 PR 안에서 푼다', () => {
    const layers = [layer(12, 'a.ts', ['one', 'two']), layer(13, 'b.ts', ['x', 'y'])]
    const { anchor } = resolveStackAnchor(layers, inline({ prNumber: 13, file: 'b.ts', line: 1 }))
    expect(anchor).toMatchObject({ prNumber: 13, file: 'b.ts', line: 1 })
  })

  /**
   * 이 테스트가 이 파일의 핵심이다 — 지목한 레이어에 없다고 옆 레이어를 뒤지면, 같은 경로를
   * 가진 다른 PR 에 그럴듯하게 달린 코멘트가 나온다. 차라리 강등해서 사용자가 보게 한다.
   */
  it('지목한 PR 에 없으면 다른 레이어로 흘러가지 않고 강등된다', () => {
    const layers = [layer(12, 'a.ts', ['one', 'two']), layer(13, 'a.ts', ['one', 'two'])]
    const { anchor, reason } = resolveStackAnchor(
      layers,
      // #12 의 a.ts 는 두 줄뿐이다. #13 에도 같은 파일이 있지만 거기로 새면 안 된다.
      inline({ prNumber: 12, file: 'a.ts', line: 40 })
    )
    expect(anchor).toBeNull()
    expect(reason).toContain('a.ts')
  })

  it('스택에 없는 PR 을 지목하면 강등한다', () => {
    const layers = [layer(12, 'a.ts', ['one'])]
    const { anchor, reason } = resolveStackAnchor(
      [...layers, layer(13, 'b.ts', ['x'])],
      inline({ prNumber: 99, file: 'a.ts', line: 1 })
    )
    expect(anchor).toBeNull()
    expect(reason).toContain('#99')
  })

  it('PR 번호가 없어도 그 경로를 가진 레이어가 하나면 찾아낸다', () => {
    const layers = [layer(12, 'a.ts', ['one', 'two']), layer(13, 'b.ts', ['x', 'y'])]
    const { anchor } = resolveStackAnchor(layers, inline({ file: 'b.ts', line: 2 }))
    expect(anchor).toMatchObject({ prNumber: 13, file: 'b.ts', line: 2 })
  })

  /** 스택에서 같은 파일을 여러 층이 건드리는 것은 예외가 아니라 흔한 일이다. */
  it('여러 레이어가 같은 파일을 건드렸어도 그 줄이 한 곳에만 있으면 그쪽으로 간다', () => {
    const layers = [
      layer(12, 'store.ts', ['a', 'b']),
      // 위 레이어는 같은 파일의 더 아래쪽을 건드린다.
      { prNumber: 13, diff: parseReviewDiff(SHIFTED) }
    ]
    const { anchor } = resolveStackAnchor(layers, inline({ file: 'store.ts', line: 41 }))
    expect(anchor).toMatchObject({ prNumber: 13, line: 41 })
  })

  it('여러 레이어에 같은 줄이 있으면 찍지 않고 강등한다', () => {
    const layers = [layer(12, 'store.ts', ['a', 'b']), layer(13, 'store.ts', ['a', 'b'])]
    const { anchor, reason } = resolveStackAnchor(layers, inline({ file: 'store.ts', line: 1 }))
    expect(anchor).toBeNull()
    expect(reason).toContain('#12')
    expect(reason).toContain('#13')
  })

  it('어느 레이어에도 없는 파일은 강등한다', () => {
    const layers = [layer(12, 'a.ts', ['one'])]
    const { anchor, reason } = resolveStackAnchor(layers, inline({ file: 'ghost.ts', line: 1 }))
    expect(anchor).toBeNull()
    expect(reason).toContain('ghost.ts')
  })

  /** 스냅은 편의 기능이지 레이어를 넘나드는 근거가 아니다. */
  it('스냅은 지목한 레이어 안에서만 일어난다', () => {
    const layers = [layer(12, 'a.ts', ['1', '2', '3', '4', '5']), layer(13, 'a.ts', ['x'])]
    const { anchor } = resolveStackAnchor(layers, inline({ prNumber: 12, file: 'a.ts', line: 7 }))
    expect(anchor).toMatchObject({ prNumber: 12, line: 5, snappedFrom: 7 })
  })

  it('파일도 줄도 없으면 애초에 인라인이 아니다', () => {
    const { anchor, reason } = resolveStackAnchor([layer(12, 'a.ts', ['one'])], inline({}))
    expect(anchor).toBeNull()
    expect(reason).toBeNull()
  })
})

/** #13 이 store.ts 의 40번째 줄 언저리를 건드리는 diff — #12 의 1~2번 줄과 겹치지 않는다. */
const SHIFTED = `diff --git a/store.ts b/store.ts
index 1111111..2222222 100644
--- a/store.ts
+++ b/store.ts
@@ -40,2 +40,3 @@
 keep
+added
 tail
`
