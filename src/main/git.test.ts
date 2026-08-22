import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  sanitizeBranch,
  parseGithubOwner,
  ghMergeBase,
  syncGhMergeBase,
  summarizeBranch,
  getDiff,
  getStatus,
  fetchRemoteForRepo,
  checkoutPrWorktree,
  resolveUniqueWorktree,
  pushCurrentBranch,
  resolveBranchPushTarget,
  summarizePushError,
  lastRemoteRefUpdate,
  restackOnto,
  addWorktree,
  applySnapshot,
  snapshotWorkingTree
} from './git'

describe('branch tracking push target', () => {
  let root: string
  let worktree: string
  let origin: string
  let remote: string
  let pushRemote: string

  const git = (cwd: string, args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wooi-push-target-'))
    worktree = join(root, 'worktree')
    origin = join(root, 'origin.git')
    remote = join(root, 'remote.git')
    pushRemote = join(root, 'push-remote.git')
    for (const bare of [origin, remote, pushRemote]) git(root, ['init', '-q', '--bare', bare])
    mkdirSync(worktree)
    git(worktree, ['init', '-q', '-b', 'local-name'])
    git(worktree, ['config', 'user.email', 'test@example.com'])
    git(worktree, ['config', 'user.name', 'test'])
    writeFileSync(join(worktree, 'file.txt'), 'one\n')
    git(worktree, ['add', '-A'])
    git(worktree, ['commit', '-qm', 'one'])
    git(worktree, ['remote', 'add', 'origin', origin])
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('tracking config 가 없으면 기존 origin/로컬 브랜치 대상으로 push 한다', async () => {
    await expect(resolveBranchPushTarget(worktree)).resolves.toEqual({
      branch: 'local-name',
      remote: 'origin',
      destination: 'local-name'
    })
    await expect(pushCurrentBranch(worktree)).resolves.toEqual({ ok: true, error: '' })
    expect(git(origin, ['rev-parse', 'refs/heads/local-name'])).toBe(
      git(worktree, ['rev-parse', 'HEAD'])
    )
  })

  it('merge 만 있으면 origin 의 그 destination ref 로 push 한다', async () => {
    git(worktree, ['config', 'branch.local-name.merge', 'refs/heads/pr-head'])
    await expect(resolveBranchPushTarget(worktree)).resolves.toEqual({
      branch: 'local-name',
      remote: 'origin',
      destination: 'pr-head'
    })
    await expect(pushCurrentBranch(worktree)).resolves.toMatchObject({ ok: true })
    expect(git(origin, ['rev-parse', 'refs/heads/pr-head'])).toBe(
      git(worktree, ['rev-parse', 'HEAD'])
    )
  })

  it('remote + merge 는 설정된 remote URL 의 destination 으로 push 한다', async () => {
    git(worktree, ['config', 'branch.local-name.remote', remote])
    git(worktree, ['config', 'branch.local-name.merge', 'refs/heads/pr-head'])
    await expect(resolveBranchPushTarget(worktree)).resolves.toEqual({
      branch: 'local-name',
      remote,
      destination: 'pr-head'
    })
    await expect(pushCurrentBranch(worktree)).resolves.toMatchObject({ ok: true })
    expect(git(remote, ['rev-parse', 'refs/heads/pr-head'])).toBe(
      git(worktree, ['rev-parse', 'HEAD'])
    )
  })

  it('pushremote 가 remote 를 덮어쓰고 같은 destination 으로 push 한다', async () => {
    git(worktree, ['config', 'branch.local-name.remote', remote])
    git(worktree, ['config', 'branch.local-name.pushRemote', pushRemote])
    git(worktree, ['config', 'branch.local-name.merge', 'refs/heads/pr-head'])
    await expect(resolveBranchPushTarget(worktree)).resolves.toEqual({
      branch: 'local-name',
      remote: pushRemote,
      destination: 'pr-head'
    })
    await expect(pushCurrentBranch(worktree)).resolves.toMatchObject({ ok: true })
    expect(git(pushRemote, ['rev-parse', 'refs/heads/pr-head'])).toBe(
      git(worktree, ['rev-parse', 'HEAD'])
    )
    expect(git(worktree, ['ls-remote', '--heads', remote, 'refs/heads/pr-head'])).toBe('')
  })
})

describe('PR workspace checkout', () => {
  let root: string
  let origin: string
  let clone: string
  let fakeBin: string
  let oldPath: string | undefined
  let oldShell: string | undefined
  let oldWooiHome: string | undefined

  const git = (cwd: string, args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wooi-pr-checkout-'))
    origin = join(root, 'origin.git')
    const seed = join(root, 'seed')
    clone = join(root, 'clone')
    fakeBin = join(root, 'bin')
    mkdirSync(seed)
    mkdirSync(fakeBin)
    git(seed, ['init', '-q', '-b', 'main'])
    git(seed, ['config', 'user.email', 'test@example.com'])
    git(seed, ['config', 'user.name', 'test'])
    writeFileSync(join(seed, 'README.md'), 'base\n')
    git(seed, ['add', '-A'])
    git(seed, ['commit', '-qm', 'base'])
    git(seed, ['checkout', '-qb', 'feat/pr'])
    writeFileSync(join(seed, 'pr.txt'), 'head\n')
    git(seed, ['add', '-A'])
    git(seed, ['commit', '-qm', 'pr'])
    git(seed, ['init', '-q', '--bare', origin])
    git(seed, ['push', '-q', origin, 'main'])
    git(seed, ['push', '-q', origin, 'HEAD:refs/pull/7/head'])
    git(origin, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    execFileSync('git', ['clone', '-q', origin, clone])

    const gh = join(fakeBin, 'gh')
    writeFileSync(gh, '#!/bin/sh\ngit checkout -qB feat/pr\n')
    chmodSync(gh, 0o755)
    oldPath = process.env.PATH
    oldShell = process.env.SHELL
    oldWooiHome = process.env.WOOI_HOME
    process.env.PATH = `${fakeBin}:${oldPath ?? ''}`
    process.env.SHELL = '/bin/sh'
    process.env.WOOI_HOME = join(root, 'wooi-home')
  })

  afterEach(() => {
    if (oldPath === undefined) delete process.env.PATH
    else process.env.PATH = oldPath
    if (oldShell === undefined) delete process.env.SHELL
    else process.env.SHELL = oldShell
    if (oldWooiHome === undefined) delete process.env.WOOI_HOME
    else process.env.WOOI_HOME = oldWooiHome
    rmSync(root, { recursive: true, force: true })
  })

  it('PR ref 를 fetch 해 detached worktree 를 만든 뒤 head 브랜치에 붙인다', async () => {
    const worktree = join(root, 'worktree')
    await expect(checkoutPrWorktree(clone, 7, worktree)).resolves.toBe('feat/pr')
    expect(git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feat/pr')
    expect(git(worktree, ['show', 'HEAD:pr.txt'])).toBe('head')
    expect(git(clone, ['for-each-ref', '--format=%(refname)', 'refs/wooi/pr-checkout'])).toBe('')
  })

  it('아카이브로 로컬 브랜치만 남아 있어도 그 이름을 그대로 다시 붙인다', async () => {
    git(clone, ['branch', 'feat/pr', 'refs/remotes/origin/main'])
    const worktree = join(root, 'restored')
    await expect(checkoutPrWorktree(clone, 7, worktree)).resolves.toBe('feat/pr')
    expect(git(worktree, ['show', 'HEAD:pr.txt'])).toBe('head')
  })

  it('고정 브랜치는 바꾸지 않고 이미 차지한 디렉토리만 uniquify 한다', async () => {
    git(clone, ['branch', 'feat/pr'])
    const first = await resolveUniqueWorktree(clone, 'feat/pr', { fixedBranch: true })
    mkdirSync(first.worktreePath, { recursive: true })
    const second = await resolveUniqueWorktree(clone, 'feat/pr', { fixedBranch: true })
    expect(second.branch).toBe('feat/pr')
    expect(second.worktreePath).not.toBe(first.worktreePath)
    expect(second.worktreePath).toMatch(/feat-pr-2$/)
  })
})

describe('getStatus base 해석', () => {
  let root: string

  const git = (cwd: string, args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wooi-status-'))
    git(root, ['init', '-q', '-b', 'main'])
    git(root, ['config', 'user.email', 'test@example.com'])
    git(root, ['config', 'user.name', 'test'])
    writeFileSync(join(root, 'base.txt'), 'base\n')
    git(root, ['add', '-A'])
    git(root, ['commit', '-qm', 'base'])
    git(root, ['checkout', '-qb', 'feature'])
    writeFileSync(join(root, 'feature.txt'), 'feature\n')
    git(root, ['add', '-A'])
    git(root, ['commit', '-qm', 'feature'])
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('origin/base 가 있으면 로컬 base 보다 우선하고 ahead 는 고유 커밋을 유지한다', async () => {
    git(root, ['checkout', '-qb', 'remote-main', 'main'])
    writeFileSync(join(root, 'remote.txt'), 'remote\n')
    git(root, ['add', '-A'])
    git(root, ['commit', '-qm', 'remote'])
    const remoteTip = git(root, ['rev-parse', 'HEAD'])
    git(root, ['checkout', '-q', 'feature'])
    git(root, ['update-ref', 'refs/remotes/origin/main', remoteTip])
    git(root, ['branch', '-D', 'remote-main'])

    await expect(getStatus(root, 'main')).resolves.toMatchObject({ behind: 1, ahead: 1 })
  })

  it('origin/base 가 없으면 로컬 base 로 폴백한다', async () => {
    await expect(getStatus(root, 'main')).resolves.toMatchObject({ behind: 0, ahead: 1 })
  })
})

describe('리포 fetch 합류', () => {
  it('같은 리포의 동시 요청은 진행 중인 fetch 하나를 공유한다', async () => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const fetcher = vi.fn(() => pending)

    const first = fetchRemoteForRepo('/tmp/a', 'repo-join', fetcher)
    const second = fetchRemoteForRepo('/tmp/b', 'repo-join', fetcher)
    expect(fetcher).toHaveBeenCalledTimes(1)
    finish()
    await Promise.all([first, second])
  })
})

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

describe('getDiff (Changes 패널)', () => {
  let base: string
  let repo: string

  const git = (cwd: string, args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'wooi-diff-'))
    repo = join(base, 'repo')
    mkdirSync(repo)
    git(repo, ['init', '-q', '-b', 'main'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    git(repo, ['config', 'user.name', 'test'])
    writeFileSync(join(repo, 'README.md'), 'initial\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-qm', 'init'])
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('로컬 base보다 origin base를 우선한다', async () => {
    // 로컬 main은 init에 둔 채 origin/main만 한 커밋 전진시킨다.
    git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    git(repo, ['checkout', '-qb', 'remote-main'])
    writeFileSync(join(repo, 'remote.txt'), 'already on origin\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-qm', 'remote change'])
    git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])

    // workspace가 최신 origin에서 분기했다면 remote.txt는 자기 변경으로 보이면 안 된다.
    git(repo, ['checkout', '-qb', 'feat/work'])
    writeFileSync(join(repo, 'mine.txt'), 'workspace change\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-qm', 'workspace change'])

    const diff = await getDiff(repo, 'main')

    expect(diff.baseBranch).toBe('origin/main')
    expect(diff.files.map((file) => file.path)).toEqual(['mine.txt'])
  })

  /**
   * 회귀: 증감은 접두사로 셌는데 `+++`/`---` 는 헤더로 보고 건너뛰었다. 그래서 본문이 `+`·`-`
   * 로 시작하는 파일(diff·패치를 커밋하는 경우가 대표적)은 추가된 줄이 통째로 빠져 숫자가
   * 실제와 어긋났다. 헤더는 `@@` 앞에만 오므로 위치로 가른다.
   */
  it('본문이 +++/--- 로 시작하는 줄도 빠짐없이 센다', async () => {
    git(repo, ['checkout', '-qb', 'feat/patch'])
    // 패치 파일 하나를 통째로 새로 넣는다 — 4줄 모두 추가로 잡혀야 한다.
    writeFileSync(join(repo, 'fix.patch'), '--- a/x\n+++ b/x\n-old line\n+new line\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-qm', 'add patch file'])

    const diff = await getDiff(repo, 'main')
    const file = diff.files.find((f) => f.path === 'fix.patch')

    expect(file).toBeDefined()
    expect(file?.additions).toBe(4)
    expect(file?.deletions).toBe(0)
  })
})

