import { describe, expect, it } from 'vitest'
import { diffFilePath, diffStat } from './diff'

const PATCH = `diff --git a/src/main/git.ts b/src/main/git.ts
index 1111111..2222222 100644
--- a/src/main/git.ts
+++ b/src/main/git.ts
@@ -1,4 +1,5 @@
 const a = 1
-const b = 2
+const b = 3
+const c = 4
`

describe('diffStat', () => {
  it('추가와 삭제를 센다', () => {
    expect(diffStat(PATCH)).toEqual({ added: 2, removed: 1 })
  })

  // 파일 헤더를 세면 모든 패치가 +1 −1 씩 부풀어 오른다.
  it('---/+++ 헤더는 세지 않는다', () => {
    expect(diffStat('--- a/x\n+++ b/x')).toEqual({ added: 0, removed: 0 })
  })

  it('빈 diff 는 0 이다', () => {
    expect(diffStat('')).toEqual({ added: 0, removed: 0 })
  })
})

describe('diffFilePath', () => {
  it('git 헤더에서 경로를 집는다', () => {
    expect(diffFilePath(PATCH)).toBe('src/main/git.ts')
  })

  // 에이전트가 만든 패치에는 `diff --git` 줄이 없는 일이 잦다.
  it('git 헤더가 없으면 +++ 를 본다', () => {
    expect(diffFilePath('--- a/x.ts\n+++ b/x.ts\n@@')).toBe('x.ts')
  })

  it('새 파일이면 /dev/null 이 아닌 쪽을 고른다', () => {
    expect(diffFilePath('--- /dev/null\n+++ b/new.ts')).toBe('new.ts')
  })

  it('지운 파일이면 --- 쪽을 고른다', () => {
    expect(diffFilePath('--- a/gone.ts\n+++ /dev/null')).toBe('gone.ts')
  })

  it('경로 뒤의 타임스탬프는 떼어낸다', () => {
    expect(diffFilePath('+++ b/x.ts\t2026-01-01 00:00:00')).toBe('x.ts')
  })

  it('헤더가 없으면 null 이다', () => {
    expect(diffFilePath('@@ -1 +1 @@\n-a\n+b')).toBeNull()
  })
})
