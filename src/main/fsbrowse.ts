import { execFile } from 'node:child_process'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute, sep, basename } from 'node:path'
import { promisify } from 'node:util'
import type { DirEntry, FileContent, FileHit } from '@shared/types'

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
    const truncated = buf.length > READ_MAX_BYTES
    const slice = truncated ? buf.subarray(0, READ_MAX_BYTES) : buf
    if (slice.includes(0)) {
      return { path: relPath, text: '', truncated, binary: true }
    }
    return { path: relPath, text: slice.toString('utf-8'), truncated, binary: false }
  } catch {
    return null
  }
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
