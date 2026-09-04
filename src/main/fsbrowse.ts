import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute, sep, basename, dirname } from 'node:path'
import { promisify } from 'node:util'
import type { DirEntry, FileContent, FileHit, FileWriteResult } from '@shared/types'
import { classifySave } from '@shared/fileEdit'
import { writeFileAtomic } from './fsutil'

const exec = promisify(execFile)

/** 파일 뷰어가 한 번에 읽는 최대 바이트(초과분은 잘라 표시). */
const READ_MAX_BYTES = 1024 * 1024

/**
 * relPath 가 root 안으로 해석되는지 **경로 문자열로만** 검증하고 절대 경로를 돌려준다.
 * `..` 는 막지만 심볼릭 링크는 따라가지 않는다 — 실제 격리는 realPathInRoot 가 지킨다.
 */
function resolveInRoot(root: string, relPath: string): string | null {
  const abs = resolve(root, relPath)
  const rel = relative(root, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return abs
}

/**
 * 심볼릭 링크까지 따라간 **뒤에도** root 안인지 확인한다. 밖으로 나가면 null.
 *
 * `resolve()` 는 경로 문자열만 정규화하므로 `..` 밖에 못 막는다. worktree 안의 링크 하나가
 * `/etc` 나 다른 워크스페이스를 가리키면 그대로 열렸다 — 읽기 전용 뷰어라도 격리는 격리다.
 * 워크트리 안의 파일은 에이전트가 만든 것이기도 해서, 링크를 심는 쪽과 읽는 쪽이 다른 사람일
 * 필요도 없다.
 *
 * root 도 함께 realpath 한다 — macOS 의 `/tmp` → `/private/tmp` 처럼 root 자체가 링크 뒤에
 * 있으면, 안쪽 경로만 풀었을 때 멀쩡한 파일이 전부 "밖" 으로 판정된다.
 */
async function realPathInRoot(root: string, relPath: string): Promise<string | null> {
  const abs = resolveInRoot(root, relPath)
  if (!abs) return null
  try {
    const [realRoot, real] = await Promise.all([realpath(root), realpath(abs)])
    const rel = relative(realRoot, real)
    // 빈 문자열은 root 자신이다(허용).
    if (rel && (rel.startsWith('..') || isAbsolute(rel))) return null
    return abs
  } catch {
    // 없는 경로·끊어진 링크·권한 — 어느 쪽이든 보여 줄 것이 없다.
    return null
  }
}

/**
 * **쓰기 대상**의 절대 경로를 정한다. 아직 없는 파일도 허용한다는 점만 `realPathInRoot` 와 다르다.
 *
 * 지워진 파일에 초안을 되살려 저장하려면 대상이 없는 상태에서도 경로를 정해야 하는데,
 * `realpath` 는 없는 경로에서 그냥 실패한다. 그래서 **부모 디렉토리**를 realpath 해서 격리를
 * 확인하고 파일명을 다시 붙인다 — 링크로 밖을 가리키는 디렉토리는 여기서 걸린다.
 */
async function realWriteTargetInRoot(root: string, relPath: string): Promise<string | null> {
  const existing = await realPathInRoot(root, relPath)
  if (existing) return existing

  const abs = resolveInRoot(root, relPath)
  // root 자신에는 쓸 수 없다(basename 이 없다).
  if (!abs || abs === resolve(root)) return null

  const parent = await realPathInRoot(root, relative(root, dirname(abs)))
  if (!parent) return null
  // 부모가 디렉토리가 아니면 그 밑에 쓸 수 없다.
  const parentInfo = await stat(parent).catch(() => null)
  if (!parentInfo?.isDirectory()) return null
  return join(parent, basename(abs))
}

/**
 * worktree 내 한 디렉토리의 항목을 나열한다(All files 탭의 lazy 트리용).
 * 디렉토리 먼저, 그다음 파일을 이름순으로. `.git` 은 노이즈라 숨긴다.
 */
export async function listDir(root: string, relPath: string): Promise<DirEntry[]> {
  const abs = await realPathInRoot(root, relPath)
  if (!abs) return []

  const dirents = await readdir(abs, { withFileTypes: true }).catch(() => [])
  const entries: DirEntry[] = []
  for (const d of dirents) {
    if (d.name === '.git') continue
    // 심볼릭 링크는 디렉토리/파일 어느 쪽인지 따로 확인한다. 밖을 가리키는 링크라도 목록에는
    // 그대로 두고(있는 것을 감추지 않는다), 열거나 읽으려 하면 realPathInRoot 가 막는다.
    let isDir = d.isDirectory()
    if (d.isSymbolicLink()) {
      isDir = await stat(join(abs, d.name))
        .then((s) => s.isDirectory())
        .catch(() => false)
    }
    const childRel = relPath ? `${relPath}${sep}${d.name}` : d.name
    entries.push({ name: d.name, path: childRel, isDir })
  }

  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return entries
}

/** worktree 내 한 파일을 읽어 표시용 텍스트로 돌려준다(바이너리·과대 파일은 본문 없이 표시). */
export async function readFileInRoot(root: string, relPath: string): Promise<FileContent | null> {
  const abs = await realPathInRoot(root, relPath)
  if (!abs) return null

  try {
    const info = await stat(abs)
    if (!info.isFile()) return null

    const buf = await readFile(abs)
    // 해시는 **잘리기 전 전체**를 대상으로 한다. 화면에 보이는 앞부분만 해시하면, 뒷부분만
    // 바뀐 파일을 "안 바뀌었다" 로 보고 통째로 덮어쓰게 된다.
    const sha = createHash('sha256').update(buf).digest('hex')
    const truncated = buf.length > READ_MAX_BYTES
    const slice = truncated ? buf.subarray(0, READ_MAX_BYTES) : buf
    if (slice.includes(0)) {
      return { path: relPath, text: '', truncated, binary: true, sha }
    }
    return { path: relPath, text: slice.toString('utf-8'), truncated, binary: false, sha }
  } catch {
    return null
  }
}

/**
 * 뷰어에서 고친 파일을 worktree 에 저장한다.
 *
 * `baselineSha` 는 편집을 시작할 때 읽은 내용의 해시다. 쓰기 직전에 디스크를 다시 읽어
 * 그 해시와 맞춰 보고, 다르면 **쓰지 않고** 지금 디스크에 있는 내용을 함께 돌려준다 —
 * 사람과 에이전트가 같은 워크트리를 동시에 만지는 앱이라 이 확인이 없으면 남의 작업이
 * 조용히 사라진다. 사용자가 경고를 보고 고른 `force` 만 이 검사를 건너뛴다.
 *
 * 이건 낙관적 동시성 제어지 잠금이 아니다 — 확인과 쓰기 사이의 짧은 틈은 남는다. 파일
 * 시스템에 compare-and-swap 이 없으므로 그 틈을 없앨 수는 없고, 여기서 막으려는 것은
 * 몇 초~몇 분에 걸친 "열어 놓고 고치는 동안 바뀐" 경우다.
 */
export async function writeFileInRoot(
  root: string,
  relPath: string,
  text: string,
  baselineSha: string | null,
  opts: { force?: boolean } = {}
): Promise<FileWriteResult> {
  const abs = await realWriteTargetInRoot(root, relPath)
  if (!abs) return { ok: false, reason: 'denied' }

  const current = await readFileInRoot(root, relPath)
  // 있기는 한데 파일이 아니면(디렉토리·소켓 등) 손대지 않는다.
  if (!current && (await stat(abs).catch(() => null))) return { ok: false, reason: 'denied' }

  const verdict = classifySave({
    baselineSha,
    diskSha: current?.sha ?? null,
    force: opts.force
  })
  if (verdict.kind === 'conflict') {
    return { ok: false, reason: 'conflict', conflict: verdict.conflict, current }
  }

  try {
    // 원본 권한을 물려준다. 없던 파일(force 로 되살리는 경우)이면 기본 권한에 맡긴다.
    const mode = await stat(abs)
      .then((info) => info.mode & 0o777)
      .catch(() => undefined)
    writeFileAtomic(abs, text, { mode })
  } catch (e) {
    return { ok: false, reason: 'error', message: e instanceof Error ? e.message : String(e) }
  }

  const saved = await readFileInRoot(root, relPath)
  // 방금 쓴 파일을 못 읽는 경우는 사실상 없지만, 못 읽으면 새 baseline 을 줄 수 없다.
  if (!saved)
    return { ok: false, reason: 'error', message: 'Saved, but could not re-read the file.' }
  return { ok: true, content: saved }
}

// ── @멘션 자동완성용 파일 인덱스 ─────────────────────────────────────────

/** 인덱스 재사용 시간(ms). 에이전트가 만든 파일도 곧 후보에 뜨도록 짧게 잡는다. */
const INDEX_TTL_MS = 5_000
/** 인덱스에 담는 최대 경로 수(거대 저장소에서 메모리·정렬 비용을 자른다). */
const INDEX_MAX = 20_000
/** 비-git 폴백 워크가 훑는 최대 디렉토리 수. */
const WALK_MAX_DIRS = 2_000

const indexCache = new Map<string, { at: number; entries: FileHit[] }>()

/**
 * git 이 아는 파일 목록(추적 + 미추적, `.gitignore` 제외).
 * Claude Code CLI 도 같은 방식으로 @멘션 인덱스를 만들기 때문에 후보 집합이 CLI 와 일치한다.
 * git 저장소가 아니거나 git 이 실패하면 null 을 돌려 폴백을 타게 한다.
 */
async function gitFiles(root: string): Promise<string[] | null> {
  try {
    const { stdout } = await exec(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd: root, maxBuffer: 1024 * 1024 * 64 }
    )
    // -z 는 NUL 구분이라 공백·개행이 든 경로도 안전하게 나뉜다.
    return stdout.split('\0').filter(Boolean)
  } catch {
    return null
  }
}

