import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { lstatSync, readlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  validateCarryPath,
  isAgentContextPath,
  agentContextItems,
  detectCarryItems,
  carryIntoWorktree,
  missingCarryPaths,
  applyCarryExcludes
} from './carry'

describe('validateCarryPath', () => {
  it('일반 상대 경로를 통과시킨다', () => {
    expect(validateCarryPath('CLAUDE.local.md')).toEqual({ ok: true, path: 'CLAUDE.local.md' })
    expect(validateCarryPath('.claude/settings.local.json')).toEqual({
      ok: true,
      path: '.claude/settings.local.json'
    })
  })

  it('앞뒤 공백과 중복 슬래시·`.` 를 정규화한다', () => {
    expect(validateCarryPath('  .env  ')).toEqual({ ok: true, path: '.env' })
    expect(validateCarryPath('a//b')).toEqual({ ok: true, path: 'a/b' })
    expect(validateCarryPath('./a/./b/')).toEqual({ ok: true, path: 'a/b' })
  })

  it('절대 경로를 거부한다', () => {
    expect(validateCarryPath('/etc/passwd').ok).toBe(false)
  })

  it('홈 상대 경로를 거부한다', () => {
    expect(validateCarryPath('~/.ssh/id_rsa').ok).toBe(false)
  })

  it('리포 밖으로 나가는 `..` 를 거부한다', () => {
    expect(validateCarryPath('../secrets').ok).toBe(false)
    expect(validateCarryPath('a/../../b').ok).toBe(false)
    expect(validateCarryPath('a/..').ok).toBe(false)
  })

  it('.git 은 거부한다 — worktree 메타데이터가 깨진다', () => {
    expect(validateCarryPath('.git').ok).toBe(false)
    expect(validateCarryPath('.git/config').ok).toBe(false)
    expect(validateCarryPath('a/.git/hooks').ok).toBe(false)
  })

  it('빈 경로를 거부한다', () => {
    expect(validateCarryPath('').ok).toBe(false)
    expect(validateCarryPath('   ').ok).toBe(false)
    expect(validateCarryPath('///').ok).toBe(false)
  })
})

describe('isAgentContextPath', () => {
  it('에이전트 컨텍스트 파일을 알아본다', () => {
    expect(isAgentContextPath('CLAUDE.local.md')).toBe(true)
    expect(isAgentContextPath('CLAUDE.md')).toBe(true)
    expect(isAgentContextPath('MEMORY.md')).toBe(true)
    expect(isAgentContextPath('AGENT.md')).toBe(true)
    expect(isAgentContextPath('AGENTS.md')).toBe(true)
    expect(isAgentContextPath('.claude/settings.local.json')).toBe(true)
    expect(isAgentContextPath('docs/CLAUDE.local.md')).toBe(true)
  })

  it('런타임 설정 파일은 컨텍스트로 보지 않는다', () => {
    expect(isAgentContextPath('.env')).toBe(false)
    expect(isAgentContextPath('.env.local')).toBe(false)
    expect(isAgentContextPath('node_modules')).toBe(false)
    expect(isAgentContextPath('certs/dev.pem')).toBe(false)
  })
})

describe('agentContextItems', () => {
  it('리뷰 워크트리에는 컨텍스트 파일만 남긴다', () => {
    const items = [
      { path: 'CLAUDE.local.md', mode: 'copy' as const },
      { path: '.claude/settings.local.json', mode: 'link' as const },
      { path: '.env', mode: 'copy' as const },
      { path: 'node_modules', mode: 'link' as const }
    ]
    expect(agentContextItems(items)).toEqual([
      { path: 'CLAUDE.local.md', mode: 'copy' },
      { path: '.claude/settings.local.json', mode: 'link' }
    ])
  })

  it('원본 모드를 그대로 유지한다', () => {
    expect(agentContextItems([{ path: 'MEMORY.md', mode: 'link' }])).toEqual([
      { path: 'MEMORY.md', mode: 'link' }
    ])
  })
})

