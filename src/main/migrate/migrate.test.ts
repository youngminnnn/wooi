import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_AGENT_BACKEND, DEFAULT_NOTIFICATION_SETTINGS } from '@shared/types'
import type {
  AppSettings,
  AppState,
  ChatItem,
  MigrationImportSelection,
  MigrationScan,
  Repo,
  Workspace
} from '@shared/types'
import { importMigration, orcaDataCandidates, scanMigration } from './index'

/**
 * 스캔·들여오기 전체를 진짜 git 리포와 worktree 위에서 돌린다.
 *
 * 출처 있는 경로는 Orca 로 검증한다 — 상태가 JSON 파일 하나라 테스트가 `sqlite3` 실행 파일에
 * 기대지 않아도 된다(Conductor 쪽 형식 해석은 parse.test.ts 가 단위로 본다).
 */

const git = (cwd: string, args: string[]): void => {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

let root: string
let home: string
let appData: string
let repoPath: string
let worktreePath: string
let state: Pick<AppState, 'repos' | 'workspaces' | 'settings'>

const settings = {
  defaultAgentBackend: DEFAULT_AGENT_BACKEND,
  agents: {
    claude: {
      model: null,
      effort: null,
      permissionMode: null,
      fastMode: false,
      fallbackModels: []
    },
    codex: { model: null, effort: null, permissionMode: null, fastMode: false, fallbackModels: [] }
  },
  notifications: DEFAULT_NOTIFICATION_SETTINGS
} as unknown as AppSettings

function writeOrcaData(repos: unknown[], worktreeMeta: Record<string, unknown>): void {
  const path = orcaDataCandidates({ home, appData })[0]
  mkdirSync(join(appData, 'Orca'), { recursive: true })
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, repos, worktreeMeta }))
}

