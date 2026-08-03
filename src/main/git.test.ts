import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sanitizeBranch, parseGithubOwner, ghMergeBase, syncGhMergeBase } from './git'

describe('sanitizeBranch', () => {
  it('공백을 하이픈으로 바꾼다', () => {
    expect(sanitizeBranch('my new feature')).toBe('my-new-feature')
  })

  it('git ref 로 쓸 수 없는 문자를 제거한다', () => {
    expect(sanitizeBranch('feat: add ~thing^!')).toBe('feat-add-thing')
  })

  it('영숫자와 ._/- 는 보존한다', () => {
    expect(sanitizeBranch('feature/foo_bar.v2')).toBe('feature/foo_bar.v2')
  })

  it('앞쪽 - 와 / 는 잘라낸다', () => {
    expect(sanitizeBranch('--/foo')).toBe('foo')
  })

  it('연속된 슬래시는 하나로 접는다', () => {
    expect(sanitizeBranch('feat///foo')).toBe('feat/foo')
  })

  it('내용이 모두 제거되면 "workspace" 로 폴백한다', () => {
    expect(sanitizeBranch('~~~')).toBe('workspace')
    expect(sanitizeBranch('   ')).toBe('workspace')
    expect(sanitizeBranch('')).toBe('workspace')
  })
})

describe('parseGithubOwner', () => {
  it('HTTPS URL 에서 소유자를 뽑는다', () => {
    expect(parseGithubOwner('https://github.com/youngminnnn/wooi.git')).toBe('youngminnnn')
    expect(parseGithubOwner('https://github.com/youngminnnn/wooi')).toBe('youngminnnn')
  })

  it('SSH(scp 형식) URL 에서 소유자를 뽑는다', () => {
    expect(parseGithubOwner('git@github.com:youngminnnn/wooi.git')).toBe('youngminnnn')
  })

  it('ssh:// URL 에서 소유자를 뽑는다', () => {
    expect(parseGithubOwner('ssh://git@github.com/youngminnnn/wooi')).toBe('youngminnnn')
  })

  it('끝의 슬래시를 허용한다', () => {
    expect(parseGithubOwner('https://github.com/youngminnnn/wooi/')).toBe('youngminnnn')
  })

  it('대소문자를 가리지 않는다', () => {
    expect(parseGithubOwner('https://GitHub.com/Youngminnnn/Wooi.git')).toBe('Youngminnnn')
  })

  it('GitHub 리모트가 아니면 null 을 반환한다', () => {
    expect(parseGithubOwner('https://gitlab.com/foo/bar.git')).toBeNull()
    expect(parseGithubOwner('')).toBeNull()
    expect(parseGithubOwner('not a url')).toBeNull()
  })
})

// `gh pr create` 가 `--base` 없이 고르는 base 를 우리가 심어 두는 부분이다. 실제 git config 를
// 오가는 값이라 임시 리포와 worktree 로 확인한다 — 특히 worktree 에서 쓴 값이 리포 공용 config
// 로 들어가야 다른 경로(리포 루트에서 도는 캐스케이드 등)에서도 같은 값을 본다.
describe('gh-merge-base (gh 의 기본 PR base)', () => {
  let base: string
  let repo: string
  let wt: string

  const git = (cwd: string, args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'wooi-git-'))
    repo = join(base, 'main')
    wt = join(base, 'wt')
    mkdirSync(repo)
    git(repo, ['init', '-q', '-b', 'main'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    git(repo, ['config', 'user.name', 'test'])
    writeFileSync(join(repo, 'README.md'), 'hello\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-qm', 'init'])
    git(repo, ['worktree', 'add', '-q', wt, '-b', 'child'])
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('설정이 없으면 null 이다', async () => {
    await expect(ghMergeBase(wt, 'child')).resolves.toBeNull()
  })

  it('worktree 에서 쓴 값을 리포 공용 config 에서도 읽는다', async () => {
    await syncGhMergeBase(wt, 'child', 'parent')
    expect(git(repo, ['config', '--get', 'branch.child.gh-merge-base'])).toBe('parent')
    await expect(ghMergeBase(repo, 'child')).resolves.toBe('parent')
  })

  it('null 을 주면 설정을 지운다(gh 기본값으로 되돌림)', async () => {
    await syncGhMergeBase(wt, 'child', 'parent')
    await syncGhMergeBase(wt, 'child', null)
    await expect(ghMergeBase(wt, 'child')).resolves.toBeNull()
  })

  it('설정이 없을 때 지우기를 요청해도 실패하지 않는다', async () => {
    await expect(syncGhMergeBase(wt, 'child', null)).resolves.toBeUndefined()
  })

  it('값을 바꾸면 덮어쓴다(중복 항목이 쌓이지 않는다)', async () => {
    await syncGhMergeBase(wt, 'child', 'parent')
    await syncGhMergeBase(wt, 'child', 'grandparent')
    expect(git(repo, ['config', '--get-all', 'branch.child.gh-merge-base'])).toBe('grandparent')
  })

  it('슬래시가 든 브랜치 이름도 다룬다', async () => {
    await syncGhMergeBase(wt, 'feat/child', 'feat/parent')
    await expect(ghMergeBase(wt, 'feat/child')).resolves.toBe('feat/parent')
  })

  it('브랜치를 rename 해도 설정이 따라온다(Wooi 는 push 전에 이름을 바꾼다)', async () => {
    await syncGhMergeBase(wt, 'child', 'parent')
    git(wt, ['branch', '-m', 'feat/child'])
    await expect(ghMergeBase(wt, 'feat/child')).resolves.toBe('parent')
  })
})