// 스택 인계문에 실리는 요약이다. 자식이 물려받은 코드를 알아내려고 첫 턴을 태우지 않게 하는
// 것이 목적이라, **부모가 한 일만** 담기는지(base 쪽 커밋이 섞이지 않는지)가 핵심이다.
describe('summarizeBranch (물려받은 코드 요약)', () => {
  let base: string
  let repo: string

  const git = (cwd: string, args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()

  const commit = (file: string, body: string, message: string): void => {
    writeFileSync(join(repo, file), body)
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-qm', message])
  }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'wooi-summary-'))
    repo = join(base, 'repo')
    mkdirSync(repo)
    git(repo, ['init', '-q', '-b', 'main'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    git(repo, ['config', 'user.name', 'test'])
    commit('README.md', 'hello\n', 'init')
    git(repo, ['checkout', '-qb', 'feat/work'])
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('base 이후의 커밋과 바뀐 파일을 모은다', async () => {
    commit('calc.js', 'a\nb\nc\n', 'feat: engine')

    const summary = await summarizeBranch(repo, 'main')

    expect(summary?.commits).toHaveLength(1)
    expect(summary?.commits[0]).toContain('feat: engine')
    expect(summary?.files).toEqual(['calc.js (+3 −0)'])
  })

  it('base 가 분기 후 전진해도 base 쪽 커밋을 담지 않는다', async () => {
    commit('calc.js', 'a\n', 'feat: engine')
    git(repo, ['checkout', '-q', 'main'])
    commit('other.js', 'x\n', 'chore: unrelated main work')
    git(repo, ['checkout', '-q', 'feat/work'])

    const summary = await summarizeBranch(repo, 'main')

    // merge-base 기준이라 main 의 새 커밋은 "내가 물려주는 것" 이 아니다.
    expect(summary?.commits.join('\n')).not.toContain('unrelated')
    expect(summary?.files).toEqual(['calc.js (+1 −0)'])
  })

  it('변경량이 큰 파일이 앞에 온다 — 잘릴 때 요점이 남아야 한다', async () => {
    writeFileSync(join(repo, 'small.js'), 'a\n')
    writeFileSync(join(repo, 'big.js'), 'a\n'.repeat(50))
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-qm', 'feat: two files'])

    const summary = await summarizeBranch(repo, 'main')

    expect(summary?.files[0]).toContain('big.js')
  })

  it('base 이후 아무것도 없으면 null 이다 — 빈 절을 인계문에 붙이지 않는다', async () => {
    await expect(summarizeBranch(repo, 'main')).resolves.toBeNull()
  })

  it('base ref 가 없으면 던지지 않고 null 이다', async () => {
    commit('calc.js', 'a\n', 'feat: engine')
    await expect(summarizeBranch(repo, 'no-such-branch')).resolves.toBeNull()
  })

  // Wooi 워크트리는 base 를 체크아웃하지 않아 로컬 ref 가 늘 낡아 있다. 낡은 쪽만 보면 base 에서
  // 당겨 온 커밋이 이 브랜치 몫으로 잡혀, 자식에게 남의 작업을 물려준 것처럼 알려 준다.
  it('로컬 base 가 낡았으면 upstream 을 기준으로 삼는다', async () => {
    const remote = join(base, 'remote.git')
    git(repo, ['init', '-q', '--bare', remote])
    git(repo, ['remote', 'add', 'origin', remote])
    git(repo, ['checkout', '-q', 'main'])
    git(repo, ['push', '-q', '-u', 'origin', 'main'])

    // origin/main 만 전진시키고 로컬 main 은 그대로 둔다.
    git(repo, ['checkout', '-qb', 'tmp'])
    commit('release.txt', 'v1\n', 'release: v1.9.0')
    git(repo, ['push', '-q', 'origin', 'tmp:main'])
    git(repo, ['fetch', '-q', 'origin'])

    // 워크스페이스는 그 릴리즈 커밋을 당겨 온 뒤 자기 작업을 얹는다.
    git(repo, ['checkout', '-q', 'feat/work'])
    git(repo, ['merge', '-q', '--ff-only', 'tmp'])
    commit('calc.js', 'a\n', 'feat: engine')

    const summary = await summarizeBranch(repo, 'main')

    expect(summary?.commits.join('\n')).not.toContain('release: v1.9.0')
    expect(summary?.files).toEqual(['calc.js (+1 −0)'])
  })
})

describe('summarizePushError (거부 사유 한 줄로 다듬기)', () => {
  // 실측한 stderr 다. 진짜 사유는 끝줄이 아니라 그 위에 있다.
  it('skips the boilerplate tail that every push failure carries', () => {
    expect(
      summarizePushError(
        [
          'npm error Lifecycle script `typecheck` failed with error:',
          'npm error command failed',
          "error: failed to push some refs to '../remote.git'"
        ].join('\n')
      )
    ).toBe('npm error Lifecycle script `typecheck` failed with error: — npm error command failed')
  })

  it('keeps the rejection line and drops git hints', () => {
    expect(
      summarizePushError(
        [
          'To ../remote.git',
          ' ! [rejected]        feat/x -> feat/x (stale info)',
          "error: failed to push some refs to '../remote.git'",
          'hint: Updates were rejected because the remote contains work that you do not have.'
        ].join('\n')
      )
    ).toBe('! [rejected]        feat/x -> feat/x (stale info)')
  })

  it('falls back rather than returning an empty reason', () => {
    expect(summarizePushError('')).toBe('git push failed.')
    expect(summarizePushError('hint: nothing but hints\n')).toBe('git push failed.')
    // 상투구밖에 없으면 그거라도 보여 준다 — 침묵보다는 낫다.
    expect(summarizePushError("error: failed to push some refs to 'x'")).toBe(
      "error: failed to push some refs to 'x'"
    )
  })

  it('caps a runaway stderr so a toast stays readable', () => {
    const summary = summarizePushError('x'.repeat(1000))
    expect(summary).toHaveLength(300)
    expect(summary.endsWith('…')).toBe(true)
  })
})

describe('restackOnto — push 가 거부되면 조용히 넘어가지 않는다', () => {
  let root: string
  let worktree: string
  let origin: string

  const git = (cwd: string, args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()

  /** pre-push 훅이 거부하게 만든다(실제 사고에서는 낡은 node_modules 로 typecheck 가 깨졌다). */
  const rejectPush = (): void => {
    const hook = join(worktree, '.git', 'hooks', 'pre-push')
    writeFileSync(hook, '#!/bin/sh\necho "npm error command failed" 1>&2\nexit 1\n')
    chmodSync(hook, 0o755)
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wooi-restack-push-'))
    origin = join(root, 'origin.git')
    worktree = join(root, 'worktree')
    git(root, ['init', '-q', '--bare', '-b', 'main', origin])
    execFileSync('git', ['clone', '-q', origin, worktree])
    git(worktree, ['config', 'user.email', 'test@example.com'])
    git(worktree, ['config', 'user.name', 'test'])
    writeFileSync(join(worktree, 'base.txt'), 'one\n')
    git(worktree, ['add', '-A'])
    git(worktree, ['commit', '-qm', 'base'])
    git(worktree, ['push', '-q', '-u', 'origin', 'main'])
    // 브랜치를 내고 한 번은 성공적으로 push 한다(=PR 이 열린 상태).
    git(worktree, ['checkout', '-qb', 'fix/x'])
    writeFileSync(join(worktree, 'mine.txt'), 'mine\n')
    git(worktree, ['add', '-A'])
    git(worktree, ['commit', '-qm', 'mine'])
    git(worktree, ['push', '-q', '-u', 'origin', 'fix/x'])
    // 그사이 main 이 움직인다 — 이게 restack 을 부르는 이유다.
    const other = join(root, 'other')
    execFileSync('git', ['clone', '-q', origin, other])
    git(other, ['config', 'user.email', 'other@example.com'])
    git(other, ['config', 'user.name', 'other'])
    writeFileSync(join(other, 'theirs.txt'), 'theirs\n')
    git(other, ['add', '-A'])
    git(other, ['commit', '-qm', 'theirs'])
    git(other, ['push', '-q', 'origin', 'main'])
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('rebases but reports the rejection instead of claiming success', async () => {
    rejectPush()
    const before = git(worktree, ['rev-parse', 'origin/fix/x'])

    const res = await restackOnto(worktree, 'main')

    // rebase 자체는 성공했다 — status 는 그 사실을 그대로 말한다.
    expect(res.status).toBe('restacked')
    expect(res.pushed).toBe(false)
    expect(res.pushError).toBe('npm error command failed')
    // 로컬은 새 base 위로 옮겨졌고 리모트는 옛 커밋 그대로다. 이 어긋남이 사고의 씨앗이었다.
    expect(git(worktree, ['rev-parse', 'origin/main^{commit}'])).toBe(
      git(worktree, ['rev-parse', 'HEAD~1'])
    )
    expect(git(worktree, ['rev-parse', 'origin/fix/x'])).toBe(before)
  })

  it('reports a rejection even when there was nothing to rebase', async () => {
    // base 를 이미 따라잡은 뒤라 rebase 는 필요 없지만, 아직 push 되지 않은 커밋이 있다.
    await restackOnto(worktree, 'main')
    rejectPush()
    writeFileSync(join(worktree, 'more.txt'), 'more\n')
    git(worktree, ['add', '-A'])
    git(worktree, ['commit', '-qm', 'more'])

    const res = await restackOnto(worktree, 'main')

    expect(res.status).toBe('up-to-date')
    expect(res.pushed).toBe(false)
    expect(res.pushError).toBe('npm error command failed')
  })

  it('leaves pushError unset when the push simply succeeds', async () => {
    const res = await restackOnto(worktree, 'main')
    expect(res).toMatchObject({ status: 'restacked', pushed: true })
    expect(res.pushError).toBeUndefined()
    expect(git(worktree, ['rev-parse', 'origin/fix/x'])).toBe(git(worktree, ['rev-parse', 'HEAD']))
  })
})

describe('lastRemoteRefUpdate (리모트 추적 ref 를 마지막으로 움직인 것)', () => {
  let root: string
  let worktree: string
  let origin: string

  const git = (cwd: string, args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wooi-remote-reflog-'))
    origin = join(root, 'origin.git')
    worktree = join(root, 'worktree')
    git(root, ['init', '-q', '--bare', '-b', 'main', origin])
    execFileSync('git', ['clone', '-q', origin, worktree])
    git(worktree, ['config', 'user.email', 'test@example.com'])
    git(worktree, ['config', 'user.name', 'test'])
    writeFileSync(join(worktree, 'base.txt'), 'one\n')
    git(worktree, ['add', '-A'])
    git(worktree, ['commit', '-qm', 'base'])
    git(worktree, ['push', '-q', '-u', 'origin', 'main'])
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('says nothing about a branch the remote has never seen', async () => {
    await expect(lastRemoteRefUpdate(worktree, 'never-pushed')).resolves.toBeNull()
    await expect(lastRemoteRefUpdate(worktree, '')).resolves.toBeNull()
  })

  it('records our own push with the exact reason we match on', async () => {
    const last = await lastRemoteRefUpdate(worktree, 'main')
    expect(last).toEqual({ sha: git(worktree, ['rev-parse', 'HEAD']), reason: 'update by push' })
  })

  it('does not gain an entry when a push is rejected', async () => {
    const before = await lastRemoteRefUpdate(worktree, 'main')
    const hook = join(worktree, '.git', 'hooks', 'pre-push')
    writeFileSync(hook, '#!/bin/sh\nexit 1\n')
    chmodSync(hook, 0o755)
    writeFileSync(join(worktree, 'base.txt'), 'two\n')
    git(worktree, ['commit', '-qam', 'two'])
    expect(() => git(worktree, ['push', 'origin', 'main'])).toThrow()

    // 이 사실이 판정의 토대다 — 실패한 push 는 흔적을 남기지 않으므로, 마지막 항목은
    // 여전히 마지막으로 **성공한** push 다.
    await expect(lastRemoteRefUpdate(worktree, 'main')).resolves.toEqual(before)
  })

  it('marks a remote that moved outside this repo as a fetch, not a push', async () => {
    const other = join(root, 'other')
    execFileSync('git', ['clone', '-q', origin, other])
    git(other, ['config', 'user.email', 'other@example.com'])
    git(other, ['config', 'user.name', 'other'])
    // 서버측 rebase 처럼 tip 을 **다시 쓴다**(얹는 게 아니라) — GitHub 이 스택 위 브랜치에 하는 일이다.
    writeFileSync(join(other, 'base.txt'), 'rewritten\n')
    git(other, ['commit', '-qam', 'rewritten', '--amend'])
    git(other, ['push', '-q', '--force', 'origin', 'main'])

    git(worktree, ['fetch', '-q', 'origin'])
    const last = await lastRemoteRefUpdate(worktree, 'main')
    expect(last?.sha).toBe(git(other, ['rev-parse', 'HEAD']))
    expect(last?.reason).not.toBe('update by push')
    expect(last?.reason).toContain('forced-update')
  })

  it('leaves the entry alone when a fetch changes nothing', async () => {
    const before = await lastRemoteRefUpdate(worktree, 'main')
    git(worktree, ['fetch', '-q', 'origin'])
    // restackOnto 는 push 직전에 fetch 한다. 그 fetch 가 판정을 흐리지 않아야 뜻이 있다.
    await expect(lastRemoteRefUpdate(worktree, 'main')).resolves.toEqual(before)
  })
})

describe('worktree fork 기반과 변경 스냅샷', () => {
  let base: string
  let repo: string

  const git = (cwd: string, args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'wooi-fork-git-'))
    repo = join(base, 'repo')
    mkdirSync(repo)
    git(repo, ['init', '-q', '-b', 'main'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    git(repo, ['config', 'user.name', 'test'])
    writeFileSync(join(repo, 'tracked.txt'), 'base\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-qm', 'base'])
    git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  })

  afterEach(() => rmSync(base, { recursive: true, force: true }))

  it('명시한 startPoint 의 로컬 전용 커밋에서 새 worktree 를 만든다', async () => {
    git(repo, ['checkout', '-qb', 'source'])
    writeFileSync(join(repo, 'local-only.txt'), 'local\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-qm', 'local only'])

    const target = join(base, 'explicit')
    await addWorktree(repo, 'fork', 'main', target, git(repo, ['rev-parse', 'source']))

    expect(git(target, ['show', 'HEAD:local-only.txt'])).toBe('local')
  })

  it('startPoint 를 생략하면 기존처럼 origin/base 에서 만든다', async () => {
    git(repo, ['checkout', '-qb', 'local-main'])
    writeFileSync(join(repo, 'local-only.txt'), 'local\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-qm', 'local only'])
    git(repo, ['branch', '-f', 'main', 'HEAD'])

    const target = join(base, 'default')
    await addWorktree(repo, 'ordinary', 'main', target)

    expect(git(target, ['rev-parse', 'HEAD'])).toBe(git(repo, ['rev-parse', 'origin/main']))
  })

  it('dirty tree 를 stash 스택과 원본 상태를 바꾸지 않고 스냅샷한다', async () => {
    writeFileSync(join(repo, 'tracked.txt'), 'changed\n')

    const sha = await snapshotWorkingTree(repo)

    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    expect(git(repo, ['status', '--porcelain'])).toContain('tracked.txt')
    expect(git(repo, ['stash', 'list'])).toBe('')
  })

  it('깨끗하면 스냅샷을 만들지 않는다', async () => {
    await expect(snapshotWorkingTree(repo)).resolves.toBeNull()
  })

  it('스냅샷을 다른 worktree 의 미커밋 변경으로 적용한다', async () => {
    const target = join(base, 'target')
    await addWorktree(repo, 'target', 'main', target, git(repo, ['rev-parse', 'HEAD']))
    writeFileSync(join(repo, 'tracked.txt'), 'changed\n')
    const sha = await snapshotWorkingTree(repo)

    await applySnapshot(target, sha!)

    expect(git(target, ['diff', '--', 'tracked.txt'])).toContain('+changed')
    expect(git(target, ['status', '--porcelain'])).toContain('tracked.txt')
  })
})
