import { describe, it, expect } from 'vitest'
import { parsePatch } from './diffPatch'

/**
 * 줄 번호가 틀리면 코멘트가 엉뚱한 자리를 가리키고, 그 순간 이 기능은 도움이 아니라 방해가 된다.
 * 그래서 검증의 무게는 전부 "몇 번째 줄인가" 에 실려 있다.
 */

const PATCH = [
  'diff --git a/src/calc.ts b/src/calc.ts',
  'index 1111111..2222222 100644',
  '--- a/src/calc.ts',
  '+++ b/src/calc.ts',
  '@@ -10,4 +10,5 @@ export function sum(',
  '   const a = 1',
  '-  const b = 2',
  '+  const b = 3',
  '+  const c = 4',
  '   return a + b',
  '   }'
].join('\n')

describe('parsePatch', () => {
  it('hunk 헤더가 말한 시작 줄부터 old/new 번호를 매긴다', () => {
    const [hunk] = parsePatch(PATCH)
    expect(hunk.header).toBe('@@ -10,4 +10,5 @@ export function sum(')
    expect(hunk.rows.map((r) => [r.kind, r.oldLine, r.newLine])).toEqual([
      ['context', 10, 10],
      ['del', 11, null],
      ['add', null, 11],
      ['add', null, 12],
      ['context', 12, 13],
      ['context', 13, 14]
    ])
  })

  it('삭제 줄에도 새 파일 기준 앵커를 준다 — 삭제만 고른 코멘트가 위치를 잃지 않게', () => {
    const del = parsePatch(PATCH)[0].rows[1]
    expect(del.newLine).toBeNull()
    expect(del.anchor).toBe(11)
  })

  it('접두사가 잘려나간 빈 문맥 행을 만나도 이후 줄 번호가 밀리지 않는다', () => {
    // 실제 diff 에서 흔한 손상 — 원본이 빈 줄인 문맥 행의 " " 가 사라져 "" 로 온다.
    const patch = ['@@ -1,4 +1,4 @@', ' one', '', '-three', '+THREE'].join('\n')
    const rows = parsePatch(patch)[0].rows
    expect(rows.map((r) => [r.kind, r.newLine])).toEqual([
      ['context', 1],
      ['context', 2],
      ['del', null],
      ['add', 3]
    ])
  })

  it('"\\ No newline at end of file" 은 줄 수로 세지 않는다', () => {
    const patch = ['@@ -1,1 +1,1 @@', '-a', '\\ No newline at end of file', '+b'].join('\n')
    const rows = parsePatch(patch)[0].rows
    expect(rows.map((r) => r.kind)).toEqual(['del', 'add'])
    expect(rows[1].newLine).toBe(1)
  })

  it('hunk 가 여럿이면 각각을 따로 읽는다', () => {
    const patch = ['@@ -1,1 +1,1 @@', '-a', '+A', '@@ -50,1 +50,1 @@', '-z', '+Z'].join('\n')
    const hunks = parsePatch(patch)
    expect(hunks).toHaveLength(2)
    expect(hunks[1].rows[1].newLine).toBe(50)
  })

  it('hunk 가 없는 patch(모드 변경 등)는 빈 배열', () => {
    expect(parsePatch('diff --git a/x b/x\nold mode 100644\nnew mode 100755\n')).toEqual([])
    expect(parsePatch('')).toEqual([])
  })
})
