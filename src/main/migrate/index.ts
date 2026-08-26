import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { agentSettingsFor, normalizePermissionMode } from '@shared/types'
import type {
  AppState,
  MigrationImportResult,
  MigrationImportSelection,
  MigrationRepoCandidate,
  MigrationScan,
  MigrationSource,
  MigrationSourceId,
  MigrationWorkspaceCandidate,
  Repo,
  Workspace
} from '@shared/types'
import { backendMeta } from '../agent/backend'
import { detectCarryItems } from '../carry'
import { detectDefaultBranch, isGitRepo, listWorktrees } from '../git'
import { log } from '../logger'
import { findFreePort } from '../net'
import { parseConductor, parseOrca, type ForeignRepo } from './parse'

/**
 * Conductor·Orca 에서 Wooi 로 옮겨오기.
 *
 * 세 가지 원칙 위에 서 있다.
 *
 * 1. **아무것도 옮기거나 지우지 않는다.** 다른 도구가 만든 worktree 는 있던 자리 그대로 두고
 *    Wooi 워크스페이스가 그 경로를 가리키게만 한다. 디렉터리를 옮기면 그 도구가 자기 작업을
 *    잃고, 사용자는 아직 Wooi 를 써 보지도 않은 채 되돌릴 수 없는 상태가 된다.
 * 2. **git 이 판정한다.** 저쪽 DB·JSON 은 이미 지워진 worktree 도 기억한다. 그래서 후보는
 *    언제나 `git worktree list` 와의 교집합이고, 브랜치 이름도 그 목록에서 읽는다.
 * 3. **두 번 눌러도 안전하다.** 이미 등록된 리포·이미 들여온 worktree 는 후보 단계에서
 *    표시되고 들여오기에서 건너뛴다.
 */

const exec = promisify(execFile)

/** 사용자 홈·appData 처럼 실행 환경마다 다른 값. 테스트가 가짜 홈을 넘길 수 있게 인자로 받는다. */
export interface MigrationEnv {
  home: string
  /** macOS 의 `~/Library/Application Support`. */
  appData: string
}

export interface MigrationDeps {
  env: MigrationEnv
  getState: () => Pick<AppState, 'repos' | 'workspaces' | 'settings'>
  update: (mutate: (state: Pick<AppState, 'repos' | 'workspaces'>) => void) => void
  /** 리포를 새로 등록한 직후(아바타 백필 등 부수 작업 훅). */
  onRepoAdded?: (repoId: string) => void
}

/**
 * 비교용 정규 경로. macOS 는 `/tmp` → `/private/tmp` 처럼 심링크가 흔해서, 문자열만 맞대면
 * 같은 디렉터리를 다른 것으로 읽는다. 없는 경로는 realpath 가 던지므로 resolve 로 폴백한다.
 */
function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

// ── 데이터 파일 찾기 ────────────────────────────────────────────────────────

/** Conductor 의 sqlite 파일 후보. 앞의 것이 이긴다. */
export function conductorDbCandidates(env: MigrationEnv): string[] {
  return [
    join(env.appData, 'com.conductor.app', 'conductor.db'),
    join(env.appData, 'Conductor', 'conductor.db')
  ]
}

/**
 * Orca 의 상태 파일 후보. 데스크톱 앱은 appData 아래, 헤드리스(orcad)는 `~/.orca` 를 쓴다.
 * `$ORCA_USER_DATA` 는 Orca 자신이 최우선으로 보는 값이라 여기서도 앞에 둔다.
 */
export function orcaDataCandidates(
  env: MigrationEnv,
  envVars: NodeJS.ProcessEnv = process.env
): string[] {
  const explicit = envVars.ORCA_USER_DATA?.trim()
  const xdg = envVars.XDG_DATA_HOME?.trim()
  return [
    ...(explicit ? [join(explicit, 'orca-data.json')] : []),
    join(env.appData, 'Orca', 'orca-data.json'),
    ...(xdg ? [join(xdg, 'Orca', 'orca-data.json')] : []),
    join(env.home, '.orca', 'orca-data.json')
  ]
}

function firstExisting(paths: string[]): string | null {
  return paths.find((path) => existsSync(path)) ?? null
}

// ── sqlite 읽기 ────────────────────────────────────────────────────────────