/** git 이 없을 때의 폴백. 노이즈가 큰 디렉토리는 건너뛰고 너비 우선으로 훑는다. */
async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = []
  const queue: string[] = ['']
  let dirs = 0

  while (queue.length && out.length < INDEX_MAX && dirs < WALK_MAX_DIRS) {
    const rel = queue.shift() as string
    dirs++
    const abs = resolveInRoot(root, rel)
    if (!abs) continue

    const dirents = await readdir(abs, { withFileTypes: true }).catch(() => [])
    for (const d of dirents) {
      if (d.name === '.git' || d.name === 'node_modules') continue
      const childRel = rel ? `${rel}/${d.name}` : d.name
      if (d.isDirectory()) queue.push(childRel)
      else if (d.isFile()) out.push(childRel)
    }
  }
  return out
}

/** 파일 목록에서 상위 디렉토리를 유도해, `@src/` 같은 디렉토리 멘션도 후보에 넣는다. */
async function buildIndex(root: string): Promise<FileHit[]> {
  const files = (await gitFiles(root)) ?? (await walkFiles(root))
  const capped = files.slice(0, INDEX_MAX)

  const dirs = new Set<string>()
  for (const p of capped) {
    let i = p.lastIndexOf('/')
    while (i > 0) {
      dirs.add(p.slice(0, i))
      i = p.lastIndexOf('/', i - 1)
    }
  }

  const entries: FileHit[] = capped.map((path) => ({ path, isDir: false }))
  for (const path of dirs) entries.push({ path, isDir: true })
  return entries
}

