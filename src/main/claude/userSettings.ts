import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * settingSources 로 CLI 가 읽어 들이는 settings.json 들을 직접 살펴, 특정 키를 **사용자가 이미
 * 지정했는지** 판별한다.
 *
 * 왜 필요한가: session.ts 는 query 의 인라인 `settings` 레이어로 몇 가지 플래그를 주입하는데,
 * 이 레이어는 파일 설정 "위에" 합쳐지므로 사용자가 자기 settings.json 에 적어 둔 값을 조용히
 * 덮어쓴다. 앱이 기본값을 제안하는 것과 사용자의 명시적 설정을 무시하는 것은 다르다 —
 * 주입 전에 여기서 확인해, 사용자가 직접 정한 키는 건드리지 않는다.
 *
 * 파일 목록·우선순위는 control.ts 의 readPermissions 와 같은 규칙이다(user → project → local).
 * worktree(cwd)와 원본 repo(repoPath)를 모두 본다 — settings.local.json 은 gitignore 되어
 * worktree 에는 없고 원본 repo 에만 있는 경우가 흔하기 때문이다.
 */
function userSettingsPath(): string {
  // CLI 와 같은 규칙: CLAUDE_CONFIG_DIR 이 설정 디렉토리(기본 ~/.claude)를 통째로 대체한다.
  // mcp.ts 의 configPath 와 같은 우선순위다(그쪽은 같은 디렉토리의 .claude.json 을 본다).
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim()
  return dir ? join(dir, 'settings.json') : join(homedir(), '.claude', 'settings.json')
}

function settingsFiles(cwd: string, repoPath: string | null): string[] {
  const roots = repoPath && repoPath !== cwd ? [cwd, repoPath] : [cwd]
  return [
    userSettingsPath(),
    ...roots.flatMap((root) => [
      join(root, '.claude', 'settings.json'),
      join(root, '.claude', 'settings.local.json')
    ])
  ]
}

/**
 * 사용자가 settings.json 중 하나에라도 `autoCompactWindow` 를 직접 지정했는지.
 *
 * true 면 Wooi 는 이 키를 주입하지 않고 사용자 값을 그대로 존중한다. 파일이 없거나 JSON 이
 * 깨져 있으면 "지정하지 않음"(false)으로 본다 — 읽기 실패 때문에 기본값 제안이 막히면 안 된다.
 */
export function hasUserAutoCompactWindow(cwd: string, repoPath: string | null): boolean {
  for (const file of settingsFiles(cwd, repoPath)) {
    let json: { autoCompactWindow?: unknown } | null
    try {
      json = JSON.parse(readFileSync(file, 'utf-8'))
    } catch {
      continue // 없거나 손상 → 건너뛴다.
    }
    if (typeof json?.autoCompactWindow === 'number') return true
  }
  return false
}
