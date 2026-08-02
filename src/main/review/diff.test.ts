import { describe, it, expect } from 'vitest'
import { parseReviewDiff, renderNumberedDiff, resolveAnchor } from './diff'
import type { ReviewDiff } from '@shared/types'

const SIMPLE = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1
-const b = 2
+const b = 3
+const c = 4
 const d = 5
`

describe('parseReviewDiff', () => {
  it('행마다 old/new 줄 번호를 매긴다', () => {
    const diff = parseReviewDiff(SIMPLE)
    expect(diff.files).toHaveLength(1)
    const file = diff.files[0]
    expect(file.path).toBe('src/a.ts')
    expect(file.status).toBe('modified')
    expect(file.additions).toBe(2)
    expect(file.deletions).toBe(1)

    const rows = file.hunks[0].rows
    expect(rows.map((r) => [r.kind, r.oldLine, r.newLine])).toEqual([
      ['context', 1, 1],
      ['del', 2, null],
      ['add', null, 2],
      ['add', null, 3],
      ['context', 3, 4]
    ])
  })

  it('접두사 공백이 잘려 빈 줄로 온 문맥 행에서도 줄 번호가 밀리지 않는다', () => {
    // 원본이 빈 줄인 문맥 행은 " " 로 와야 하지만 공백이 잘려 "" 로 오는 경우가 흔하다.
    // 접두사만 보고 hunk 를 끊으면 이후 모든 줄 번호가 어긋난다.
    const raw = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,4 +1,4 @@',
      ' first',
      '', // 빈 문맥 행 (공백 접두사 유실)
      '-old',
      '+new',
      ' last',
      ''
    ].join('\n')

    const file = parseReviewDiff(raw).files[0]
    const rows = file.hunks[0].rows
    expect(rows.map((r) => [r.kind, r.oldLine, r.newLine])).toEqual([
      ['context', 1, 1],
      ['context', 2, 2],
      ['del', 3, null],
      ['add', null, 3],
      ['context', 4, 4]
    ])
  })

  it('hunk 를 여러 개 파싱하고 두 번째 hunk 의 시작 번호를 지킨다', () => {
    const raw = `diff --git a/m.ts b/m.ts
--- a/m.ts
+++ b/m.ts
@@ -1,2 +1,2 @@
 a
-b
+B
@@ -50,2 +50,3 @@
 x
+y
 z
`
    const file = parseReviewDiff(raw).files[0]
    expect(file.hunks).toHaveLength(2)
    const second = file.hunks[1].rows
    expect(second[0].newLine).toBe(50)
    expect(second[1]).toMatchObject({ kind: 'add', newLine: 51 })
    expect(second[2]).toMatchObject({ kind: 'context', oldLine: 51, newLine: 52 })
  })

  it('개수가 생략된 hunk 헤더(@@ -1 +1 @@)를 1로 해석한다', () => {
    const raw = `diff --git a/s.ts b/s.ts
--- a/s.ts
+++ b/s.ts
@@ -7 +7 @@
-old
+new
`
    const rows = parseReviewDiff(raw).files[0].hunks[0].rows
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ kind: 'del', oldLine: 7 })
    expect(rows[1]).toMatchObject({ kind: 'add', newLine: 7 })
  })

  it('"\\ No newline at end of file" 은 줄 수로 세지 않는다', () => {
    const raw = `diff --git a/n.ts b/n.ts
--- a/n.ts
+++ b/n.ts
@@ -1,2 +1,2 @@
 keep
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`
    const rows = parseReviewDiff(raw).files[0].hunks[0].rows
    expect(rows.map((r) => r.kind)).toEqual(['context', 'del', 'add'])
    expect(rows[2].newLine).toBe(2)
  })

  it('신규 파일과 삭제 파일의 상태·경로를 잡는다', () => {
    const added = parseReviewDiff(`diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+one
+two
`).files[0]
    expect(added.status).toBe('added')
    expect(added.path).toBe('new.ts')
    expect(added.hunks[0].rows[0].newLine).toBe(1)

    const deleted = parseReviewDiff(`diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two
`).files[0]
    expect(deleted.status).toBe('deleted')
    // +++ 가 /dev/null 이므로 옛 경로를 써야 한다(GitHub 도 이 경로를 받는다).
    expect(deleted.path).toBe('gone.ts')
  })

  it('rename 의 새 경로와 옛 경로를 구분한다', () => {
    const file = parseReviewDiff(`diff --git a/old/p.ts b/new/p.ts
similarity index 90%
rename from old/p.ts
rename to new/p.ts
--- a/old/p.ts
+++ b/new/p.ts
@@ -1,1 +1,1 @@
-a
+b
`).files[0]
    expect(file.status).toBe('renamed')
    expect(file.path).toBe('new/p.ts')
    expect(file.oldPath).toBe('old/p.ts')
  })

  it('바이너리 파일은 hunk 없이 표시한다', () => {
    const file = parseReviewDiff(`diff --git a/img.png b/img.png
index 111..222 100644
Binary files a/img.png and b/img.png differ
`).files[0]
    expect(file.binary).toBe(true)
    expect(file.hunks).toHaveLength(0)
  })

  it('파일 여러 개를 나눠 파싱한다', () => {
    const diff = parseReviewDiff(SIMPLE + SIMPLE.replace(/src\/a\.ts/g, 'src/b.ts'))
    expect(diff.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('헤더의 줄 수가 실제 내용보다 커도 유령 행을 만들지 않는다', () => {
    // 손상되거나 손으로 편집된 diff. 남은 자리를 채우려고 파일 끝 빈 줄을 문맥 행으로
    // 삼키면 존재하지 않는 줄 번호가 생기고, 거기에 코멘트를 걸면 GitHub 이 422 를 낸다.
    const raw = `diff --git a/t.ts b/t.ts
