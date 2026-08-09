import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  sanitizeBranch,
  parseGithubOwner,
  ghMergeBase,
  syncGhMergeBase,
  summarizeBranch
} from './git'

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
