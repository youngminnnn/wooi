import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { moveCommitDownLocal } from './git'
import { moveCommitDown, type CommitMoveWorkspace } from './commitMove'

interface Fixture {
  root: string
  lower: string
  upper: string
  commits: string[]
}

const roots: string[] = []
const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'wooi-commit-move-'))
  roots.push(root)
  const lower = join(root, 'lower')
  const upper = join(root, 'upper')
  mkdirSync(lower)
  git(lower, ['init', '-q', '-b', 'main'])
  git(lower, ['config', 'user.email', 'test@example.com'])
  git(lower, ['config', 'user.name', 'test'])
  writeFileSync(join(lower, 'base.txt'), 'base\n')
  git(lower, ['add', '-A'])
  git(lower, ['commit', '-qm', 'base'])
  git(lower, ['checkout', '-qb', 'lower'])
  writeFileSync(join(lower, 'lower.txt'), 'lower\n')
  git(lower, ['add', '-A'])
  git(lower, ['commit', '-qm', 'lower'])
  git(lower, ['worktree', 'add', '-q', upper, '-b', 'upper', 'lower'])
  const commits: string[] = []
  for (const name of ['oldest', 'middle', 'newest']) {
    writeFileSync(join(upper, `${name}.txt`), `${name}\n`)
    git(upper, ['add', '-A'])
    git(upper, ['commit', '-qm', name])
    commits.push(git(upper, ['rev-parse', 'HEAD']))
  }
  return { root, lower, upper, commits }
}

function workspace(f: Fixture): CommitMoveWorkspace[] {
  return [
    {
      id: 'lower',
      branch: 'lower',
      baseBranch: 'main',
      worktreePath: f.lower,
      prNumber: 1,
      status: 'idle',
      parentWorkspaceId: null
    },
    {
      id: 'upper',
      branch: 'upper',
      baseBranch: 'lower',
      worktreePath: f.upper,
      prNumber: 2,
      status: 'idle',
      parentWorkspaceId: 'lower'
    }
  ]
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.each([
  ['가장 오래된', 0, 'oldest.txt'],
  ['중간', 1, 'middle.txt'],
  ['가장 최신', 2, 'newest.txt']
])('%s 커밋 이동', (_label, index, movedPath) => {
  it('HEAD 와 각 레이어 diff 를 섞지 않는다', async () => {
    const f = fixture()
    const result = await moveCommitDownLocal({
      lowerWorktree: f.lower,
      lowerBranch: 'lower',
      upperWorktree: f.upper,
      upperBranch: 'upper',
      sha: f.commits[index]
    })
    expect(result.ok).toBe(true)
    expect(git(f.upper, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('upper')
    expect(git(f.lower, ['diff', '--name-only', 'main..lower']).split('\n')).toContain(movedPath)
    expect(git(f.upper, ['diff', '--name-only', 'lower..upper']).split('\n')).not.toContain(
      movedPath
    )
    const upperLayer = git(f.upper, ['diff', '--name-only', 'lower..upper']).split('\n')
    const expected = ['oldest.txt', 'middle.txt', 'newest.txt'].filter((p) => p !== movedPath)
    expect(upperLayer.sort()).toEqual(expected.sort())
    expect(git(f.lower, ['diff', '--name-only', 'main..lower']).split('\n').sort()).toEqual(
      ['lower.txt', movedPath].sort()
    )
  })
})

it('cherry-pick 충돌이면 두 브랜치와 두 워크트리를 정확히 복구한다', async () => {
  const f = fixture()
  writeFileSync(join(f.upper, 'dependent.txt'), 'first\n')
  git(f.upper, ['add', '-A'])
  git(f.upper, ['commit', '-qm', 'dependency'])
  writeFileSync(join(f.upper, 'dependent.txt'), 'first\nsecond\n')
  git(f.upper, ['commit', '-qam', 'dependent change'])
  const sha = git(f.upper, ['rev-parse', 'HEAD'])
  const lowerBefore = git(f.lower, ['rev-parse', 'lower'])
  const upperBefore = git(f.upper, ['rev-parse', 'upper'])

  const result = await moveCommitDownLocal({
    lowerWorktree: f.lower,
    lowerBranch: 'lower',
    upperWorktree: f.upper,
    upperBranch: 'upper',
    sha
  })
  expect(result).toMatchObject({ ok: false, step: 'cherry-pick', rolledBack: true })
  expect(git(f.lower, ['rev-parse', 'lower'])).toBe(lowerBefore)
  expect(git(f.upper, ['rev-parse', 'upper'])).toBe(upperBefore)
  expect(git(f.lower, ['status', '--porcelain'])).toBe('')
  expect(git(f.upper, ['status', '--porcelain'])).toBe('')
  expect(git(f.upper, ['branch', '--list', 'wooi/commit-move-' + sha.slice(0, 12)])).toBe('')
})

it('dirty 워크트리면 오케스트레이션이 어떤 ref 도 쓰지 않는다', async () => {
  const f = fixture()
  const before = [git(f.lower, ['rev-parse', 'lower']), git(f.upper, ['rev-parse', 'upper'])]
  writeFileSync(join(f.lower, 'dirty.txt'), 'dirty\n')
  const result = await moveCommitDown({
    workspaces: workspace(f),
    upperWorkspaceId: 'upper',
    sha: f.commits[1]
  })
  expect(result.status).toBe('blocked')
  expect(result.blockers).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: 'dirty' })])
  )
  expect([git(f.lower, ['rev-parse', 'lower']), git(f.upper, ['rev-parse', 'upper'])]).toEqual(
    before
  )
})

