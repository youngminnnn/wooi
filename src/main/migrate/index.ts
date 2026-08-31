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
  ChatItem,
  MigrationAgentSession,
  MigrationImportResult,
  MigrationImportSelection,
  MigrationRepoCandidate,
  MigrationScan,
  MigrationScanArgs,
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
import { convertTranscript } from './convert'
import { detectAgentSessions } from './sessions'

/**
 * 이미 있는 git worktree 를 Wooi 워크스페이스로 들여온다.
 *
 * 대상은 **리포에 딸린 worktree 전부**다 — 손으로 만든 것이든, 다른 도구(Conductor·Orca)가
 * 만든 것이든, 예전에 Wooi 가 만들었다가 상태에서 사라진 것이든 가리지 않는다. 다른 도구는
 * 두 가지를 얹어 줄 뿐이다: 아직 등록되지 않은 리포 경로를 알려 주고, worktree 에 사람이
 * 붙여 둔 이름과 셋업 명령을 채워 준다.
 *
 * 네 가지 원칙 위에 서 있다.
 *
 * 1. **아무것도 옮기거나 지우지 않는다.** worktree 는 있던 자리 그대로 두고 Wooi 워크스페이스가
 *    그 경로를 가리키게만 한다. 디렉터리를 옮기면 그것을 만든 도구가 자기 작업을 잃고,
 *    사용자는 아직 Wooi 를 써 보지도 않은 채 되돌릴 수 없는 상태가 된다.
 * 2. **git 이 판정한다.** 다른 도구의 DB·JSON 은 이미 지워진 worktree 도 기억한다. 그래서
 *    후보는 언제나 `git worktree list` 가 내놓은 것이고, 브랜치 이름도 그 목록에서 읽는다.
 * 3. **대화도 따라온다.** 그 디렉터리에서 돌던 CLI 세션이 있으면 id 를 이어받아 다음 턴이
 *    맥락 위에서 시작한다([[migrate/sessions]]). 이어받을지는 항목별로 고른다.
 * 4. **두 번 눌러도 안전하다.** 이미 등록된 리포·이미 들여온 worktree 는 후보 단계에서
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
  /**
   * 대화를 이어받은 워크스페이스의 트랜스크립트를 채운다 — 옮겨 온 지난 대화와, 그 앞에
   * 놓일 안내 한 줄. 트랜스크립트 저장소는 electron userData 에 매여 있어 여기서 직접
   * 건드리지 않고 주입받는다(테스트가 파일을 만들지 않도록).
   */
  noteImport?: (workspaceId: string, items: ChatItem[]) => void
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
 * **읽기 전용 열기는 WAL 앞에서 자주 실패한다.** Conductor 의 DB 는 WAL 모드인데, 공유 메모리
 * 파일(`-shm`)이 없는 상태로 `-readonly` 로 열면 sqlite 가 그것을 만들지 못해 SQLITE_CANTOPEN
 * 으로 끝난다(앱이 떠 있지 않아도 그렇다 — 실측). 그래서 실패하면 DB 를 사이드카까지 임시로
 * 복사해 **읽기 전용 없이** 다시 읽는다. 쓰기가 일어나더라도 그건 우리 사본이고 원본은 손대지
 * 않는다. 남의 앱을 먼저 끄게 만들면 정작 무엇을 옮길 수 있는지 보지도 못하고 포기하게 된다.
 */
