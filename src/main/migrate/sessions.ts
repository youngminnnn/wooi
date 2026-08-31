import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { MigrationAgentSession } from '@shared/types'

/**
 * worktree 경로로 그 디렉터리에서 돌던 CLI 대화를 되찾는다.
 *
 * 두 CLI 모두 대화를 홈 아래 파일로 남기고 **cwd 로 색인**한다. 그래서 worktree 를 들여올 때
 * 그 경로를 열쇠 삼아 세션 id 를 되찾을 수 있고, 그 id 하나만 워크스페이스에 심으면 다음 턴이
 * 지난 맥락 위에서 시작한다(Claude 는 SDK resume, Codex 는 thread/resume).
 *
 * **원래 있던 그 디렉터리를 그대로 쓴다는 점이 중요하다.** 분기(fork)에서 Codex 승계를 포기한
 * 이유는 `thread/resume` 이 새 cwd 를 무시하고 원본 디렉터리를 붙잡기 때문인데, 들여오기는
 * 애초에 그 원본 디렉터리를 워크스페이스로 삼으므로 그 함정이 성립하지 않는다.
 *
 * 읽기만 하고, 못 읽으면 조용히 없는 것으로 친다 — 남의 앱 내부 형식이라 언제든 바뀔 수 있고,
 * 세션을 못 찾는다고 worktree 를 못 들여올 이유는 없다.
 */

/** 한 번의 스캔에서 훑어볼 Codex rollout 파일 수 상한. */
const CODEX_SCAN_LIMIT = 4000

/** 라벨을 뽑으려고 읽는 세션 파일 앞부분(바이트). 전체를 읽으면 수 MB 짜리도 있다. */
const LABEL_HEAD_BYTES = 128 * 1024

function readHead(path: string, bytes = LABEL_HEAD_BYTES): string {
  const buffer = readFileSync(path)
  return buffer.subarray(0, bytes).toString('utf-8')
}