// ── 실제 git 리포를 만들어 도는 통합 테스트 ────────────────────────────────

let base: string
let repo: string
let wt: string

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'wooi-carry-'))
  repo = join(base, 'main')
  wt = join(base, 'wt')
  mkdirSync(repo)
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'test'])
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n.env\nCLAUDE.local.md\nMEMORY.md\n')
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'init'])

  // gitignore 된 원본들 — worktree 에는 딸려오지 않는 것들이다.
  writeFileSync(join(repo, 'CLAUDE.local.md'), '원본 지침\n')
  writeFileSync(join(repo, 'MEMORY.md'), '누적 학습\n')
  writeFileSync(join(repo, '.env'), 'SECRET=원본\n')
  mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')

  git(repo, ['worktree', 'add', '-q', wt, '-b', 'feat'])
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('detectCarryItems', () => {
  it('실제로 존재하는 후보만 copy 모드로 채운다', () => {
    const items = detectCarryItems(repo)
    expect(items).toEqual([
      { path: 'CLAUDE.local.md', mode: 'copy' },
      { path: 'MEMORY.md', mode: 'copy' },
      { path: '.env', mode: 'copy' }
    ])
  })

  it('후보가 하나도 없으면 빈 목록', () => {
    expect(detectCarryItems(join(base, 'wt'))).toEqual([])
  })
})

describe('carryIntoWorktree', () => {
  it('copy 모드는 독립된 사본을 만든다', () => {
    const out = carryIntoWorktree(repo, wt, [{ path: '.env', mode: 'copy' }])
    expect(out.failures).toEqual([])
    expect(readFileSync(join(wt, '.env'), 'utf-8')).toBe('SECRET=원본\n')

    // 사본이므로 워크트리 쪽 수정이 원본으로 새지 않는다.
    writeFileSync(join(wt, '.env'), 'SECRET=워크트리\n')
    expect(readFileSync(join(repo, '.env'), 'utf-8')).toBe('SECRET=원본\n')
  })

  it('link 모드는 원본을 가리키는 심링크를 만든다', () => {
    const out = carryIntoWorktree(repo, wt, [{ path: 'CLAUDE.local.md', mode: 'link' }])
    expect(out.failures).toEqual([])
    expect(lstatSync(join(wt, 'CLAUDE.local.md')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(wt, 'CLAUDE.local.md'))).toBe(join(repo, 'CLAUDE.local.md'))
    expect(readFileSync(join(wt, 'CLAUDE.local.md'), 'utf-8')).toBe('원본 지침\n')
  })

  it('디렉토리를 통째로 가져온다 (copy·link 양쪽)', () => {
    carryIntoWorktree(repo, wt, [{ path: 'node_modules', mode: 'copy' }])
    expect(readFileSync(join(wt, 'node_modules/pkg/index.js'), 'utf-8')).toContain('module.exports')

    const wt2 = join(base, 'wt2')
    git(repo, ['worktree', 'add', '-q', wt2, '-b', 'feat2'])
    carryIntoWorktree(repo, wt2, [{ path: 'node_modules', mode: 'link' }])
    expect(lstatSync(join(wt2, 'node_modules')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(wt2, 'node_modules/pkg/index.js'), 'utf-8')).toContain(
      'module.exports'
    )
  })

  it('중첩 경로는 상위 디렉토리를 만들어 준다', () => {
    mkdirSync(join(repo, '.claude'), { recursive: true })
    writeFileSync(join(repo, '.claude/settings.local.json'), '{"a":1}')
    const out = carryIntoWorktree(repo, wt, [{ path: '.claude/settings.local.json', mode: 'copy' }])
    expect(out.failures).toEqual([])
    expect(readFileSync(join(wt, '.claude/settings.local.json'), 'utf-8')).toBe('{"a":1}')
  })

  it('원본이 없으면 건너뛰되 실패가 아니라 missing 으로 보고한다', () => {
    const out = carryIntoWorktree(repo, wt, [{ path: 'nope.md', mode: 'copy' }])
    expect(out.failures).toEqual([])
    expect(out.carried).toEqual([])
    // 이 신호가 없던 시절, 등록해 둔 항목이 한 번도 발동하지 않는데도 알 방법이 없었다.
    expect(out.missing).toEqual(['nope.md'])
    expect(existsSync(join(wt, 'nope.md'))).toBe(false)
  })

  it('원본 없음은 나머지 전달을 막지 않는다', () => {
    const out = carryIntoWorktree(repo, wt, [
      { path: '.env.local', mode: 'copy' },
      { path: '.env', mode: 'copy' }
    ])
    expect(out.carried).toEqual(['.env'])
    expect(out.missing).toEqual(['.env.local'])
    expect(out.failures).toEqual([])
  })

  it('worktree 에 이미 있어 건너뛴 것은 missing 이 아니다', () => {
    // README.md 는 git 이 추적하므로 worktree 에 이미 있다 — 원본은 멀쩡히 존재한다.
    const out = carryIntoWorktree(repo, wt, [{ path: 'README.md', mode: 'copy' }])
    expect(out.missing).toEqual([])
  })

  it('worktree 에 이미 있는 파일은 덮어쓰지 않는다', () => {
    const out = carryIntoWorktree(repo, wt, [{ path: 'README.md', mode: 'copy' }])
    expect(out.carried).toEqual([])
    expect(readFileSync(join(wt, 'README.md'), 'utf-8')).toBe('hello\n')
  })

  it('잘못된 경로는 실패로 보고하되 나머지는 계속 전달한다', () => {
    const out = carryIntoWorktree(repo, wt, [
      { path: '../escape', mode: 'copy' },
      { path: '.env', mode: 'copy' }
    ])
    expect(out.carried).toEqual(['.env'])
    expect(out.failures).toHaveLength(1)
    expect(out.failures[0].path).toBe('../escape')
    expect(existsSync(join(wt, '.env'))).toBe(true)
  })

  it('에이전트 컨텍스트 실패는 agentContext 플래그로 구분된다', () => {
    const out = carryIntoWorktree(repo, wt, [
      { path: '../CLAUDE.local.md', mode: 'copy' },
      { path: '../.env', mode: 'copy' }
    ])
    expect(out.failures.find((f) => f.path === '../CLAUDE.local.md')?.agentContext).toBe(true)
    expect(out.failures.find((f) => f.path === '../.env')?.agentContext).toBe(false)
  })
})