/**
 * sqlite DB 한 테이블을 JSON 배열로 읽는다. `sqlite3` 는 macOS 에 기본 탑재돼 있어 의존성을
 * 늘리지 않는다 — 이 기능 하나 때문에 네이티브 모듈을 붙일 이유가 없다.
 *
 * Conductor 가 실행 중이면 WAL 때문에 읽기 전용 열기가 실패할 수 있다. 그때는 DB 를 임시로
 * 복사해(사이드카 `-wal`·`-shm` 까지) 다시 읽는다 — 마이그레이션하려고 남의 앱을 먼저 끄게
 * 만들면, 정작 무엇을 옮길 수 있는지 보지도 못하고 포기하게 된다.
 */
async function readTable(dbPath: string, table: string): Promise<unknown> {
  const query = `select * from ${table}`
  try {
    return parseSqliteJson(await runSqlite(dbPath, query))
  } catch (err) {
    log.warn(`sqlite 읽기 실패(${table}) — 사본으로 재시도합니다: ${String(err)}`)
  }
  const dir = mkdtempSync(join(tmpdir(), 'wooi-migrate-'))
  try {
    const copy = join(dir, basename(dbPath))
    copyFileSync(dbPath, copy)
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, copy + suffix)
    }
    return parseSqliteJson(await runSqlite(copy, query))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function runSqlite(dbPath: string, query: string): Promise<string> {
  const { stdout } = await exec('sqlite3', ['-readonly', '-json', dbPath, query], {
    maxBuffer: 1024 * 1024 * 64
  })
  return stdout
}

/** 빈 테이블이면 sqlite3 가 아무것도 출력하지 않는다 — 그건 오류가 아니라 빈 배열이다. */
function parseSqliteJson(stdout: string): unknown {
  const text = stdout.trim()
  if (!text) return []
  return JSON.parse(text)
}

// ── 스캔 ───────────────────────────────────────────────────────────────────

interface SourceRead {
  dataPath: string
  repos: ForeignRepo[]
}

async function readConductor(env: MigrationEnv): Promise<SourceRead | null> {
  const dbPath = firstExisting(conductorDbCandidates(env))
  if (!dbPath) return null
  const [repos, workspaces] = await Promise.all([
    readTable(dbPath, 'repos'),
    readTable(dbPath, 'workspaces')
  ])
  return { dataPath: dbPath, repos: parseConductor(repos, workspaces, env.home) }
}

function readOrca(env: MigrationEnv): SourceRead | null {
  const dataPath = firstExisting(orcaDataCandidates(env))
  if (!dataPath) return null
  const raw = JSON.parse(readFileSync(dataPath, 'utf-8')) as unknown
  return { dataPath, repos: parseOrca(raw) }
}

const SOURCE_LABELS: Record<MigrationSourceId, string> = {
  conductor: 'Conductor',
  orca: 'Orca'
}

export function repoKeyFor(source: MigrationSourceId, externalId: string): string {
  return `${source}:repo:${externalId}`
}

export function workspaceKeyFor(source: MigrationSourceId, worktreePath: string): string {
  return `${source}:ws:${canonical(worktreePath)}`
}

/**
 * 옮겨올 수 있는 것을 전부 훑는다. 부작용은 없다 — 읽기만 한다.
 *
 * 이미 다 옮긴 리포(등록돼 있고 남은 worktree 도 없는 것)는 목록에서 뺀다. 그래야 "결과가
 * 비어 있다 = 할 일이 없다" 가 되어, 이 스캔 하나로 안내 배너를 띄울지 결정할 수 있다.
 */
