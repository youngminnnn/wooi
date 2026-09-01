import { describe, it, expect } from 'vitest'
import { hunkPatch, parsePatch } from './diffPatch'

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

/**
 * 여기서 만든 patch 는 `git apply --reverse` 로 **사용자의 파일에 되쓰인다**. 한 줄이라도
 * 어긋나면 없어지는 것이 diff 의 픽셀이 아니라 코드다. 그래서 조립 결과를 글자 단위로 못 박고,
 * 실제 git 이 이걸 받아 무엇을 하는지는 옆의 diffPatch.apply.test.ts 가 확인한다.
 */
describe('hunkPatch', () => {
  it('고른 hunk 하나만 담은 완결된 patch 를 만든다', () => {
    const [hunk] = parsePatch(PATCH)
    expect(hunkPatch({ path: 'src/calc.ts', status: 'modified' }, hunk)).toBe(
      [
        '--- a/src/calc.ts',
        '+++ b/src/calc.ts',
        '@@ -10,4 +10,5 @@ export function sum(',
        '   const a = 1',
        '-  const b = 2',
        '+  const b = 3',
        '+  const c = 4',
        '   return a + b',
        '   }',
        ''
      ].join('\n')
    )
  })

  it('hunk 가 여럿이면 고른 것만 들어간다 — 나머지는 남는다', () => {
    const patch = ['@@ -1,1 +1,1 @@', '-a', '+A', '@@ -50,1 +50,1 @@', '-z', '+Z'].join('\n')
    const [first, second] = parsePatch(patch)
    const file = { path: 'x.ts', status: 'modified' as const }
    expect(hunkPatch(file, first)).toContain('@@ -1,1 +1,1 @@')
    expect(hunkPatch(file, first)).not.toContain('-z')
    expect(hunkPatch(file, second)).toContain('@@ -50,1 +50,1 @@')
    expect(hunkPatch(file, second)).not.toContain('-a')
  })

  // 이 표식이 빠지면 되돌린 파일의 마지막 줄에 개행이 하나 생기거나 사라진다.
  it('"\\ No newline at end of file" 을 원문 자리 그대로 옮긴다', () => {
    const patch = ['@@ -1,1 +1,1 @@', '-a', '\\ No newline at end of file', '+b'].join('\n')
    const [hunk] = parsePatch(patch)
    expect(hunkPatch({ path: 'n.ts', status: 'modified' }, hunk)).toBe(
      [
        '--- a/n.ts',
        '+++ b/n.ts',
        '@@ -1,1 +1,1 @@',
        '-a',
        '\\ No newline at end of file',
        '+b',
        ''
      ].join('\n')
    )
  })

  // 접두사가 잘려나간 빈 문맥 행. rows 로 다시 쓰면 " " 가 붙어 원문과 달라진다.
  it('본문을 다시 쓰지 않고 원문 그대로 옮긴다', () => {
    const patch = ['@@ -1,4 +1,4 @@', ' one', '', '-three', '+THREE'].join('\n')
    const [hunk] = parsePatch(patch)
    expect(hunkPatch({ path: 'x.ts', status: 'modified' }, hunk)).toBe(
      ['--- a/x.ts', '+++ b/x.ts', '@@ -1,4 +1,4 @@', ' one', '', '-three', '+THREE', ''].join('\n')
    )
  })

  it('새로 생긴 파일은 옛 쪽이 /dev/null — 역적용이 곧 파일 삭제다', () => {
    const [hunk] = parsePatch('@@ -0,0 +1,2 @@\n+a\n+b\n')
    expect(hunkPatch({ path: 'new.ts', status: 'added' }, hunk)).toBe(
      ['--- /dev/null', '+++ b/new.ts', '@@ -0,0 +1,2 @@', '+a', '+b', ''].join('\n')
    )
  })

  it('사라진 파일은 새 쪽이 /dev/null — 역적용이 곧 파일 복원이다', () => {
    const [hunk] = parsePatch('@@ -1,2 +0,0 @@\n-a\n-b\n')
    expect(hunkPatch({ path: 'gone.ts', status: 'deleted' }, hunk)).toBe(
      ['--- a/gone.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-a', '-b', ''].join('\n')
    )
  })

  /**
   * 이름이 바뀐 파일의 원문 헤더는 `--- a/옛경로` / `+++ b/새경로` 다. 그대로 역적용하면 git 이
   * 파일을 옛 이름으로 되돌린다 — 우리가 버리려는 건 그 hunk 의 내용뿐인데 이름까지 되돌아간다.
   */
  it('이름이 바뀐 파일은 양쪽을 현재 경로로 맞춘다 — 내용만 되돌리고 이름은 둔다', () => {
    const [hunk] = parsePatch(
      [
        'diff --git a/old.ts b/new.ts',
        'similarity index 90%',
        'rename from old.ts',
        'rename to new.ts',
        '--- a/old.ts',
        '+++ b/new.ts',
        '@@ -1,1 +1,1 @@',
        '-a',
        '+A'
      ].join('\n')
    )
    const built = hunkPatch({ path: 'new.ts', status: 'renamed' }, hunk)
    expect(built).toBe(
      ['--- a/new.ts', '+++ b/new.ts', '@@ -1,1 +1,1 @@', '-a', '+A', ''].join('\n')
    )
    expect(built).not.toContain('old.ts')
  })
})