/** hay 안에 needle 의 글자들이 순서대로 등장하는지(퍼지 매칭의 마지막 단계). */
function isSubsequence(hay: string, needle: string): boolean {
  if (!needle) return true
  let i = 0
  for (const ch of hay) {
    if (ch === needle[i]) i++
    if (i === needle.length) return true
  }
  return false
}

/**
 * 후보 1개의 순위. 낮을수록 위. 매칭 실패는 -1.
 * 질의에 `/` 가 있으면 경로 전체로, 없으면 파일명을 우선해 맞춘다(CLI 체감과 맞춘다).
 */
function rankOf(entry: FileHit, q: string): number {
  if (!q) return 0

  const path = entry.path.toLowerCase()
  if (q.includes('/')) {
    if (path.startsWith(q)) return 0
    if (path.includes(q)) return 1
    return isSubsequence(path, q) ? 3 : -1
  }

  const name = basename(entry.path).toLowerCase()
  if (name.startsWith(q)) return 0
  if (name.includes(q)) return 1
  if (path.includes(q)) return 2
  return isSubsequence(path, q) ? 3 : -1
}

/**
 * 입력창의 `@부분경로` 자동완성 후보를 점수순으로 돌려준다.
 * 상위 결과에만 파일 크기를 붙인다 — 큰 파일은 CLI 가 잘라 넣거나 아예 버릴 수 있어
 * 사용자가 고르기 전에 크기를 보여 줘야 한다.
 */
export async function searchFiles(root: string, query: string, limit = 30): Promise<FileHit[]> {
  const cached = indexCache.get(root)
  let entries: FileHit[]
  if (cached && Date.now() - cached.at < INDEX_TTL_MS) {
    entries = cached.entries
  } else {
    entries = await buildIndex(root)
    indexCache.set(root, { at: Date.now(), entries })
  }

  const q = query.toLowerCase()
  const scored: { e: FileHit; rank: number; depth: number }[] = []
  for (const e of entries) {
    const rank = rankOf(e, q)
    if (rank < 0) continue
    scored.push({ e, rank, depth: e.path.split('/').length })
  }

  scored.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.depth - b.depth ||
      a.e.path.length - b.e.path.length ||
      a.e.path.localeCompare(b.e.path)
  )

  // 캐시된 객체를 그대로 넘기면 아래 size 주입이 인덱스를 오염시키므로 복사본을 만든다.
  const top = scored.slice(0, limit).map((s) => ({ ...s.e }))
  await Promise.all(
    top.map(async (hit) => {
      if (hit.isDir) return
      const abs = resolveInRoot(root, hit.path)
      if (!abs) return
      hit.size = await stat(abs)
        .then((s) => s.size)
        .catch(() => undefined)
    })
  )
  return top
}
