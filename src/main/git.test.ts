import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  fetchRemoteForRepo
} from './git'

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