it('모델 B 워크스페이스면 어떤 ref 도 쓰지 않는다', async () => {
  const f = fixture()
  const entries = workspace(f)
  entries[1].stack = [
    { branch: 'one', baseBranch: 'lower', prNumber: null },
    { branch: 'two', baseBranch: 'one', prNumber: null }
  ]
  const before = git(f.upper, ['rev-parse', 'upper'])
  const result = await moveCommitDown({
    workspaces: entries,
    upperWorkspaceId: 'upper',
    sha: f.commits[1]
  })
  expect(result.status).toBe('blocked')
  expect(result.blockers).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: 'model-b' })])
  )
  expect(git(f.upper, ['rev-parse', 'upper'])).toBe(before)
})

it('origin 이 로컬과 갈라졌으면 어떤 ref 도 쓰지 않는다', async () => {
  const f = fixture()
  const bare = join(f.root, 'origin.git')
  git(f.lower, ['init', '-q', '--bare', bare])
  git(f.lower, ['remote', 'add', 'origin', bare])
  git(f.lower, ['push', '-q', 'origin', 'lower', 'upper'])
  const remoteWork = join(f.root, 'remote-work')
  git(f.lower, ['clone', '-q', '--branch', 'upper', bare, remoteWork])
  git(remoteWork, ['config', 'user.email', 'remote@example.com'])
  git(remoteWork, ['config', 'user.name', 'remote'])
  writeFileSync(join(remoteWork, 'remote.txt'), 'remote\n')
  git(remoteWork, ['add', '-A'])
  git(remoteWork, ['commit', '-qm', 'remote rewrite'])
  git(remoteWork, ['push', '-q', '--force', 'origin', 'upper'])
  const before = git(f.upper, ['rev-parse', 'upper'])
  const result = await moveCommitDown({
    workspaces: workspace(f),
    upperWorkspaceId: 'upper',
    sha: f.commits[1]
  })
  expect(result.status).toBe('blocked')
  expect(result.blockers).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: 'diverged', branch: 'upper' })])
  )
  expect(git(f.upper, ['rev-parse', 'upper'])).toBe(before)
})