export async function scanMigrationSources(
  deps: Pick<MigrationDeps, 'env' | 'getState'>
): Promise<MigrationScan> {
  const state = deps.getState()
  const knownRepos = new Set(state.repos.map((repo) => canonical(repo.path)))
  const knownWorktrees = new Set(state.workspaces.map((ws) => canonical(ws.worktreePath)))
  // 브랜치 충돌은 리포 단위로 봐야 한다 — 같은 브랜치를 두 worktree 가 체크아웃할 수 없으므로,
  // 이미 Wooi 가 쓰는 브랜치는 다른 경로에서 들여와도 열리지 않는다.
  const branchesByRepoPath = new Map<string, Set<string>>()
  for (const ws of state.workspaces) {
    const repo = state.repos.find((item) => item.id === ws.repoId)
    if (!repo) continue
    const key = canonical(repo.path)
    const set = branchesByRepoPath.get(key) ?? new Set<string>()
    set.add(ws.branch)
    branchesByRepoPath.set(key, set)
  }

  const warnings: string[] = []
  const reads: Array<{ id: MigrationSourceId; read: SourceRead | null }> = []
  try {
    reads.push({ id: 'conductor', read: await readConductor(deps.env) })
  } catch (err) {
    warnings.push(`Could not read Conductor's database (${errorText(err)}).`)
  }
  try {
    reads.push({ id: 'orca', read: readOrca(deps.env) })
  } catch (err) {
    warnings.push(`Could not read Orca's data file (${errorText(err)}).`)
  }

  const sources: MigrationSource[] = []
  for (const { id, read } of reads) {
    if (!read) continue
    const repos: MigrationRepoCandidate[] = []
    for (const foreign of read.repos) {
      if (!existsSync(foreign.path)) continue
      if (!(await isGitRepo(foreign.path))) continue
      const repoPath = canonical(foreign.path)
      const alreadyAdded = knownRepos.has(repoPath)
      const takenBranches = branchesByRepoPath.get(repoPath) ?? new Set<string>()

      // git 이 아는 worktree 만 후보가 된다. 저쪽이 기억하는 경로 중 이미 사라진 것은 여기서 빠진다.
      const live = new Map<string, string | null>()
      for (const entry of await listWorktrees(foreign.path)) {
        live.set(canonical(entry.path), entry.branch)
      }

      const workspaces: MigrationWorkspaceCandidate[] = []
      for (const ws of foreign.workspaces) {
        const path = canonical(ws.path)
        if (path === repoPath) continue // 메인 체크아웃은 워크스페이스가 아니다
        if (!live.has(path)) continue
        const branch = live.get(path)
        // detached HEAD 인 worktree 는 Wooi 의 모델(워크스페이스 = 브랜치 하나)에 담기지 않는다.
        if (!branch) continue
        workspaces.push({
          key: workspaceKeyFor(id, path),
          name: ws.name,
          branch,
          worktreePath: path,
          alreadyImported: knownWorktrees.has(path) || takenBranches.has(branch)
        })
      }

      // 등록도 돼 있고 남은 worktree 도 없으면 사용자가 할 일이 없다.
      if (alreadyAdded && workspaces.every((ws) => ws.alreadyImported)) continue
      repos.push({
        key: repoKeyFor(id, foreign.externalId),
        name: foreign.name,
        path: foreign.path,
        alreadyAdded,
        setupScript: foreign.setupScript,
        archiveScript: foreign.archiveScript,
        runScripts: foreign.runScripts,
        workspaces
      })
    }
    if (repos.length > 0) {
      sources.push({ id, label: SOURCE_LABELS[id], dataPath: read.dataPath, repos })
    }
  }

  return { sources, warnings }
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  // ENOENT 로 나오는 것은 대개 sqlite3 자체가 없는 경우다. 그대로 보여 주면 무슨 말인지 모른다.
  if (text.includes('ENOENT') && text.includes('sqlite3'))
    return 'the sqlite3 command is not available'
  return text.split('\n')[0]
}

// ── 들여오기 ───────────────────────────────────────────────────────────────

/**
 * 고른 항목을 실제로 등록한다.
 *
 * 키를 받아 **다시 스캔해 대조하는** 것이 요점이다. 렌더러가 보낸 경로를 그대로 믿으면 IPC 가
 * 임의 디렉터리를 워크스페이스로 등록하는 통로가 된다(같은 이유로 repo:update 도 저장 시점에
 * 다시 검증한다). 재스캔 비용은 git 호출 몇 번이고, 사용자가 버튼을 누른 직후 한 번뿐이다.
 */
export async function importMigration(
  selection: MigrationImportSelection,
  deps: MigrationDeps
): Promise<MigrationImportResult> {
  const scan = await scanMigrationSources(deps)
  const repoKeys = new Set(selection.repoKeys)
  const workspaceKeys = new Set(selection.workspaceKeys)
  const errors: string[] = []
  let importedRepos = 0
  let importedWorkspaces = 0

  for (const source of scan.sources) {
    for (const candidate of source.repos) {
      const chosen = candidate.workspaces.filter(
        (ws) => workspaceKeys.has(ws.key) && !ws.alreadyImported
      )
      // 워크스페이스만 고르고 리포를 안 고른 경우에도 리포는 있어야 한다.
      if (!repoKeys.has(candidate.key) && chosen.length === 0) continue

      const existing = deps
        .getState()
        .repos.find((item) => canonical(item.path) === canonical(candidate.path))
      let repo: Repo
      if (existing) {
        repo = existing
      } else {
        try {
          repo = await createRepo(candidate)
        } catch (err) {
          errors.push(`${candidate.name}: ${errorText(err)}`)
          continue
        }
        const created = repo
        deps.update((state) => state.repos.push(created))
        importedRepos++
        deps.onRepoAdded?.(created.id)
      }

      for (const ws of chosen) {
        try {
          const workspace = await buildWorkspace(repo, ws, deps)
          deps.update((state) => state.workspaces.push(workspace))
          importedWorkspaces++
        } catch (err) {
          errors.push(`${ws.name}: ${errorText(err)}`)
        }
      }
    }
  }

  return { repos: importedRepos, workspaces: importedWorkspaces, errors }
}

