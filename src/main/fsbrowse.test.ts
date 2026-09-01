import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, chmod, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { listDir, readFileInRoot, searchFiles, writeFileInRoot } from './fsbrowse'

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

/**
 * 파일 뷰어는 읽기 전용이지만 격리는 격리다. `resolve()` 는 `..` 밖에 못 막으므로, worktree
 * 안의 링크 하나가 밖을 가리키면 그대로 열렸다 — 워크트리 안의 파일은 에이전트가 만든 것이기도
 * 해서 링크를 심는 쪽과 읽는 쪽이 다른 사람일 필요도 없다.
 */
describe('worktree 밖 접근 차단', () => {
  let root: string
  let outside: string

  beforeAll(async () => {
    root = await makeTree(false)
    // root 의 형제 디렉토리 — worktree 밖이지만 `..` 없이 링크로는 닿는다.
    outside = await mkdtemp(join(tmpdir(), 'wooi-fsbrowse-outside-'))
    await writeFile(join(outside, 'secrets.txt'), 'token=hunter2\n')
    await mkdir(join(outside, 'nested'), { recursive: true })
    await writeFile(join(outside, 'nested', 'more.txt'), 'more\n')

    await symlink(join(outside, 'secrets.txt'), join(root, 'link-to-secret'))
    await symlink(outside, join(root, 'link-to-dir'))
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  it('`..` 로는 나가지 못한다', async () => {
    expect(await readFileInRoot(root, '../' + 'etc/hosts')).toBeNull()
    expect(await listDir(root, '..')).toEqual([])
  })

  it('밖을 가리키는 링크는 읽히지 않는다', async () => {
    expect(await readFileInRoot(root, 'link-to-secret')).toBeNull()
  })

  it('밖을 가리키는 링크 디렉토리는 나열되지 않는다', async () => {
    expect(await listDir(root, 'link-to-dir')).toEqual([])
    expect(await readFileInRoot(root, 'link-to-dir/nested/more.txt')).toBeNull()
  })

  // 안쪽을 가리키는 링크까지 막으면 멀쩡한 워크트리가 반쯤 안 보인다.
  it('안을 가리키는 링크는 그대로 읽힌다', async () => {
    await symlink(join(root, 'README.md'), join(root, 'link-to-readme'))
    const got = await readFileInRoot(root, 'link-to-readme')
    expect(got?.text).toContain('# readme')
  })

  // root 자체가 링크 뒤에 있어도(macOS 의 /tmp → /private/tmp) 안쪽이 전부 "밖" 이 되면 안 된다.
  it('root 가 링크 뒤에 있어도 안쪽은 그대로 읽힌다', async () => {
    const alias = join(dirname(root), `alias-${Date.now()}`)
    await symlink(root, alias)
    try {
      const got = await readFileInRoot(alias, 'README.md')
      expect(got?.text).toContain('# readme')
      expect((await listDir(alias, 'src')).map((e) => e.name)).toContain('index.ts')
    } finally {
      await rm(alias, { force: true })
    }
  })
})

describe('writeFileInRoot', () => {
  let root: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'wooi-fswrite-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(join(root, 'outside-target'), { recursive: true })
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  /** 파일을 새로 깔고 지금 내용의 sha 를 돌려준다. */
  async function seed(rel: string, text: string): Promise<string> {
    await writeFile(join(root, rel), text)
    const got = await readFileInRoot(root, rel)
    if (!got) throw new Error(`seed failed: ${rel}`)
    return got.sha
  }

  it('열었을 때와 디스크가 같으면 저장하고 새 sha 를 돌려준다', async () => {
    const sha = await seed('src/a.ts', 'const a = 1\n')
    const res = await writeFileInRoot(root, 'src/a.ts', 'const a = 2\n', sha)

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.content.text).toBe('const a = 2\n')
    // 새 baseline 이 와야 연달아 저장할 수 있다.
    expect(res.content.sha).not.toBe(sha)
    expect(await readFile(join(root, 'src/a.ts'), 'utf-8')).toBe('const a = 2\n')
  })

  it('그 사이 남이 고쳤으면 쓰지 않고 지금 내용을 함께 돌려준다', async () => {
    const stale = await seed('src/b.ts', 'original\n')
    // 에이전트가 같은 파일을 고친 상황.
    await writeFile(join(root, 'src/b.ts'), 'agent wrote this\n')

    const res = await writeFileInRoot(root, 'src/b.ts', 'my edit\n', stale)

    expect(res).toMatchObject({ ok: false, reason: 'conflict', conflict: 'stale' })
    if (res.ok || res.reason !== 'conflict') return
    // 사용자가 덮어쓸지 버릴지 고르려면 상대편 내용을 볼 수 있어야 한다.
    expect(res.current?.text).toBe('agent wrote this\n')
    // 무엇보다, 디스크는 손대지 않았어야 한다.
    expect(await readFile(join(root, 'src/b.ts'), 'utf-8')).toBe('agent wrote this\n')
  })

  it('force 면 남이 고친 내용을 덮어쓴다', async () => {
    const stale = await seed('src/c.ts', 'original\n')
    await writeFile(join(root, 'src/c.ts'), 'agent wrote this\n')

    const res = await writeFileInRoot(root, 'src/c.ts', 'my edit\n', stale, { force: true })

    expect(res.ok).toBe(true)
    expect(await readFile(join(root, 'src/c.ts'), 'utf-8')).toBe('my edit\n')
  })

  it('파일이 사라졌으면 vanished 로 막는다', async () => {
    const sha = await seed('src/d.ts', 'bye\n')
    await rm(join(root, 'src/d.ts'))

    const res = await writeFileInRoot(root, 'src/d.ts', 'back\n', sha)

    expect(res).toMatchObject({ ok: false, reason: 'conflict', conflict: 'vanished' })
    if (res.ok || res.reason !== 'conflict') return
    expect(res.current).toBeNull()
  })

  it('사라진 파일도 force 면 되살린다', async () => {
    const sha = await seed('src/e.ts', 'bye\n')
    await rm(join(root, 'src/e.ts'))

    const res = await writeFileInRoot(root, 'src/e.ts', 'back\n', sha, { force: true })

    expect(res.ok).toBe(true)
    expect(await readFile(join(root, 'src/e.ts'), 'utf-8')).toBe('back\n')
  })

  it('baseline 없이 저장하려 하면 막는다', async () => {
    await seed('src/f.ts', 'keep\n')
    const res = await writeFileInRoot(root, 'src/f.ts', 'clobber\n', null)

    expect(res).toMatchObject({ ok: false, reason: 'conflict', conflict: 'stale' })
    expect(await readFile(join(root, 'src/f.ts'), 'utf-8')).toBe('keep\n')
  })

  // 읽기와 같은 격리 규칙을 쓰기에도 건다 — 여기가 뚫리면 워크스페이스 격리가 무의미해진다.
  it('worktree 밖 경로는 쓰지 않는다', async () => {
    const res = await writeFileInRoot(root, '../escaped.txt', 'nope\n', null, { force: true })
    expect(res).toEqual({ ok: false, reason: 'denied' })
  })

  it('밖을 가리키는 링크로도 쓰지 않는다', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'wooi-fswrite-out-'))
    try {
      await writeFile(join(outside, 'target.txt'), 'untouched\n')
      await symlink(join(outside, 'target.txt'), join(root, 'link-out'))

      const res = await writeFileInRoot(root, 'link-out', 'pwned\n', null, { force: true })

      expect(res).toEqual({ ok: false, reason: 'denied' })
      expect(await readFile(join(outside, 'target.txt'), 'utf-8')).toBe('untouched\n')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('디렉토리에는 쓰지 않는다', async () => {
    const res = await writeFileInRoot(root, 'src', 'nope\n', null, { force: true })
    expect(res).toEqual({ ok: false, reason: 'denied' })
  })

  // 실행 비트가 떨어지면 뷰어에서 오타 하나 고친 스크립트가 CI 에서 안 돌기 시작한다.
  it('실행 권한을 보존한다', async () => {
    const sha = await seed('run.sh', '#!/bin/sh\necho hi\n')
    await chmod(join(root, 'run.sh'), 0o755)
    const fresh = await readFileInRoot(root, 'run.sh')

    const res = await writeFileInRoot(root, 'run.sh', '#!/bin/sh\necho bye\n', fresh?.sha ?? sha)

    expect(res.ok).toBe(true)
    expect((await stat(join(root, 'run.sh'))).mode & 0o777).toBe(0o755)
  })

  it('임시 파일을 남기지 않는다', async () => {
    const sha = await seed('src/g.ts', 'a\n')
    await writeFileInRoot(root, 'src/g.ts', 'b\n', sha)
    expect((await listDir(root, 'src')).map((e) => e.name)).not.toContain('g.ts.tmp')
  })
})