describe('missingCarryPaths', () => {
  it('리포 루트에 없는 경로만 입력 표기 그대로 돌려준다', () => {
    expect(missingCarryPaths(repo, ['.env', '.env.local', './MEMORY.md'])).toEqual(['.env.local'])
  })

  it('형태가 잘못된 경로는 여기서 다루지 않는다(validateCarryPath 의 몫)', () => {
    expect(missingCarryPaths(repo, ['../escape', '/etc/passwd'])).toEqual([])
  })
})

describe('applyCarryExcludes', () => {
  it('심링크된 디렉토리가 status 를 더럽히지 않게 보정한다', async () => {
    // `node_modules/` 패턴은 심링크에 매칭되지 않아 그냥 두면 `?? node_modules` 가 뜬다.
    const out = carryIntoWorktree(repo, wt, [{ path: 'node_modules', mode: 'link' }])
    expect(git(wt, ['status', '--porcelain'])).toContain('node_modules')

    await applyCarryExcludes(wt, out.carried)
    expect(git(wt, ['status', '--porcelain'])).toBe('')
  })

  it('이미 무시되는 경로에는 아무것도 쓰지 않는다', async () => {
    const excludePath = join(repo, '.git/info/exclude')
    const before = existsSync(excludePath) ? readFileSync(excludePath, 'utf-8') : ''
    const out = carryIntoWorktree(repo, wt, [{ path: '.env', mode: 'copy' }])
    await applyCarryExcludes(wt, out.carried)
    const after = existsSync(excludePath) ? readFileSync(excludePath, 'utf-8') : ''
    expect(after).toBe(before)
  })

  it('두 번 호출해도 중복 기록하지 않는다', async () => {
    const out = carryIntoWorktree(repo, wt, [{ path: 'node_modules', mode: 'link' }])
    await applyCarryExcludes(wt, out.carried)
    const first = readFileSync(join(repo, '.git/info/exclude'), 'utf-8')
    await applyCarryExcludes(wt, out.carried)
    expect(readFileSync(join(repo, '.git/info/exclude'), 'utf-8')).toBe(first)
  })
})

