import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { MemoryScope } from '@shared/types'

/**
 * `#` 로 시작하는 입력을 CLAUDE.md 에 한 줄로 덧붙인다 — 터미널 Claude Code 의 `#` 단축키와 같다.
 *
 * "다음부터는 이렇게 해" 를 남기는 가장 빠른 길이라, 대화를 끊고 에디터를 열게 하면 안 된다.
 * 두 곳 중 하나를 고를 수 있다:
 *   project — worktree 의 CLAUDE.md (git 에 남아 팀과 공유된다)
 *   user    — ~/.claude/CLAUDE.md (모든 프로젝트에 적용되는 개인 규칙)
 */
export function memoryFile(scope: MemoryScope, worktreePath: string): string {
  if (scope === 'user') {
    // CLI 와 같은 규칙: CLAUDE_CONFIG_DIR 이 ~/.claude 를 통째로 대체한다.
    const dir = process.env.CLAUDE_CONFIG_DIR?.trim()
    return join(dir || join(homedir(), '.claude'), 'CLAUDE.md')
  }
  return join(worktreePath, 'CLAUDE.md')
}

/** 기억 한 줄을 덧붙인다. 성공하면 쓴 파일 경로를, 실패하면 error 를 돌려준다. */
export function appendMemory(
  scope: MemoryScope,
  worktreePath: string,
  text: string
): { path?: string; error?: string } {
  // 여러 줄을 적었어도 한 항목으로 남긴다 — 줄바꿈을 그대로 쓰면 둘째 줄부터 목록 밖으로 샌다.
  const line = text.trim().replace(/\s*\n+\s*/g, ' ')
  if (!line) return { error: 'Nothing to remember.' }

  const file = memoryFile(scope, worktreePath)
  try {
    mkdirSync(dirname(file), { recursive: true })
    // 기존 내용이 줄바꿈으로 끝나지 않으면 우리 항목이 마지막 줄에 달라붙는다.
    let prefix = ''
    try {
      const current = readFileSync(file, 'utf-8')
      if (current && !current.endsWith('\n')) prefix = '\n'
    } catch {
      // 파일이 아직 없다 — 그대로 새로 만든다.
    }
    appendFileSync(file, `${prefix}- ${line}\n`)
    return { path: file }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}
