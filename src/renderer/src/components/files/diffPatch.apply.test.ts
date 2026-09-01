import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hunkPatch, parsePatch } from './diffPatch'

/**
 * [[hunkPatch]] 가 만든 patch 를 **진짜 git 에** 먹여 본다.
 *
 * 글자 단위 비교(diffPatch.test.ts)는 우리가 의도한 모양이 나왔는지만 말해 준다. 정작 알아야 할
 * 것은 그 모양을 git 이 어떻게 읽느냐다 — 개행 없는 파일 끝, 이름이 바뀐 파일, 공백이 든 경로는
 * 전부 "그럴듯하지만 git 이 다르게 읽는" 자리이고, 여기서 틀리면 사용자의 코드가 사라진다.
 * 그래서 이 파일만은 mock 없이 임시 리포를 세워 `git apply --reverse` 를 실제로 돌린다.
 *
 * 렌더러 테스트인데 git 을 부르는 이유는 [[hunkPatch]] 가 렌더러에 살기 때문이다 — 옮기면
 * 검증은 편해지지만, patch 를 오리는 코드는 diff 를 그리는 코드 옆에 있어야 같이 고쳐진다.
 */

let root: string
const git = (args: string[], input?: string): string =>
  execFileSync('git', args, { cwd: root, encoding: 'utf-8', input })

/** 되돌리기를 실제로 실행한다. main 의 applyReversePatch 와 같은 인자를 쓴다. */
function discard(patch: string): { ok: boolean; stderr: string } {
  try {
    git(['apply', '--reverse', '-'], patch)
    return { ok: true, stderr: '' }
  } catch (e) {
    const err = e as { stderr?: Buffer | string }
    return { ok: false, stderr: String(err.stderr ?? '') }
  }
}