/** 그 worktree 에서 Claude Code 를 돌린 것처럼 세션 파일을 심는다. */
function writeClaudeSession(
  cwd: string,
  sessionId: string,
  title: string,
  lines: unknown[] = []
): void {
  const dir = join(home, '.claude', 'projects', realpathSync(cwd).replace(/\//g, '-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${sessionId}.jsonl`),
    [{ type: 'custom-title', customTitle: title, sessionId }, ...lines]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n'
  )
}

/** 사람이 만든 워크스페이스 하나를 Wooi 상태에 앉힌다. */
function registerRepo(): Repo {
  const repo: Repo = {
    id: 'existing-repo',
    name: 'api',
    path: repoPath,
    defaultBranch: 'main',
    setupScript: '',
    runScripts: [],
    archiveScript: '',
    carryItems: [],
    addedAt: 0
  }
  state.repos.push(repo)
  return repo
}

const deps = () => ({
  env: { home, appData },
  getState: () => state,
  update: (mutate: (st: Pick<AppState, 'repos' | 'workspaces'>) => void) => mutate(state)
})

const scan = (repoId?: string): Promise<MigrationScan> => scanMigration({ repoId }, deps())

/** 스캔 결과 전부를 고르는 선택(세션 포함). */
function selectAll(result: MigrationScan): MigrationImportSelection {
  const pending = result.repos.flatMap((repo) =>
    repo.workspaces.filter((ws) => !ws.alreadyImported)
  )
  return {
    repoKeys: result.repos.map((repo) => repo.key),
    workspaceKeys: pending.map((ws) => ws.key),
    sessionKeys: pending.filter((ws) => ws.session).map((ws) => ws.key)
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wooi-migrate-test-'))
  home = join(root, 'home')
  appData = join(home, 'Library', 'Application Support')
  mkdirSync(appData, { recursive: true })

  repoPath = join(home, 'Projects', 'api')
  mkdirSync(repoPath, { recursive: true })
  git(repoPath, ['init', '-b', 'main'])
  git(repoPath, ['config', 'user.email', 'test@example.com'])
  git(repoPath, ['config', 'user.name', 'Test'])
  writeFileSync(join(repoPath, 'README.md'), '# api\n')
  git(repoPath, ['add', '.'])
  git(repoPath, ['commit', '-m', 'init'])

  worktreePath = join(home, 'work', 'feature-a')
  git(repoPath, ['worktree', 'add', '-b', 'feature-a', worktreePath])

  state = { repos: [], workspaces: [], settings }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('scanMigration — 등록된 리포', () => {
  it('다른 도구가 없어도 그 리포의 worktree 를 후보로 올린다', async () => {
    registerRepo()

    const result = await scan()
    expect(result.warnings).toEqual([])
    expect(result.repos).toHaveLength(1)
    expect(result.repos[0]).toMatchObject({ name: 'api', alreadyAdded: true, source: null })
    expect(result.repos[0].workspaces).toHaveLength(1)
    expect(result.repos[0].workspaces[0]).toMatchObject({
      name: 'feature-a',
      branch: 'feature-a',
      alreadyImported: false
    })
  })

  it('repoId 를 주면 그 리포만 본다', async () => {
    const repo = registerRepo()
    const other = join(home, 'Projects', 'web')
    mkdirSync(other, { recursive: true })
    git(other, ['init', '-b', 'main'])
    state.repos.push({ id: 'other', name: 'web', path: other, defaultBranch: 'main' } as Repo)

    const result = await scan(repo.id)
    expect(result.repos.map((item) => item.name)).toEqual(['api'])
  })

  it('메인 체크아웃과 이미 들여온 worktree 는 후보가 아니다', async () => {
    const repo = registerRepo()
    state.workspaces.push({
      id: 'w',
      repoId: repo.id,
      worktreePath,
      branch: 'feature-a',
      ports: {}
    } as Workspace)

    const result = await scan()
    expect(result.repos).toEqual([])
  })

  it('브랜치를 이미 쓰는 워크스페이스가 있으면 들여올 수 없는 것으로 표시한다', async () => {
    const repo = registerRepo()
    // 경로는 다르지만 같은 브랜치 — 같은 브랜치를 두 worktree 가 체크아웃할 수 없다.
    state.workspaces.push({
      id: 'w',
      repoId: repo.id,
      worktreePath: join(home, 'elsewhere'),
      branch: 'feature-a',
      ports: {}
    } as Workspace)

    const result = await scan()
    expect(result.repos).toEqual([])
  })

  it('detached HEAD 인 worktree 는 후보가 아니다', async () => {
    registerRepo()
    const detached = join(home, 'work', 'detached')
    git(repoPath, ['worktree', 'add', '--detach', detached])

    const result = await scan()
    const paths = result.repos[0].workspaces.map((ws) => ws.worktreePath)
    expect(paths).not.toContain(realpathSync(detached))
  })
})

describe('scanMigration — 다른 도구가 알려 준 리포', () => {
  it('등록되지 않은 리포를 후보로 올리고 worktree 이름을 채운다', async () => {
    writeOrcaData([{ id: 'r1', path: repoPath, displayName: 'API' }], {
      [`r1::${worktreePath}`]: { displayName: 'Feature A' }
    })

    const result = await scan()
    expect(result.repos[0]).toMatchObject({
      name: 'API',
      alreadyAdded: false,
      source: 'orca',
      sourceLabel: 'Orca'
    })
    expect(result.repos[0].workspaces[0].name).toBe('Feature A')
  })

  it('이미 등록된 리포면 이름만 얹고 출처로 잡지 않는다', async () => {
    registerRepo()
    writeOrcaData([{ id: 'r1', path: repoPath, displayName: 'API' }], {
      [`r1::${worktreePath}`]: { displayName: 'Feature A' }
    })

    const result = await scan()
    // 사용자가 Wooi 에서 정한 리포 이름이 이긴다. worktree 이름은 저쪽 것을 쓴다.
    expect(result.repos[0]).toMatchObject({ name: 'api', source: null })
    expect(result.repos[0].workspaces[0].name).toBe('Feature A')
  })

  it('저쪽이 기억해도 git 에 없는 worktree 는 후보가 아니다', async () => {
    writeOrcaData([{ id: 'r1', path: repoPath }], {
      [`r1::${join(home, 'work', 'gone')}`]: { displayName: 'Gone' }
    })

    const result = await scan()
    expect(result.repos[0].workspaces.map((ws) => ws.name)).toEqual(['feature-a'])
  })

  it('아무 데이터도 없고 등록된 리포도 없으면 빈 결과다', async () => {
    const result = await scan()
    expect(result).toEqual({ repos: [], warnings: [] })
  })
})

describe('scanMigration — 세션', () => {
  it('그 worktree 에서 돌던 Claude 세션을 찾아 붙인다', async () => {
    registerRepo()
    writeClaudeSession(worktreePath, '11111111-2222-3333-4444-555555555555', 'Fix the parser')

    const result = await scan()
    expect(result.repos[0].workspaces[0].session).toMatchObject({
      backend: 'claude',
      sessionId: '11111111-2222-3333-4444-555555555555',
      label: 'Fix the parser'
    })
  })

  it('세션이 없으면 null 이다 — 그래도 worktree 는 들여올 수 있다', async () => {
    registerRepo()
    const result = await scan()
    expect(result.repos[0].workspaces[0].session).toBeNull()
  })
})

describe('importMigration', () => {
  it('고른 리포와 worktree 를 등록한다 — worktree 는 있던 자리 그대로다', async () => {
    writeOrcaData([{ id: 'r1', path: repoPath, displayName: 'API' }], {
      [`r1::${worktreePath}`]: { displayName: 'Feature A' }
    })
    const result = await importMigration(selectAll(await scan()), deps())

    expect(result).toMatchObject({ repos: 1, workspaces: 1, sessions: 0, errors: [] })
    expect(state.repos[0]).toMatchObject({ name: 'API', path: repoPath, defaultBranch: 'main' })
    expect(state.workspaces[0]).toMatchObject({
      repoId: state.repos[0].id,
      name: 'feature-a',
      displayName: 'Feature A',
      branch: 'feature-a',
      // 저장되는 경로는 심링크를 푼 것이다(macOS 의 /var → /private/var).
      worktreePath: realpathSync(worktreePath),
      baseBranch: 'main',
      // 이 디렉터리에서 셋업은 이미 돌았다 — 다시 돌리라고 권하지 않는다.
      setupState: 'success',
      sessionId: null,
      archived: false
    })
  })

  it('등록된 리포의 worktree 만 들여올 때는 리포를 새로 만들지 않는다', async () => {
    const repo = registerRepo()
    const result = await importMigration(selectAll(await scan()), deps())

    expect(result).toMatchObject({ repos: 0, workspaces: 1 })
    expect(state.repos).toHaveLength(1)
    expect(state.workspaces[0].repoId).toBe(repo.id)
  })

  it('세션을 고르면 id·백엔드를 이어받고 지난 대화를 옮겨 적는다', async () => {
    registerRepo()
    writeClaudeSession(worktreePath, 'abc-123', 'Fix the parser', [
      {
        type: 'user',
        timestamp: '2026-08-01T00:00:00.000Z',
        message: { content: '파서를 고쳐 줘' }
      },
      {
        type: 'assistant',
        timestamp: '2026-08-01T00:00:01.000Z',
        message: { content: [{ type: 'text', text: '고쳤습니다' }] }
      }
    ])
    const imported: Array<{ workspaceId: string; items: ChatItem[] }> = []

    const result = await importMigration(selectAll(await scan()), {
      ...deps(),
      noteImport: (workspaceId, items) => imported.push({ workspaceId, items })
    })

    expect(result).toMatchObject({ workspaces: 1, sessions: 1 })
    expect(state.workspaces[0]).toMatchObject({ sessionId: 'abc-123', agentBackend: 'claude' })
    expect(imported).toHaveLength(1)
    expect(imported[0].workspaceId).toBe(state.workspaces[0].id)
    const [note, ...restored] = imported[0].items
    expect(note).toMatchObject({ type: 'system' })
    expect(note.type === 'system' && note.text).toContain('Fix the parser')
    expect(note.type === 'system' && note.text).toContain('2 messages below')
    expect(restored.map((item) => item.type)).toEqual(['user', 'assistant'])
    // 안내는 옮겨 온 첫 항목보다 앞선 시각이어야 한다.
    expect(note.ts).toBeLessThan(restored[0].ts)
  })

  it('세션을 고르지 않으면 대화를 이어받지 않는다', async () => {
    registerRepo()
    writeClaudeSession(worktreePath, 'abc-123', 'Fix the parser')
    const result = await scan()
    const ws = result.repos[0].workspaces[0]

    const outcome = await importMigration(
      { repoKeys: [], workspaceKeys: [ws.key], sessionKeys: [] },
      deps()
    )
    expect(outcome).toMatchObject({ workspaces: 1, sessions: 0 })
    expect(state.workspaces[0].sessionId).toBeNull()
  })

  it('두 번 들여와도 중복되지 않는다', async () => {
    registerRepo()
    const first = selectAll(await scan())
    await importMigration(first, deps())

    expect((await scan()).repos).toEqual([])
    const again = await importMigration(first, deps())
    expect(again).toMatchObject({ repos: 0, workspaces: 0 })
    expect(state.workspaces).toHaveLength(1)
  })

  it('고르지 않은 worktree 는 건드리지 않는다', async () => {
    registerRepo()
    const result = await importMigration(
      { repoKeys: [], workspaceKeys: [], sessionKeys: [] },
      deps()
    )
    expect(result).toMatchObject({ repos: 0, workspaces: 0 })
    expect(state.workspaces).toEqual([])
  })

  it('키가 스캔 결과에 없으면 아무것도 만들지 않는다(IPC 는 신뢰 경계다)', async () => {
    registerRepo()
    const result = await importMigration(
      { repoKeys: ['repo:/etc'], workspaceKeys: ['ws:/etc'], sessionKeys: [] },
      deps()
    )
    expect(result).toMatchObject({ repos: 0, workspaces: 0 })
    expect(state.workspaces).toEqual([])
  })

  it('워크스페이스만 골라도 그 리포는 함께 등록된다', async () => {
    writeOrcaData([{ id: 'r1', path: repoPath }], {})
    const result = await scan()
    const ws = result.repos[0].workspaces[0]

    const outcome = await importMigration(
      { repoKeys: [], workspaceKeys: [ws.key], sessionKeys: [] },
      deps()
    )
    expect(outcome).toMatchObject({ repos: 1, workspaces: 1 })
  })
})