--- a/t.ts
+++ b/t.ts
@@ -1,9 +1,9 @@
 a
-b
+c
`
    const rows = parseReviewDiff(raw).files[0].hunks[0].rows
    expect(rows.map((r) => r.kind)).toEqual(['context', 'del', 'add'])
    expect(rows.at(-1)?.newLine).toBe(2)
  })

  it('빈 입력은 빈 목록', () => {
    expect(parseReviewDiff('')).toEqual({ files: [] })
    expect(parseReviewDiff('   \n')).toEqual({ files: [] })
  })
})

describe('renderNumberedDiff', () => {
  it('줄마다 RIGHT/LEFT 라벨을 박는다', () => {
    const out = renderNumberedDiff(parseReviewDiff(SIMPLE))
    expect(out).toContain('=== src/a.ts (modified)')
    expect(out).toContain('LEFT:2')
    expect(out).toContain('RIGHT:2')
    // 삭제 행은 LEFT, 추가 행은 RIGHT 라벨이어야 한다.
    const delRow = out.split('\n').find((l) => l.includes('-const b = 2'))
    expect(delRow).toContain('LEFT:2')
    const addRow = out.split('\n').find((l) => l.includes('+const b = 3'))
    expect(addRow).toContain('RIGHT:2')
  })
})

describe('resolveAnchor', () => {
  const diff: ReviewDiff = parseReviewDiff(SIMPLE)

  it('diff 에 있는 줄은 그대로 앵커한다', () => {
    const { anchor } = resolveAnchor(diff, {
      severity: 'minor',
      title: 't',
      body: 'b',
      file: 'src/a.ts',
      line: 3,
      side: 'RIGHT'
    })
    expect(anchor).toMatchObject({ file: 'src/a.ts', side: 'RIGHT', line: 3, snappedFrom: null })
  })

  it('side 를 생략하면 RIGHT 로 본다', () => {
    const { anchor } = resolveAnchor(diff, {
      severity: 'minor',
      title: 't',
      body: 'b',
      file: 'src/a.ts',
      line: 2
    })
    expect(anchor?.side).toBe('RIGHT')
  })

  it('LEFT 면은 삭제/문맥 행의 옛 줄 번호로 앵커한다', () => {
    const { anchor } = resolveAnchor(diff, {
      severity: 'minor',
      title: 't',
      body: 'b',
      file: 'src/a.ts',
      line: 2,
      side: 'LEFT'
    })
    expect(anchor).toMatchObject({ side: 'LEFT', line: 2 })
  })

  it('살짝 빗나간 줄은 가까운 유효 줄로 끌어당기고 원래 줄을 기록한다', () => {
    // RIGHT 유효 줄은 1..4. 6 은 2칸 떨어진 4 로 스냅된다.
    const { anchor } = resolveAnchor(diff, {
      severity: 'minor',
      title: 't',
      body: 'b',
      file: 'src/a.ts',
      line: 6
    })
    expect(anchor).toMatchObject({ line: 4, snappedFrom: 6 })
  })

  it('너무 멀리 벗어난 줄은 앵커하지 않고 사유를 남긴다', () => {
    const { anchor, reason } = resolveAnchor(diff, {
      severity: 'minor',
      title: 't',
      body: 'b',
      file: 'src/a.ts',
      line: 900
    })
    expect(anchor).toBeNull()
    expect(reason).toContain('src/a.ts:900')
  })

  it('diff 에 없는 파일은 앵커하지 않는다', () => {
    const { anchor, reason } = resolveAnchor(diff, {
      severity: 'minor',
      title: 't',
      body: 'b',
      file: 'src/nope.ts',
      line: 1
    })
    expect(anchor).toBeNull()
    expect(reason).toContain('src/nope.ts')
  })

  it('절대경로나 ./ 접두사가 붙어도 파일을 찾는다', () => {
    const abs = resolveAnchor(diff, {
      severity: 'minor',
      title: 't',
      body: 'b',
      file: '/Users/me/wt/src/a.ts',
      line: 2
    })
    expect(abs.anchor?.file).toBe('src/a.ts')

    const dot = resolveAnchor(diff, {
      severity: 'minor',
      title: 't',
      body: 'b',
      file: './src/a.ts',
      line: 2
    })
    expect(dot.anchor?.file).toBe('src/a.ts')
  })

  it('file/line 이 없으면 전반 지적으로 두고 사유도 남기지 않는다', () => {
    const { anchor, reason } = resolveAnchor(diff, { severity: 'major', title: 't', body: 'b' })
    expect(anchor).toBeNull()
    expect(reason).toBeNull()
  })

  it('유효한 startLine 은 멀티라인 앵커로 유지한다', () => {
    const { anchor } = resolveAnchor(diff, {
      severity: 'minor',
      title: 't',
      body: 'b',
      file: 'src/a.ts',
      line: 3,
      startLine: 2
    })
    expect(anchor).toMatchObject({ line: 3, startLine: 2 })
  })

  it('startLine 이 끝 줄보다 뒤면 멀티라인을 포기하고 한 줄 코멘트로 남긴다', () => {
    const { anchor } = resolveAnchor(diff, {
      severity: 'minor',
      title: 't',
      body: 'b',
      file: 'src/a.ts',
      line: 2,
      startLine: 4
    })
    expect(anchor).toMatchObject({ line: 2, startLine: null })
  })

  it('바이너리 파일에는 앵커하지 않는다', () => {
    const bin = parseReviewDiff(`diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
`)
    const { anchor, reason } = resolveAnchor(bin, {
      severity: 'minor',
      title: 't',
      body: 'b',
      file: 'img.png',
      line: 1
    })
    expect(anchor).toBeNull()
    expect(reason).toContain('바이너리')
  })
})