/** 첫 줄만 필요한 파일(Codex rollout)의 헤더 한 줄. */
function readFirstJsonLine(path: string): Record<string, unknown> | null {
  try {
    const head = readHead(path, 64 * 1024)
    const line = head.split('\n', 1)[0]?.trim()
    if (!line) return null
    const parsed = JSON.parse(line) as unknown
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 첫 줄이 길면 목록에서 읽기 어렵다. 한 줄로 눌러 자른다. */
function shorten(value: string, max = 60): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

// ── Claude Code ────────────────────────────────────────────────────────────

/** cwd → CLI 프로젝트 디렉터리 이름(경로 구분자를 '-' 로 바꾼 슬러그). */
function claudeSlug(cwd: string): string {
  return cwd.replace(/\//g, '-')
}

/**
 * 이 파일이 담고 있는 대화의 이름. 사용자가 붙인 제목(`custom-title`)이 있으면 그것이고,
 * 없으면 첫 사용자 메시지의 앞부분이다. 앞부분만 읽어 판단한다.
 */
function claudeLabel(path: string): string {
  try {
    for (const line of readHead(path).split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let entry: Record<string, unknown>
      try {
        entry = JSON.parse(trimmed) as Record<string, unknown>
      } catch {
        // 앞부분만 읽었으므로 마지막 줄은 잘려 있을 수 있다.
        continue
      }
      if (entry.type === 'custom-title') {
        const title = text(entry.customTitle)
        if (title) return shorten(title)
      }
      if (entry.type === 'user') {
        const message = entry.message as { content?: unknown } | undefined
        const content = message?.content
        if (typeof content === 'string' && content.trim()) return shorten(content)
        if (Array.isArray(content)) {
          const first = content.find(
            (part): part is { type: string; text: string } =>
              typeof part === 'object' &&
              part !== null &&
              (part as { type?: unknown }).type === 'text' &&
              typeof (part as { text?: unknown }).text === 'string'
          )
          if (first?.text.trim()) return shorten(first.text)
        }
      }
    }
  } catch {
    // 못 읽으면 이름 없이 둔다 — 세션 자체는 유효하다.
  }
  return ''
}

/**
 * 이 worktree 에서 가장 최근에 쓰인 Claude Code 세션.
 *
 * 한 디렉터리에 세션 파일이 수십 개까지 쌓이므로(대화를 새로 열 때마다 하나) 최신 하나만
 * 고른다. 어느 것을 이어받을지 고르는 UI 는 두지 않는다 — 들여오기는 "그 자리에서 하던 일을
 * 계속한다" 이지 과거 대화를 뒤지는 기능이 아니다.
 */
export function detectClaudeSession(
  worktreePath: string,
  home: string
): MigrationAgentSession | null {
  const dir = join(home, '.claude', 'projects', claudeSlug(worktreePath))
  let files: string[]
  try {
    files = readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
  } catch {
    return null
  }

  let best: { id: string; path: string; updatedAt: number } | null = null
  for (const name of files) {
    const path = join(dir, name)
    let updatedAt: number
    try {
      updatedAt = statSync(path).mtimeMs
    } catch {
      continue
    }
    if (!best || updatedAt > best.updatedAt) {
      best = { id: name.slice(0, -'.jsonl'.length), path, updatedAt }
    }
  }
  if (!best) return null
  // 세션 id 는 CLI 가 발급한 UUID 다. 경로에서 온 문자열이므로 모양을 확인한다.
  if (!/^[A-Za-z0-9._-]+$/.test(best.id)) return null

  return {
    backend: 'claude',
    sessionId: best.id,
    label: claudeLabel(best.path) || 'Claude Code conversation',
    updatedAt: best.updatedAt,
    sourcePath: best.path
  }
}

// ── Codex ──────────────────────────────────────────────────────────────────

/** `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` 을 최신 날짜부터 훑는다. */
function* codexRolloutFiles(home: string): Generator<string> {
  const root = join(home, '.codex', 'sessions')
  // 연/월/일 디렉터리는 이름 자체가 시간순이라, 역순 정렬이 곧 최신순 순회다.
  const descend = (dir: string): string[] => {
    try {
      return readdirSync(dir)
        .sort((a, b) => b.localeCompare(a))
        .map((name) => join(dir, name))
    } catch {
      return []
    }
  }
  if (!existsSync(root)) return
  for (const year of descend(root)) {
    for (const month of descend(year)) {
      for (const day of descend(month)) {
        for (const file of descend(day)) {
          if (file.endsWith('.jsonl')) yield file
        }
      }
    }
  }
}

/**
 * Codex thread 를 cwd 로 되찾는다.
 *
 * Codex 는 대화를 날짜 디렉터리에 쌓고 cwd 는 파일 **첫 줄**(`session_meta`)에만 적는다.
 * `~/.codex/session_index.jsonl` 은 이름만 들고 있어 쓸 수 없다. 그래서 최신 날짜부터 첫 줄만
 * 읽어 내려가며 원하는 cwd 를 만나면 잡는다 — 최신순이라 처음 만난 것이 가장 최근 대화다.
 *
 * worktree 하나당 한 번씩 훑으면 같은 트리를 몇 번이고 다시 읽게 되므로, 스캔 한 번에 **원하는
 * 경로 전부를 한꺼번에** 넘겨 한 번만 훑는다. 파일 수 상한을 두어 오래 쓴 계정에서도 스캔이
 * 사용자를 기다리게 하지 않는다(못 찾으면 세션 없이 들여오면 된다).
 */
export function detectCodexSessions(
  worktreePaths: readonly string[],
  home: string
): Map<string, MigrationAgentSession> {
  const wanted = new Set(worktreePaths)
  const found = new Map<string, MigrationAgentSession>()
  if (wanted.size === 0) return found

  const names = codexThreadNames(home)
  let seen = 0
  for (const file of codexRolloutFiles(home)) {
    if (found.size === wanted.size || seen >= CODEX_SCAN_LIMIT) break
    seen++
    const head = readFirstJsonLine(file)
    if (!head || head.type !== 'session_meta') continue
    const payload = head.payload as Record<string, unknown> | undefined
    if (!payload) continue
    const cwd = text(payload.cwd)
    if (!wanted.has(cwd) || found.has(cwd)) continue
    const id = text(payload.id)
    if (!/^[A-Za-z0-9._-]+$/.test(id)) continue
    const timestamp = Date.parse(text(payload.timestamp) || text(head.timestamp))
    found.set(cwd, {
      backend: 'codex',
      sessionId: id,
      label: names.get(id) || 'Codex conversation',
      updatedAt: Number.isFinite(timestamp) ? timestamp : 0,
      sourcePath: file
    })
  }
  return found
}

/** thread id → 사람이 붙인 대화 이름. 없으면 빈 표. */
function codexThreadNames(home: string): Map<string, string> {
  const names = new Map<string, string>()
  try {
    const index = readFileSync(join(home, '.codex', 'session_index.jsonl'), 'utf-8')
    for (const line of index.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const entry = JSON.parse(trimmed) as Record<string, unknown>
        const id = text(entry.id)
        const name = text(entry.thread_name)
        if (id && name) names.set(id, shorten(name))
      } catch {
        continue
      }
    }
  } catch {
    // 색인이 없으면 이름 없이 둔다.
  }
  return names
}

// ── 합치기 ─────────────────────────────────────────────────────────────────

/**
 * worktree 경로별로 이어받을 수 있는 세션을 한 번에 찾는다.
 * 두 CLI 를 모두 쓴 디렉터리라면 **더 최근에 쓰인 쪽**을 고른다 — 사용자가 마지막으로 하던 일이다.
 */
export function detectAgentSessions(
  worktreePaths: readonly string[],
  home: string
): Map<string, MigrationAgentSession> {
  const codex = detectCodexSessions(worktreePaths, home)
  const out = new Map<string, MigrationAgentSession>()
  for (const path of worktreePaths) {
    const claude = detectClaudeSession(path, home)
    const other = codex.get(path) ?? null
    const winner =
      claude && other ? (claude.updatedAt >= other.updatedAt ? claude : other) : (claude ?? other)
    if (winner) out.set(path, winner)
  }
  return out
}
