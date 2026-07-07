import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'
import type { DirEntry, FileContent } from '@shared/types'

/** 파일 뷰어가 한 번에 읽는 최대 바이트(초과분은 잘라 표시). */
const READ_MAX_BYTES = 1024 * 1024

/**
 * relPath 가 root 안으로 해석되는지 검증하고 절대 경로를 돌려준다.
 * 심볼릭 링크/`..` 로 worktree 밖을 읽지 못하게 막는다(읽기 전용 뷰어라도 격리 유지).
 */
function resolveInRoot(root: string, relPath: string): string | null {
  const abs = resolve(root, relPath)
  const rel = relative(root, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return abs
}

/**
 * worktree 내 한 디렉토리의 항목을 나열한다(All files 탭의 lazy 트리용).
 * 디렉토리 먼저, 그다음 파일을 이름순으로. `.git` 은 노이즈라 숨긴다.
 */
export async function listDir(root: string, relPath: string): Promise<DirEntry[]> {
  const abs = resolveInRoot(root, relPath)
  if (!abs) return []

  const dirents = await readdir(abs, { withFileTypes: true }).catch(() => [])
  const entries: DirEntry[] = []
  for (const d of dirents) {
    if (d.name === '.git') continue
    // 심볼릭 링크는 디렉토리/파일 어느 쪽인지 따로 확인한다(루프·외부 탈출은 읽기 시 막힌다).
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
  const abs = resolveInRoot(root, relPath)
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