const read = (rel: string): string => readFileSync(join(root, rel), 'utf-8')
const write = (rel: string, text: string): void => writeFileSync(join(root, rel), text)
const lines = (count: number): string =>
  Array.from({ length: count }, (_, i) => `line ${i}\n`).join('')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wooi-hunk-'))
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', '테스터'])
  write('seed.txt', 'seed\n')
  git(['add', '-A'])
  git(['commit', '-qm', 'seed'])
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('hunkPatch → git apply --reverse', () => {
  // 이 기능의 핵심 주장. 하나를 버리면 하나만 없어져야 한다.
  it('고른 hunk 만 되돌리고 같은 파일의 다른 hunk 는 그대로 둔다', () => {
    const before = lines(30)
    write('a.ts', before)
    git(['add', '-A'])
    git(['commit', '-qm', 'base'])
    write('a.ts', before.replace('line 3\n', 'LINE 3\n').replace('line 25\n', 'LINE 25\n'))

    const hunks = parsePatch(git(['diff', 'HEAD', '--', 'a.ts']))
    expect(hunks).toHaveLength(2)
    expect(discard(hunkPatch({ path: 'a.ts', status: 'modified' }, hunks[0])).ok).toBe(true)

    expect(read('a.ts')).toBe(before.replace('line 25\n', 'LINE 25\n'))
  })

  it('커밋된 변경도 워킹 트리에서만 되돌린다 — 이력은 그대로다', () => {
    write('a.ts', lines(10))
    git(['add', '-A'])
    git(['commit', '-qm', 'base'])
    const head = git(['rev-parse', 'HEAD']).trim()
    write('a.ts', lines(10).replace('line 4\n', 'LINE 4\n'))
    git(['add', '-A'])
    git(['commit', '-qm', '에이전트가 고쳤다'])

    const hunks = parsePatch(git(['diff', head, '--', 'a.ts']))
    expect(discard(hunkPatch({ path: 'a.ts', status: 'modified' }, hunks[0])).ok).toBe(true)

    expect(read('a.ts')).toBe(lines(10))
    // 커밋은 손대지 않았다 — 되돌린 것은 커밋되지 않은 변경으로 남는다.
    expect(git(['log', '--oneline', '-1'])).toContain('에이전트가 고쳤다')
    expect(git(['status', '--porcelain'])).toContain('a.ts')
  })

  /**
   * untracked 파일의 patch 는 git 이 아니라 Wooi 가 지어낸 것이다(main/git.ts untrackedFileDiff).
   * 그 하나뿐인 hunk 를 버리는 것은 곧 "에이전트가 만든 이 파일을 없애기" 다.
   */
  it('새로 생긴 파일의 유일한 hunk 를 버리면 파일이 사라진다', () => {
    write('fresh.ts', 'a\nb\nc\n')
    const hunks = parsePatch('@@ -0,0 +1,3 @@\n+a\n+b\n+c\n')
    expect(discard(hunkPatch({ path: 'fresh.ts', status: 'added' }, hunks[0])).ok).toBe(true)
    expect(existsSync(join(root, 'fresh.ts'))).toBe(false)
  })

  it('지워진 파일의 hunk 를 버리면 파일이 되살아난다', () => {
    write('gone.ts', 'a\nb\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'base'])
    rmSync(join(root, 'gone.ts'))

    const hunks = parsePatch(git(['diff', 'HEAD', '--', 'gone.ts']))
    expect(discard(hunkPatch({ path: 'gone.ts', status: 'deleted' }, hunks[0])).ok).toBe(true)
    expect(read('gone.ts')).toBe('a\nb\n')
  })

  // 표식을 흘리면 파일 끝 개행이 조용히 뒤바뀐다 — 되돌렸는데 diff 가 안 사라진다.
  it('개행 없이 끝나던 파일을 개행 없는 그대로 되돌린다', () => {
    write('n.ts', 'a\nb')
    git(['add', '-A'])
    git(['commit', '-qm', 'base'])
    write('n.ts', 'a\nB\n')

    const hunks = parsePatch(git(['diff', 'HEAD', '--', 'n.ts']))
    expect(discard(hunkPatch({ path: 'n.ts', status: 'modified' }, hunks[0])).ok).toBe(true)
    expect(read('n.ts')).toBe('a\nb')
  })

  it('이름이 바뀐 파일은 내용만 되돌리고 새 이름을 지킨다', () => {
    write('old.ts', lines(20))
    git(['add', '-A'])
    git(['commit', '-qm', 'base'])
    git(['mv', 'old.ts', 'new.ts'])
    write('new.ts', lines(20).replace('line 5\n', 'LINE 5\n'))

    const hunks = parsePatch(git(['diff', 'HEAD', '-M', '--', 'old.ts', 'new.ts']))
    expect(discard(hunkPatch({ path: 'new.ts', status: 'renamed' }, hunks[0])).ok).toBe(true)

    expect(existsSync(join(root, 'new.ts'))).toBe(true)
    expect(existsSync(join(root, 'old.ts'))).toBe(false)
    expect(read('new.ts')).toBe(lines(20))
  })

  it('경로에 공백이 있어도 되돌린다', () => {
    write('my file.ts', 'a\nb\nc\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'base'])
    write('my file.ts', 'a\nB\nc\n')

    const hunks = parsePatch(git(['diff', 'HEAD', '--', 'my file.ts']))
    expect(discard(hunkPatch({ path: 'my file.ts', status: 'modified' }, hunks[0])).ok).toBe(true)
    expect(read('my file.ts')).toBe('a\nb\nc\n')
  })

  /**
   * 화면을 그린 뒤 에이전트가 그 파일을 또 고쳤을 때. 억지로 맞춰 붙이면 엉뚱한 줄이 사라지므로
   * 거절이 정답이다 — 그리고 거절당한 뒤 파일은 한 글자도 달라지지 않아야 한다.
   */
  it('diff 를 그린 뒤 파일이 바뀌었으면 거절하고 파일을 건드리지 않는다', () => {
    write('a.ts', 'a\nb\nc\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'base'])
    write('a.ts', 'a\nB\nc\n')
    const hunks = parsePatch(git(['diff', 'HEAD', '--', 'a.ts']))

    write('a.ts', 'totally\ndifferent\n')
    const res = discard(hunkPatch({ path: 'a.ts', status: 'modified' }, hunks[0]))

    expect(res.ok).toBe(false)
    expect(res.stderr).toMatch(/patch does not apply/)
    expect(read('a.ts')).toBe('totally\ndifferent\n')
  })
})
