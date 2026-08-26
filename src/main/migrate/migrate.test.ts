import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_AGENT_BACKEND, DEFAULT_NOTIFICATION_SETTINGS } from '@shared/types'
import type { AppSettings, AppState, Repo, Workspace } from '@shared/types'
import { importMigration, orcaDataCandidates, scanMigrationSources } from './index'

/**
 * Orca 경로로 스캔·들여오기 전체를 돌린다. Orca 를 고른 이유는 상태가 JSON 파일 하나라
 * 테스트가 `sqlite3` 실행 파일에 기대지 않아도 되기 때문이다(Conductor 쪽 형식 해석은
 * parse.test.ts 가 단위로 검증한다).
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

const deps = () => ({
  env: { home, appData },
  getState: () => state,
  update: (mutate: (st: Pick<AppState, 'repos' | 'workspaces'>) => void) => mutate(state)
})

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

  worktreePath = join(home, 'orca', 'api', 'feature-a')
  git(repoPath, ['worktree', 'add', '-b', 'feature-a', worktreePath])

  state = { repos: [], workspaces: [], settings }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('scanMigrationSources', () => {
  it('Orca 의 리포와 살아 있는 worktree 를 후보로 올린다', async () => {
    writeOrcaData([{ id: 'r1', path: repoPath, displayName: 'API' }], {
      [`r1::${worktreePath}`]: { displayName: 'Feature A' }
    })

    const scan = await scanMigrationSources(deps())
    expect(scan.warnings).toEqual([])
    expect(scan.sources).toHaveLength(1)
    expect(scan.sources[0].label).toBe('Orca')
    const repo = scan.sources[0].repos[0]
    expect(repo).toMatchObject({ name: 'API', alreadyAdded: false })
    expect(repo.workspaces).toHaveLength(1)
    expect(repo.workspaces[0]).toMatchObject({
      name: 'Feature A',
      branch: 'feature-a',
      alreadyImported: false
    })
  })

  it('git 에 없는 worktree 는 저쪽이 기억해도 후보가 아니다', async () => {
    writeOrcaData([{ id: 'r1', path: repoPath }], {
      [`r1::${join(home, 'orca', 'api', 'gone')}`]: { displayName: 'Gone' }
    })

    const scan = await scanMigrationSources(deps())
    expect(scan.sources[0].repos[0].workspaces).toEqual([])
  })

  it('데이터 파일이 없으면 아무 출처도 내지 않는다', async () => {
    const scan = await scanMigrationSources(deps())
    expect(scan).toEqual({ sources: [], warnings: [] })
  })

  it('이미 등록했고 남은 worktree 도 없으면 목록에서 뺀다', async () => {
    writeOrcaData([{ id: 'r1', path: repoPath }], {
      [`r1::${worktreePath}`]: { displayName: 'Feature A' }
    })
    state.repos = [{ id: 'existing', path: repoPath } as Repo]
    state.workspaces = [
      { id: 'w', repoId: 'existing', worktreePath, branch: 'feature-a', ports: {} } as Workspace
    ]

    const scan = await scanMigrationSources(deps())
    expect(scan.sources).toEqual([])
  })
})

describe('importMigration', () => {
  beforeEach(() => {
    writeOrcaData([{ id: 'r1', path: repoPath, displayName: 'API' }], {
      [`r1::${worktreePath}`]: { displayName: 'Feature A' }
    })
  })

  it('고른 리포와 worktree 를 등록한다 — worktree 는 있던 자리 그대로다', async () => {
    const scan = await scanMigrationSources(deps())
    const repo = scan.sources[0].repos[0]

    const result = await importMigration(
      { repoKeys: [repo.key], workspaceKeys: [repo.workspaces[0].key] },
      deps()
    )
    expect(result).toMatchObject({ repos: 1, workspaces: 1, errors: [] })
    expect(state.repos[0]).toMatchObject({ name: 'API', path: repoPath, defaultBranch: 'main' })
    expect(state.workspaces[0]).toMatchObject({
      repoId: state.repos[0].id,
      name: 'feature-a',
      displayName: 'Feature A',
      branch: 'feature-a',
      // 저장되는 경로는 심링크를 푼 것이다(macOS 의 /var → /private/var).
      worktreePath: realpathSync(worktreePath),
      baseBranch: 'main',
      // 저쪽에서 이미 셋업이 끝난 디렉터리다 — 다시 돌리라고 권하지 않는다.
      setupState: 'success',
      archived: false
    })
  })

  it('두 번 들여와도 중복되지 않는다', async () => {
    const first = await scanMigrationSources(deps())
    const repo = first.sources[0].repos[0]
    await importMigration({ repoKeys: [repo.key], workspaceKeys: [repo.workspaces[0].key] }, deps())

    const second = await scanMigrationSources(deps())
    expect(second.sources).toEqual([])
    const result = await importMigration(
      { repoKeys: [repo.key], workspaceKeys: [repo.workspaces[0].key] },
      deps()
    )
    expect(result).toMatchObject({ repos: 0, workspaces: 0 })
    expect(state.repos).toHaveLength(1)
    expect(state.workspaces).toHaveLength(1)
  })

  it('고르지 않은 worktree 는 건드리지 않는다', async () => {
    const scan = await scanMigrationSources(deps())
    const repo = scan.sources[0].repos[0]
    const result = await importMigration({ repoKeys: [repo.key], workspaceKeys: [] }, deps())
    expect(result).toMatchObject({ repos: 1, workspaces: 0 })
    expect(state.workspaces).toEqual([])
  })

  it('키가 스캔 결과에 없으면 아무것도 만들지 않는다(IPC 는 신뢰 경계다)', async () => {
    const result = await importMigration(
      { repoKeys: ['orca:repo:made-up'], workspaceKeys: ['orca:ws:/etc'] },
      deps()
    )
    expect(result).toMatchObject({ repos: 0, workspaces: 0 })
    expect(state.repos).toEqual([])
    expect(state.workspaces).toEqual([])
  })

  it('워크스페이스만 골라도 그 리포는 함께 등록된다', async () => {
    const scan = await scanMigrationSources(deps())
    const repo = scan.sources[0].repos[0]
    const result = await importMigration(
      { repoKeys: [], workspaceKeys: [repo.workspaces[0].key] },
      deps()
    )
    expect(result).toMatchObject({ repos: 1, workspaces: 1 })
  })
})