async function readTable(dbPath: string, table: string): Promise<unknown> {
  const query = `select * from ${table}`
  try {
    return parseSqliteJson(await runSqlite(dbPath, query, { readonly: true }))
  } catch (err) {
    log.warn(`sqlite 읽기 실패(${table}) — 사본으로 재시도합니다: ${String(err)}`)
  }
  const dir = mkdtempSync(join(tmpdir(), 'wooi-migrate-'))
  try {
    const copy = join(dir, basename(dbPath))
    copyFileSync(dbPath, copy)
    // WAL 은 최근 쓰기가 사이드카에만 있을 수 있다. 함께 복사해야 사본이 같은 내용을 본다.
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, copy + suffix)
    }
    return parseSqliteJson(await runSqlite(copy, query, { readonly: false }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function runSqlite(
  dbPath: string,
  query: string,
  options: { readonly: boolean }
): Promise<string> {
  const args = options.readonly ? ['-readonly', '-json', dbPath, query] : ['-json', dbPath, query]
  const { stdout } = await exec('sqlite3', args, { maxBuffer: 1024 * 1024 * 64 })
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
  id: MigrationSourceId
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
  return { id: 'conductor', dataPath: dbPath, repos: parseConductor(repos, workspaces, env.home) }
}

function readOrca(env: MigrationEnv): SourceRead | null {
  const dataPath = firstExisting(orcaDataCandidates(env))
  if (!dataPath) return null
  const raw = JSON.parse(readFileSync(dataPath, 'utf-8')) as unknown
  return { id: 'orca', dataPath, repos: parseOrca(raw) }
}

const SOURCE_LABELS: Record<MigrationSourceId, string> = {
  conductor: 'Conductor',
  orca: 'Orca'
}

export function repoKeyFor(repoPath: string): string {
  return `repo:${canonical(repoPath)}`
}

export function workspaceKeyFor(worktreePath: string): string {
  return `ws:${canonical(worktreePath)}`
}

/** 스캔이 후보를 모으는 단위 — 리포 하나와, 그 리포에 대해 알아낸 부가 정보. */
interface RepoTarget {
  path: string
  name: string
  /** 이 리포를 알려 준 도구. 이미 등록된 리포를 훑는 것이면 null. */
  source: MigrationSourceId | null
  setupScript: string
  archiveScript: string
  runScripts: { name: string; command: string }[]
  /** 그 도구가 worktree 에 붙여 둔 이름(경로 → 이름). 없으면 디렉터리 이름을 쓴다. */
  names: Map<string, string>
}

/**
 * 훑을 리포 목록. **이미 등록된 리포가 1순위**다 — 이 기능의 본체는 "리포 하나의 worktree 를
 * 워크스페이스로 들여온다" 이고, 다른 도구는 아직 등록되지 않은 리포를 추가로 알려 줄 뿐이다.
 *
 * 같은 리포를 두 도구가 함께 알고 있으면 먼저 잡힌 쪽이 이긴다(경로로 중복을 없앤다).
 */
async function collectTargets(
  deps: Pick<MigrationDeps, 'env' | 'getState'>,
  args: MigrationScanArgs,
  warnings: string[]
): Promise<RepoTarget[]> {
  const state = deps.getState()
  const byPath = new Map<string, RepoTarget>()

  const registered = args.repoId
    ? state.repos.filter((repo) => repo.id === args.repoId)
    : state.repos
  for (const repo of registered) {
    byPath.set(canonical(repo.path), {
      path: repo.path,
      name: repo.name,
      source: null,
      setupScript: '',
      archiveScript: '',
      runScripts: [],
      names: new Map()
    })
  }

  // 리포 하나만 보는 호출(리포 메뉴에서 연 경우)에는 다른 도구를 뒤지지 않는다 — 사용자가
  // 물은 것은 "이 리포에 안 들여온 worktree 가 있나" 하나다.
  if (args.repoId) return [...byPath.values()]

  const reads: SourceRead[] = []
  try {
    const conductor = await readConductor(deps.env)
    if (conductor) reads.push(conductor)
  } catch (err) {
    warnings.push(`Could not read Conductor's data (${errorText(err)}).`)
  }
  try {
    const orca = readOrca(deps.env)
    if (orca) reads.push(orca)
  } catch (err) {
    warnings.push(`Could not read Orca's data (${errorText(err)}).`)
  }

  for (const read of reads) {
    for (const foreign of read.repos) {
      const key = canonical(foreign.path)
      const existing = byPath.get(key)
      const names = new Map(foreign.workspaces.map((ws) => [canonical(ws.path), ws.name]))
      if (existing) {
        // 이미 등록된 리포라도 이름 정보는 쓸 만하다. 설정은 덮어쓰지 않는다 — 사용자가
        // Wooi 에서 이미 정해 둔 것이 있고, 그걸 남의 앱 값으로 되돌리면 안 된다.
        for (const [path, name] of names) existing.names.set(path, name)
        continue
      }
      byPath.set(key, {
        path: foreign.path,
        name: foreign.name,
        source: read.id,
        setupScript: foreign.setupScript,
        archiveScript: foreign.archiveScript,
        runScripts: foreign.runScripts,
        names
      })
    }
  }
  return [...byPath.values()]
}

/**
 * 들여올 수 있는 것을 전부 훑는다. 부작용은 없다 — 읽기만 한다.
 *
 * 남은 것이 없는 리포는 목록에서 뺀다. 그래야 "결과가 비어 있다 = 할 일이 없다" 가 되어,
 * 이 스캔 하나로 안내 배너를 띄울지 결정할 수 있다.
 */
export async function scanMigration(
  args: MigrationScanArgs,
  deps: Pick<MigrationDeps, 'env' | 'getState'>
): Promise<MigrationScan> {
  const state = deps.getState()
  const knownRepos = new Set(state.repos.map((repo) => canonical(repo.path)))
  const knownWorktrees = new Set(state.workspaces.map((ws) => canonical(ws.worktreePath)))
  // 브랜치 충돌은 리포 단위로 본다 — 같은 브랜치를 두 worktree 가 체크아웃할 수 없으므로,
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
  const targets = await collectTargets(deps, args, warnings)

  const repos: MigrationRepoCandidate[] = []
  const pendingPaths: string[] = []
  for (const target of targets) {
    if (!existsSync(target.path)) continue
    if (!(await isGitRepo(target.path))) continue
    const repoPath = canonical(target.path)
    const alreadyAdded = knownRepos.has(repoPath)
    const takenBranches = branchesByRepoPath.get(repoPath) ?? new Set<string>()

    const workspaces: MigrationWorkspaceCandidate[] = []
    for (const entry of await listWorktrees(target.path)) {
      const path = canonical(entry.path)
      if (path === repoPath) continue // 메인 체크아웃은 워크스페이스가 아니다
      // detached HEAD 인 worktree 는 Wooi 의 모델(워크스페이스 = 브랜치 하나)에 담기지 않는다.
      if (!entry.branch) continue
      const alreadyImported = knownWorktrees.has(path) || takenBranches.has(entry.branch)
      if (!alreadyImported) pendingPaths.push(path)
      workspaces.push({
        key: workspaceKeyFor(path),
        name: target.names.get(path) ?? basename(path),
        branch: entry.branch,
        worktreePath: path,
        alreadyImported,
        session: null
      })
    }

    // 등록도 돼 있고 남은 worktree 도 없으면 사용자가 할 일이 없다.
    if (alreadyAdded && workspaces.every((ws) => ws.alreadyImported)) continue
    repos.push({
      key: repoKeyFor(repoPath),
      name: target.name,
      path: target.path,
      alreadyAdded,
      source: target.source,
      sourceLabel: target.source ? SOURCE_LABELS[target.source] : null,
      setupScript: target.setupScript,
      archiveScript: target.archiveScript,
      runScripts: target.runScripts,
      workspaces
    })
  }

  // 세션 조회는 아직 안 들여온 worktree 에 대해서만, 한 번에 모아서 한다([[migrate/sessions]]).
  const sessions = detectAgentSessions(pendingPaths, deps.env.home)
  for (const repo of repos) {
    for (const ws of repo.workspaces) {
      if (!ws.alreadyImported) ws.session = sessions.get(ws.worktreePath) ?? null
    }
  }

  return { repos, warnings }
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
 * 키를 받아 **다시 훑어 대조하는** 것이 요점이다. 렌더러가 보낸 경로를 그대로 믿으면 IPC 가
 * 임의 디렉터리를 워크스페이스로 등록하는 통로가 된다(같은 이유로 repo:update 도 저장 시점에
 * 다시 검증한다). 재스캔 비용은 git 호출 몇 번이고, 사용자가 버튼을 누른 직후 한 번뿐이다.
 */
export async function importMigration(
  selection: MigrationImportSelection,
  deps: MigrationDeps
): Promise<MigrationImportResult> {
  const scan = await scanMigration({}, deps)
  const repoKeys = new Set(selection.repoKeys)
  const workspaceKeys = new Set(selection.workspaceKeys)
  const sessionKeys = new Set(selection.sessionKeys)
  const errors: string[] = []
  let importedRepos = 0
  let importedWorkspaces = 0
  let importedSessions = 0

  for (const candidate of scan.repos) {
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
      const session = sessionKeys.has(ws.key) ? ws.session : null
      try {
        const workspace = await buildWorkspace(repo, ws, session, deps)
        deps.update((state) => state.workspaces.push(workspace))
        importedWorkspaces++
        if (session) {
          importedSessions++
          deps.noteImport?.(workspace.id, restoredTranscript(ws, session))
        }
      } catch (err) {
        errors.push(`${ws.name}: ${errorText(err)}`)
      }
    }
  }

  return {
    repos: importedRepos,
    workspaces: importedWorkspaces,
    sessions: importedSessions,
    errors
  }
}

/**
 * 이어받은 워크스페이스의 트랜스크립트 — 안내 한 줄 + 옮겨 온 지난 대화.
 *
 * 안내가 없으면 화면과 실제가 어긋난다: 에이전트는 지난 맥락을 전부 기억하는데 대화창은
 * 비어 있어서, 사용자는 자기가 하지 않은 말을 전제로 답하는 에이전트를 보게 된다. 지난 대화를
 * 옮겨 오면 그 어긋남은 사라지지만, **누가 쓴 기록인지**는 여전히 말해 줘야 한다 — 이 항목들은
 * Wooi 가 만든 것이 아니라 다른 도구의 파일을 옮겨 적은 사본이다.
 *
 * 옮기기에 실패해도(형식이 바뀌었거나 파일이 사라졌거나) 안내는 남는다. 그 경우 이어받기 자체는
 * 여전히 유효하다 — 맥락은 CLI 가 들고 있고, 화면에만 안 보일 뿐이다.
 */
export function restoredTranscript(
  candidate: Pick<MigrationWorkspaceCandidate, 'worktreePath'>,
  session: MigrationAgentSession
): ChatItem[] {
  const tool = session.backend === 'claude' ? 'Claude Code' : 'Codex'
  let restored: ChatItem[] = []
  let dropped = 0
  try {
    const converted = convertTranscript(session.backend, readFileSync(session.sourcePath, 'utf-8'))
    restored = converted.items
    dropped = converted.dropped
  } catch (err) {
    log.warn(`지난 대화를 옮기지 못했습니다(${session.sourcePath}): ${String(err)}`)
  }

  const summary =
    restored.length > 0
      ? `The ${restored.length.toLocaleString()} message${restored.length === 1 ? '' : 's'} below came from that conversation${dropped > 0 ? `, with ${dropped.toLocaleString()} older ones left out` : ''}.`
      : 'Its earlier messages could not be read, so they are not shown here — the agent still has them.'

  return [
    {
      id: 'import-note',
      type: 'system',
      text: [
        `Imported this worktree from ${candidate.worktreePath}, continuing the ${tool} conversation “${session.label}”.`,
        summary
      ].join(' '),
      // 옮겨 온 첫 항목보다 앞선 시각으로 둔다 — 화면 순서는 배열이 정하지만, 표시되는 시각이
      // 뒤따르는 메시지보다 미래면 읽는 사람이 순서를 의심하게 된다.
      ts: restored[0] ? restored[0].ts - 1 : Date.now()
    },
    ...restored
  ]
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
    // 다른 도구에도 "새 worktree 에 딸려 보낼 무시된 파일" 개념이 있지만 저장 위치가 서로 달라,
    // 옮기기보다 Wooi 가 리포를 직접 훑어 채우는 편이 정확하다(repo:add 와 같은 규칙).
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
  session: MigrationAgentSession | null,
  deps: MigrationDeps
): Promise<Workspace> {
  const state = deps.getState()
  const settings = state.settings
  // 대화를 이어받으면 백엔드도 그 대화의 것으로 정해진다 — 다른 백엔드로 열면 resume 토큰이
  // 아무 의미가 없고, 사용자는 맥락을 잃은 채로 시작하게 된다.
  const agentBackend = session?.backend ?? settings.defaultAgentBackend
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
    // 스택 관계는 옮겨오지 않는다. 다른 도구에는 대응하는 개념이 없거나 형태가 달라서,
    // 짐작해 넣으면 restack·PR retarget 이 사용자가 만든 적 없는 관계 위에서 돈다.
    baseBranch: repo.defaultBranch,
    parentWorkspaceId: null,
    createdByWorkspaceId: null,
    prNumber: null,
    worktreePath: candidate.worktreePath,
    ports,
    // 셋업은 이 디렉터리에서 이미 돌았다(node_modules 가 그 증거다). 'idle' 로 두면 Wooi 가
    // 아직 돌지 않은 것으로 보고 재실행을 권한다.
    setupState: 'success',
    sessionId: session?.sessionId ?? null,
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