/**
 * 이 기능에서 가장 위험한 지점 — 심링크를 걸어 둔 worktree 를 지울 때 링크를 따라가
 * 메인 체크아웃의 원본까지 지워지면, 대상이 전부 gitignore 된 파일이라 git 으로 복구할 수 없다.
 * `git worktree remove --force` 는 심링크를 unlink 만 하고 타겟을 건드리지 않는데,
 * 그 보장이 조용히 깨지지 않도록 실제 리포로 고정해 둔다.
 */
describe('worktree 삭제가 심링크 원본을 훼손하지 않는다', () => {
  it('link 로 전달한 파일·디렉토리의 원본이 worktree 제거 후에도 살아 있다', () => {
    carryIntoWorktree(repo, wt, [
      { path: 'CLAUDE.local.md', mode: 'link' },
      { path: 'MEMORY.md', mode: 'link' },
      { path: 'node_modules', mode: 'link' },
      { path: '.env', mode: 'copy' }
    ])

    git(repo, ['worktree', 'remove', '--force', wt])

    expect(readFileSync(join(repo, 'CLAUDE.local.md'), 'utf-8')).toBe('원본 지침\n')
    expect(readFileSync(join(repo, 'MEMORY.md'), 'utf-8')).toBe('누적 학습\n')
    expect(readFileSync(join(repo, '.env'), 'utf-8')).toBe('SECRET=원본\n')
    expect(readFileSync(join(repo, 'node_modules/pkg/index.js'), 'utf-8')).toContain(
      'module.exports'
    )
  })

  it('심링크를 통해 원본을 수정한 뒤 제거해도 수정본이 남는다', () => {
    carryIntoWorktree(repo, wt, [{ path: 'MEMORY.md', mode: 'link' }])
    writeFileSync(join(wt, 'MEMORY.md'), '누적 학습\n에이전트가 추가함\n')

    git(repo, ['worktree', 'remove', '--force', wt])

    expect(readFileSync(join(repo, 'MEMORY.md'), 'utf-8')).toBe('누적 학습\n에이전트가 추가함\n')
  })

  it('tracked 디렉토리 안에 링크를 넣어도 형제 파일이 무사하다', () => {
    // .claude 가 커밋돼 있어 worktree 에 이미 존재하는 상황 — 링크는 그 안에 들어간다.
    mkdirSync(join(repo, '.claude'), { recursive: true })
    writeFileSync(join(repo, '.claude/tracked.json'), '{"tracked":1}')
    git(repo, ['add', '-Af'])
    git(repo, ['commit', '-qm', 'add .claude'])
    writeFileSync(join(repo, '.claude/settings.local.json'), '{"local":1}')

    const wt3 = join(base, 'wt3')
    git(repo, ['worktree', 'add', '-q', wt3, '-b', 'feat3'])
    carryIntoWorktree(repo, wt3, [{ path: '.claude/settings.local.json', mode: 'link' }])
    expect(lstatSync(join(wt3, '.claude/settings.local.json')).isSymbolicLink()).toBe(true)

    git(repo, ['worktree', 'remove', '--force', wt3])

    expect(readFileSync(join(repo, '.claude/settings.local.json'), 'utf-8')).toBe('{"local":1}')
    expect(readFileSync(join(repo, '.claude/tracked.json'), 'utf-8')).toBe('{"tracked":1}')
  })
})
