import { describe, expect, it } from 'vitest'
import { MAX_DIFF_CHARACTERS, MAX_DIFF_LINES_PER_SIDE, diffRenderLimit } from './diffRenderLimit'

const SMALL = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1
-const b = 2
+const b = 3
+const c = 4
`

/** 문맥 없이 추가 줄만 있는 patch — 줄 수 상한을 넘기는 가장 싼 방법. */
function additions(count: number): string {
  return `@@ -0,0 +1,${count} @@\n${Array.from({ length: count }, (_, i) => `+line ${i}`).join('\n')}\n`
}

describe('diffRenderLimit', () => {
  it('평범한 patch 는 통과시킨다', () => {
    expect(diffRenderLimit(SMALL)).toEqual({ limited: false })
  })

  it('빈 patch 도 통과시킨다', () => {
    expect(diffRenderLimit('')).toEqual({ limited: false })
  })

  // 머리말을 세면 잘게 쪼개진 브랜치가 이유 없이 막힌다 — 화면에 행으로 그려지는 것만 센다.
  it('파일 머리말은 어느 면에도 세지 않는다', () => {
    const preambleOnly = `diff --git a/a b/a
index 1111111..2222222 100644
old mode 100644
new mode 100755
--- a/a
+++ b/a
`.repeat(MAX_DIFF_LINES_PER_SIDE)
    expect(diffRenderLimit(preambleOnly).limited).toBe(false)
  })

  // `+++`/`---` 는 hunk 안의 추가/삭제 줄이 아니다. 붙여 세면 파일마다 한 줄씩 부풀어 오른다.
  it('머리말 뒤에 hunk 가 이어져도 본문만 센다', () => {
    const limit = diffRenderLimit(`${SMALL}${additions(MAX_DIFF_LINES_PER_SIDE - 3)}`)
    expect(limit.limited).toBe(false)
  })

  it('한쪽 면이 상한을 넘으면 줄 수를 이유로 막는다', () => {
    const limit = diffRenderLimit(additions(MAX_DIFF_LINES_PER_SIDE + 1))
    if (!limit.limited) throw new Error('expected the patch to be limited')
    expect(limit.reason).toBe('lines')
    expect(limit.limits.maxLinesPerSide).toBe(MAX_DIFF_LINES_PER_SIDE)
  })

  // 카드가 "8,259+" 로 적을 수 있어야 한다 — 세다 멈춘 값을 정확한 값인 척하면 안 된다.
  it('세다 멈추면 양쪽 다 최소값으로 표시한다', () => {
    const limit = diffRenderLimit(additions(MAX_DIFF_LINES_PER_SIDE * 3))
    if (!limit.limited) throw new Error('expected the patch to be limited')
    expect(limit.modified.atLeast).toBe(true)
    expect(limit.original.atLeast).toBe(true)
    // 상한을 갓 넘긴 지점에서 멈췄지, 끝까지 세지 않았다.
    expect(limit.modified.lines).toBe(MAX_DIFF_LINES_PER_SIDE + 1)
  })

  it('줄 수가 넉넉해도 문자 수가 넘으면 막는다', () => {
    // 최소화된 번들 한 줄 — 줄 수 상한으로는 절대 못 잡는 모양.
    const patch = `@@ -0,0 +1 @@\n+${'x'.repeat(MAX_DIFF_CHARACTERS + 1)}\n`
    const limit = diffRenderLimit(patch)
    if (!limit.limited) throw new Error('expected the patch to be limited')
    expect(limit.reason).toBe('characters')
    expect(limit.characters).toBe(patch.length)
    expect(limit.modified).toEqual({ lines: 1, atLeast: false })
    expect(limit.limits.maxCharacters).toBe(MAX_DIFF_CHARACTERS)
  })

  it('상한과 정확히 같은 값은 통과시킨다', () => {
    expect(diffRenderLimit(additions(MAX_DIFF_LINES_PER_SIDE)).limited).toBe(false)
    expect(diffRenderLimit('x'.repeat(MAX_DIFF_CHARACTERS)).limited).toBe(false)
  })

  // 삭제만 있는 patch 는 수정 면이 비어 있다 — 원본 면 하나만으로도 걸려야 한다.
  it('원본 면만 커도 막는다', () => {
    const count = MAX_DIFF_LINES_PER_SIDE + 1
    const patch = `@@ -1,${count} +0,0 @@\n${Array.from({ length: count }, (_, i) => `-line ${i}`).join('\n')}\n`
    const limit = diffRenderLimit(patch)
    if (!limit.limited) throw new Error('expected the patch to be limited')
    expect(limit.reason).toBe('lines')
    expect(limit.original.atLeast).toBe(true)
  })

  it('문맥 줄은 양쪽 면에 모두 센다', () => {
    const limit = diffRenderLimit(`@@ -1,2 +1,2 @@\n context\n-old\n+new\n`)
    // limited: false 일 때는 숫자를 내보내지 않으므로, 문맥이 양쪽에 세지는지는 상한 근처에서 본다.
    expect(limit.limited).toBe(false)
    const context = Array.from({ length: MAX_DIFF_LINES_PER_SIDE + 1 }, () => ' same').join('\n')
    const big = diffRenderLimit(`@@ -1,1 +1,1 @@\n${context}\n`)
    if (!big.limited) throw new Error('expected the patch to be limited')
    expect(big.original.atLeast).toBe(true)
    expect(big.modified.atLeast).toBe(true)
  })
})
