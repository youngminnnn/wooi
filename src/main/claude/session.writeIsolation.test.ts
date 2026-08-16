import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WriteIsolationGuard } from './writeIsolation'

function fixture(): {
  current: string
  other: string
  repo: string
  additional: string
  unrelated: string
  guard: WriteIsolationGuard
} {
  const root = mkdtempSync(join(tmpdir(), 'wooi-write-isolation-'))
  const current = join(root, 'current')
  const other = join(root, 'other-workspace')
  const repo = join(root, 'repo-foo')
  const additional = join(repo, 'additional')
  const unrelated = join(root, 'unrelated')
  for (const path of [current, other, repo, additional, unrelated]) mkdirSync(path)

  return {
    current,
    other,
    repo,
    additional,
    unrelated,
    guard: new WriteIsolationGuard(
      current,
      [current, additional],
      [
        { path: other, owner: 'workspace "other"' },
        { path: repo, owner: 'repository "repo" main checkout' }
      ]
    )
  }
}

const write = (guard: WriteIsolationGuard, cwd: string, filePath: string) =>
  guard.check('Write', { file_path: filePath, content: '' }, cwd)

describe('Claude session write isolation', () => {
  it('현재 worktree 안의 쓰기를 허용한다', async () => {
    const f = fixture()
    expect(await write(f.guard, f.current, join(f.current, 'new.ts'))).toBeNull()
  })

  it('다른 workspace worktree 쓰기를 거절한다', async () => {
    const f = fixture()
    expect(await write(f.guard, f.current, join(f.other, 'new.ts'))).toMatchObject({
      owner: 'workspace "other"'
    })
  })

  it('리포의 메인 checkout 쓰기를 거절한다', async () => {
    const f = fixture()
    expect(await write(f.guard, f.current, join(f.repo, 'new.ts'))).toMatchObject({
      owner: 'repository "repo" main checkout'
    })
  })

  it('additionalDirectories 루트와 무관한 임시 위치의 쓰기를 허용한다', async () => {
    const f = fixture()
    expect(await write(f.guard, f.current, join(f.additional, 'new.ts'))).toBeNull()
    expect(await write(f.guard, f.current, join(f.unrelated, 'new.ts'))).toBeNull()
  })

  it('.. 탐색이 금지 루트에 닿으면 거절한다', async () => {
    const f = fixture()
    expect(await write(f.guard, f.current, `${f.current}/../repo-foo/new.ts`)).not.toBeNull()
  })

  it('심볼릭 링크가 금지 루트로 이어지면 새 파일도 거절한다', async () => {
    const f = fixture()
    const link = join(f.unrelated, 'linked-repo')
    symlinkSync(f.repo, link)
    expect(await write(f.guard, f.current, join(link, 'not-created-yet.ts'))).not.toBeNull()
  })

  it('이름만 접두사가 같은 sibling 경로는 거절하지 않는다', async () => {
    const f = fixture()
    const sibling = `${f.repo}bar`
    mkdirSync(sibling)
    expect(await write(f.guard, f.current, join(sibling, 'new.ts'))).toBeNull()
  })

  it('읽기 도구와 Bash는 이 도구 수준 가드의 대상이 아니다', async () => {
    const f = fixture()
    expect(
      await f.guard.check('Read', { file_path: join(f.repo, 'file.ts') }, f.current)
    ).toBeNull()
    expect(
      await f.guard.check('Bash', { command: `touch ${join(f.repo, 'file.ts')}` }, f.current)
    ).toBeNull()
  })

  it.each([
    ['Edit', 'file_path'],
    ['Write', 'file_path'],
    ['NotebookEdit', 'notebook_path']
  ])('%s 의 SDK 쓰기 경로를 검사한다', async (tool, key) => {
    const f = fixture()
    expect(await f.guard.check(tool, { [key]: join(f.repo, 'target') }, f.current)).not.toBeNull()
  })
})
