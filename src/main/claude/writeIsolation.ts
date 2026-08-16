import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

export interface WriteIsolationRoot {
  path: string
  owner: string
}

interface CanonicalPolicy {
  allowed: string[]
  forbidden: Array<WriteIsolationRoot>
}

const WRITE_PATH_KEYS: Readonly<Record<string, string>> = {
  Edit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path'
}

/** 존재하지 않는 파일도 심볼릭 링크를 빠뜨리지 않도록 가장 가까운 기존 조상부터 실경로를 잇는다. */
export async function resolveWritePath(path: string, cwd: string): Promise<string> {
  let cursor = isAbsolute(path) ? path : join(cwd, path)
  const missing: string[] = []

  for (;;) {
    try {
      const ancestor = await realpath(cursor)
      return resolve(ancestor, ...missing)
    } catch {
      const parent = dirname(cursor)
      if (parent === cursor) return resolve(cursor, ...missing)
      missing.unshift(cursor.slice(parent.length).replace(/^[/\\]+/, ''))
      cursor = parent
    }
  }
}

/** 문자열 접두사가 아니라 path.relative 로 디렉터리 경계를 보존한다. */
function contains(root: string, target: string): boolean {
  const rel = relative(root, target)
  return (
    rel === '' ||
    (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
      rel !== '..' &&
      !isAbsolute(rel))
  )
}

/**
 * Claude 의 직접 파일 변경 도구만 막는 경계다. SDK 스키마에서 쓰기 경로를 가진 Edit·Write·
 * NotebookEdit 를 고정해 두고, Read·Glob·Grep 같은 읽기는 비교 작업을 위해 그대로 둔다.
 * Bash 는 임의의 셸 문법에서 실제 쓰기 대상을 신뢰성 있게 판별할 수 없어 다루지 않는다 — CLI 의
 * 샌드박스를 재구현하는 척하는 불완전한 분석보다, 이 가드의 보장 범위를 정직하게 좁힌 선택이다.
 *
 * 루트의 realpath 는 세션마다 한 번만 계산한다. store 목록은 세션 설정의 스냅샷이고 매 파일 변경마다
 * 같은 디렉터리를 다시 stat 할 이유가 없으며, 대상만 가장 가까운 기존 조상까지 확인하면 새 파일과
 * 심볼릭 링크를 함께 안전하게 판정할 수 있다.
 */
export class WriteIsolationGuard {
  private readonly policy: Promise<CanonicalPolicy>

  constructor(cwd: string, allowedRoots: string[], forbiddenRoots: WriteIsolationRoot[]) {
    this.policy = Promise.all([
      Promise.all(allowedRoots.map((path) => resolveWritePath(path, cwd))),
      Promise.all(
        forbiddenRoots.map(async (root) => ({
          ...root,
          path: await resolveWritePath(root.path, cwd)
        }))
      )
    ]).then(([allowed, forbidden]) => ({ allowed, forbidden }))
  }

  async check(
    toolName: string,
    input: Record<string, unknown>,
    cwd: string
  ): Promise<{ path: string; owner: string } | null> {
    const key = WRITE_PATH_KEYS[toolName]
    if (!key || typeof input[key] !== 'string') return null

    const target = await resolveWritePath(input[key], cwd)
    const policy = await this.policy
    if (policy.allowed.some((root) => contains(root, target))) return null

    const forbidden = policy.forbidden.find((root) => contains(root.path, target))
    return forbidden ? { path: target, owner: forbidden.owner } : null
  }
}
