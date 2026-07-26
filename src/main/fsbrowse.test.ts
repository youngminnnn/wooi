import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { searchFiles } from './fsbrowse'

const exec = promisify(execFile)

/** 테스트용 worktree 를 하나 만든다. git 저장소 여부로 인덱스 소스가 갈린다. */
async function makeTree(asGitRepo: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wooi-fsbrowse-'))
  await mkdir(join(root, 'src', 'main'), { recursive: true })
  await mkdir(join(root, 'src', 'renderer'), { recursive: true })
  await mkdir(join(root, 'docs'), { recursive: true })

  await writeFile(join(root, 'README.md'), '# readme\n')
  await writeFile(join(root, 'src', 'index.ts'), 'export const a = 1\n')
  await writeFile(join(root, 'src', 'main', 'git.ts'), 'x'.repeat(4096))
  await writeFile(join(root, 'src', 'renderer', 'gitPanel.tsx'), 'y\n')
  await writeFile(join(root, 'docs', 'guide.md'), 'z\n')
  await writeFile(join(root, 'secret.log'), 'ignored\n')
  await writeFile(join(root, '.gitignore'), 'secret.log\n')

  if (asGitRepo) {
    await exec('git', ['init', '-q'], { cwd: root })
  }
  return root
}

describe('searchFiles (git 저장소)', () => {
  let root: string
  beforeAll(async () => {
    root = await makeTree(true)
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const paths = async (q: string): Promise<string[]> =>
    (await searchFiles(root, q)).map((h) => h.path)

  it('파일명 접두사 매치를 경로 부분 매치보다 위로 올린다', async () => {
    const got = await paths('git')
    // git.ts / gitPanel.tsx 는 파일명이 'git' 으로 시작 — 경로에만 git 이 든 항목보다 앞.
    expect(got[0]).toBe('src/main/git.ts')
    expect(got.slice(0, 2)).toContain('src/renderer/gitPanel.tsx')
  })

  it('디렉토리도 후보로 돌려준다', async () => {
    const hits = await searchFiles(root, 'renderer')
    const dir = hits.find((h) => h.path === 'src/renderer')
    expect(dir).toBeDefined()
    expect(dir?.isDir).toBe(true)
  })

  it('경로 조각 질의는 경로 전체로 맞춘다', async () => {
    expect(await paths('src/ma')).toContain('src/main/git.ts')
  })

  it('연속하지 않아도 순서만 맞으면 퍼지로 잡는다', async () => {
    // 'dgd' → docs/guide.md 의 d..g..d
    expect(await paths('dgd')).toContain('docs/guide.md')
  })

  it('.gitignore 된 파일은 후보에서 빠진다', async () => {
    expect(await paths('secret')).not.toContain('secret.log')
  })

  it('파일 후보에는 크기를 붙이고 디렉토리에는 붙이지 않는다', async () => {
    const hits = await searchFiles(root, 'git.ts')
    const file = hits.find((h) => h.path === 'src/main/git.ts')
    expect(file?.size).toBe(4096)

    const dirs = await searchFiles(root, 'renderer')
    expect(dirs.find((h) => h.isDir)?.size).toBeUndefined()
  })

  it('빈 질의는 얕은 경로부터 돌려준다', async () => {
    const got = await paths('')
    expect(got.length).toBeGreaterThan(0)
    const depth = (p: string): number => p.split('/').length
    // 정렬이 깊이 오름차순이어야 한다.
    expect(depth(got[0])).toBeLessThanOrEqual(depth(got[got.length - 1]))
  })

  it('아무것도 맞지 않으면 빈 배열', async () => {
    expect(await paths('zzzzzzzz')).toEqual([])
  })

  it('limit 을 넘겨 받지 않는다', async () => {
    expect((await searchFiles(root, '', 2)).length).toBe(2)
  })
})

describe('searchFiles (git 이 아닌 디렉토리 폴백)', () => {
  let root: string
  beforeAll(async () => {
    root = await makeTree(false)
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('git 없이도 파일을 찾는다', async () => {
    const got = (await searchFiles(root, 'guide')).map((h) => h.path)
    expect(got).toContain('docs/guide.md')
  })

  it('폴백에서는 .gitignore 를 적용하지 않는다(git 이 없으니 알 수 없다)', async () => {
    const got = (await searchFiles(root, 'secret')).map((h) => h.path)
    expect(got).toContain('secret.log')
  })
})
