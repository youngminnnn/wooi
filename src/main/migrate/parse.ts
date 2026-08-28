import { basename, join } from 'node:path'

/**
 * Conductor·Orca 의 저장 형식을 읽어 "옮겨올 수 있는 것" 으로 바꾸는 순수 파서.
 *
 * 스캔 본체(index.ts)와 나눠 둔 이유는 **검증 가능성**이다 — 여기서 읽는 것은 남의 앱이
 * 소유한 형식이고, 그 형식은 우리 릴리스와 무관하게 바뀐다. 파일 입출력과 git 호출을
 * 걷어내면 "이 모양이 들어오면 이 목록이 나온다" 를 그대로 테스트할 수 있다.
 *
 * 파싱 규칙은 전부 **관대하게**: 모르는 컬럼·필드는 무시하고, 필요한 값이 없으면 그 항목만
 * 조용히 버린다. 저쪽이 스키마를 하나 바꿨다고 마이그레이션 전체가 실패하면 안 된다.
 */

/** 다른 도구가 만들어 둔 worktree 하나(그 도구의 기억일 뿐 — 실재 여부는 git 이 판정한다). */
export interface ForeignWorkspace {
  path: string
  name: string
}

/** 다른 도구에 등록돼 있던 리포 하나. */
export interface ForeignRepo {
  /** 그 도구 안에서의 id. 스캔 키의 재료라 같은 데이터에서 항상 같은 값이어야 한다. */
  externalId: string
  name: string
  path: string
  setupScript: string
  archiveScript: string
  runScripts: { name: string; command: string }[]
  workspaces: ForeignWorkspace[]
}

type Row = Record<string, unknown>

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 문자열 컬럼을 다듬어 읽는다. null·숫자·누락은 전부 빈 문자열이다. */
function str(row: Row, key: string): string {
  const value = row[key]
  return typeof value === 'string' ? value.trim() : ''
}

// ── Conductor ──────────────────────────────────────────────────────────────

/**
 * Conductor 의 sqlite 테이블 두 개(`repos`, `workspaces`)를 읽는다.
 *
 * `select *` 로 통째로 받아 여기서 필요한 컬럼만 꺼내는 것이 요점이다. Conductor 는 컬럼을
 * `ALTER TABLE` 로 계속 덧붙여 왔고(archive_script·run_script·hidden 은 뒤에 생겼다), 컬럼을
 * 명시해 질의하면 그 컬럼이 없던 시절의 DB 에서 질의 자체가 실패한다.
 *
 * @param home worktree 경로가 비어 있는 옛 레코드의 폴백(`~/conductor/workspaces/<리포>/<이름>`)에 쓴다.
 */
export function parseConductor(
  repoRows: unknown,
  workspaceRows: unknown,
  home: string
): ForeignRepo[] {
  const repos = Array.isArray(repoRows) ? repoRows.filter(isRow) : []
  const workspaces = Array.isArray(workspaceRows) ? workspaceRows.filter(isRow) : []

  const out: ForeignRepo[] = []
  for (const row of repos) {
    const path = str(row, 'root_path')
    const id = str(row, 'id')
    if (!path || !id) continue
    // 숨긴 리포는 사용자가 Conductor 목록에서 치운 것이다 — 옮겨오면 치운 것이 되살아난다.
    if (row.hidden === 1 || row.hidden === true) continue

    const name = str(row, 'name') || basename(path)
    const runScript = str(row, 'run_script')
    const mine = workspaces.filter((ws) => str(ws, 'repository_id') === id)
    out.push({
      externalId: id,
      name,
      path,
      setupScript: str(row, 'setup_script'),
      archiveScript: str(row, 'archive_script'),
      // Conductor 의 실행 명령은 리포당 하나뿐이라 이름이 없다. Wooi 의 run script 는 이름으로
      // 포트 환경변수를 만들므로($PORT_<이름>) 여기서 관례적인 이름을 하나 붙여 준다.
      runScripts: runScript ? [{ name: 'dev', command: runScript }] : [],
      workspaces: mine.flatMap((ws) => {
        const directory = str(ws, 'directory_name')
        // 아카이브·삭제된 워크스페이스는 worktree 가 이미 없다. 상태를 모르는 옛 레코드는
        // 살아 있는 것으로 보고, 실재 여부는 뒤에서 git 이 걸러 낸다.
        const state = str(ws, 'state')
        if (state && state !== 'ready' && state !== 'active') return []
        const path =
          str(ws, 'workspace_path') ||
          (directory ? join(home, 'conductor', 'workspaces', name, directory) : '')
        if (!path) return []
        return [{ path, name: directory || basename(path) }]
      })
    })
  }
  return out
}

// ── Orca ───────────────────────────────────────────────────────────────────

/** `worktreeMeta` 의 키는 `<repoId>::<worktree 절대경로>` 다. */
function splitOrcaWorktreeKey(key: string): { repoId: string; path: string } | null {
  const at = key.indexOf('::')
  if (at <= 0) return null
  const path = key.slice(at + 2)
  if (!path.startsWith('/')) return null
  return { repoId: key.slice(0, at), path }
}

/**
 * Orca 의 `orca-data.json` 을 읽는다.
 *
 * Orca 는 worktree 목록을 저장하지 않고 매번 git 에게 묻는다 — 저장되는 것은 사용자가 붙인
 * 이름 같은 메타데이터(`worktreeMeta`)뿐이다. 그래서 여기서 나오는 목록도 "Orca 가 이름을
 * 기억하는 worktree" 이고, 실재 여부·브랜치는 뒤에서 git 이 채운다.
 *
 * 로컬이 아닌 리포(SSH·원격 런타임)와 git 이 아닌 폴더는 건너뛴다. Wooi 의 워크스페이스는
 * 로컬 worktree 를 전제하므로, 옮겨 놔도 열리지 않는 항목을 목록에 올릴 이유가 없다.
 */
export function parseOrca(raw: unknown): ForeignRepo[] {
  if (!isRow(raw)) return []
  const repos = Array.isArray(raw.repos) ? raw.repos.filter(isRow) : []
  const meta = isRow(raw.worktreeMeta) ? raw.worktreeMeta : {}

  const namesByRepo = new Map<string, ForeignWorkspace[]>()
  for (const [key, value] of Object.entries(meta)) {
    const parsed = splitOrcaWorktreeKey(key)
    if (!parsed) continue
    const entry = isRow(value) ? value : {}
    if (entry.isArchived === true) continue
    const list = namesByRepo.get(parsed.repoId) ?? []
    list.push({ path: parsed.path, name: str(entry, 'displayName') || basename(parsed.path) })
    namesByRepo.set(parsed.repoId, list)
  }

  const out: ForeignRepo[] = []
  for (const row of repos) {
    const id = str(row, 'id')
    const path = str(row, 'path')
    if (!id || !path) continue
    if (str(row, 'kind') === 'folder') continue
    if (str(row, 'connectionId')) continue
    const host = str(row, 'executionHostId')
    if (host && host !== 'local') continue

    out.push({
      externalId: id,
      name: str(row, 'displayName') || basename(path),
      path,
      // Orca 의 셋업 훅은 리포 안의 `orca.yaml` 에 산다 — 앱 설정에 옮겨올 것이 없다.
      setupScript: '',
      archiveScript: '',
      runScripts: [],
      // 메인 체크아웃 자신도 worktree 목록에 있으므로 여기서 뺀다.
      workspaces: (namesByRepo.get(id) ?? []).filter((ws) => ws.path !== path)
    })
  }
  return out
}