/** 후보를 Wooi 의 리포 레코드로 옮긴다. 기본 브랜치와 전달 목록은 Wooi 가 새로 판정한다. */
async function createRepo(candidate: MigrationRepoCandidate): Promise<Repo> {
  return {
    id: randomUUID(),
    name: candidate.name,
    path: candidate.path,
    defaultBranch: await detectDefaultBranch(candidate.path),
    setupScript: candidate.setupScript,
    runScripts: candidate.runScripts.map((script) => ({
      id: randomUUID(),
      name: script.name,
      command: script.command,
      // 옮겨온 명령이 곧바로 도는 것은 사용자가 시킨 적 없는 실행이다. 켜는 것은 리포 설정에서.
      autoStart: false
    })),
    archiveScript: candidate.archiveScript,
    // Conductor·Orca 에도 "새 worktree 에 딸려 보낼 무시된 파일" 개념이 있지만 저장 위치가
    // 서로 달라, 옮기기보다 Wooi 가 리포를 직접 훑어 채우는 편이 정확하다(repo:add 와 같은 규칙).
    carryItems: detectCarryItems(candidate.path),
    addedAt: Date.now()
  }
}

/**
 * 이미 있는 worktree 를 가리키는 워크스페이스 레코드를 만든다.
 *
 * `createWorkspace` 를 쓰지 않는 이유는 그 함수의 본론이 **worktree 를 새로 만드는 것**이라서다
 * (브랜치 이름 유일화, `git worktree add`, 전달 파일 복사, 셋업 스크립트 실행). 여기서 필요한
 * 것은 그 반대 — 이미 만들어져 셋업까지 끝난 디렉터리를 있는 그대로 받아 적는 일이다.
 */
async function buildWorkspace(
  repo: Repo,
  candidate: MigrationWorkspaceCandidate,
  deps: MigrationDeps
): Promise<Workspace> {
  const state = deps.getState()
  const settings = state.settings
  const agentBackend = settings.defaultAgentBackend
  const permissionMode = normalizePermissionMode(
    backendMeta(agentBackend),
    agentSettingsFor(settings, agentBackend).permissionMode
  )

  const used = new Set<number>(state.workspaces.flatMap((ws) => Object.values(ws.ports)))
  const ports: Record<string, number> = {}
  for (const script of repo.runScripts) {
    const port = await findFreePort(used)
    ports[script.id] = port
    used.add(port)
  }

  const name = basename(candidate.worktreePath)
  return {
    id: randomUUID(),
    repoId: repo.id,
    agentBackend,
    multiAgent: false,
    name,
    // 저쪽에서 붙여 둔 이름이 디렉터리 이름과 다르면 그건 사용자가 정한 이름이다 — 표시 이름으로 산다.
    displayName: candidate.name && candidate.name !== name ? candidate.name : null,
    branch: candidate.branch,
    // 스택 관계는 옮겨오지 않는다. 저쪽에는 대응하는 개념이 없거나(Conductor) 형태가 달라서,
    // 짐작해 넣으면 restack·PR retarget 이 사용자가 만든 적 없는 관계 위에서 돈다.
    baseBranch: repo.defaultBranch,
    parentWorkspaceId: null,
    createdByWorkspaceId: null,
    prNumber: null,
    worktreePath: candidate.worktreePath,
    ports,
    // 셋업은 저쪽에서 이미 돌았다(node_modules 가 그 증거다). 'idle' 로 두면 Wooi 가 아직 돌지
    // 않은 것으로 보고 재실행을 권한다.
    setupState: 'success',
    sessionId: null,
    permissionMode,
    model: null,
    effort: null,
    fastMode: null,
    status: 'idle',
    lastModel: null,
    fastModeState: null,
    fastModeReason: null,
    archived: false,
    createdAt: Date.now(),
    lastActiveAt: Date.now()
  }
}
