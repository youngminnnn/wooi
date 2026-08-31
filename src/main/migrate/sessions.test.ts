import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectAgentSessions, detectClaudeSession, detectCodexSessions } from './sessions'

let home: string

function writeClaude(cwd: string, id: string, lines: unknown[], mtime?: number): void {
  const dir = join(home, '.claude', 'projects', cwd.replace(/\//g, '-'))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${id}.jsonl`)
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
  if (mtime !== undefined) utimesSync(file, mtime / 1000, mtime / 1000)
}

function writeCodex(date: string, id: string, cwd: string, timestamp: string): void {
  const [year, month, day] = date.split('-')
  const dir = join(home, '.codex', 'sessions', year, month, day)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `rollout-${timestamp.replace(/[:.]/g, '-')}-${id}.jsonl`),
    `${JSON.stringify({ timestamp, type: 'session_meta', payload: { id, cwd, timestamp } })}\n` +
      `${JSON.stringify({ type: 'response_item' })}\n`
  )
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wooi-sessions-test-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('detectClaudeSession', () => {
  it('cwd 슬러그 디렉터리에서 가장 최근 세션을 고른다', () => {
    writeClaude('/work/a', 'old', [{ type: 'custom-title', customTitle: 'Old talk' }], 1_000_000)
    writeClaude('/work/a', 'new', [{ type: 'custom-title', customTitle: 'New talk' }], 2_000_000)

    expect(detectClaudeSession('/work/a', home)).toMatchObject({
      backend: 'claude',
      sessionId: 'new',
      label: 'New talk'
    })
  })

  it('제목이 없으면 첫 사용자 메시지로 이름을 붙인다', () => {
    writeClaude('/work/a', 's1', [
      { type: 'assistant', message: { content: [] } },
      { type: 'user', message: { content: [{ type: 'text', text: '  파서를 고쳐 줘  ' }] } }
    ])
    expect(detectClaudeSession('/work/a', home)?.label).toBe('파서를 고쳐 줘')
  })

  it('세션이 없는 디렉터리는 null 이다', () => {
    expect(detectClaudeSession('/work/none', home)).toBeNull()
  })

  it('내용이 깨져 있어도 세션 자체는 살린다', () => {
    writeClaude('/work/a', 's1', [])
    writeFileSync(join(home, '.claude', 'projects', '-work-a', 's1.jsonl'), 'not json\n')
    expect(detectClaudeSession('/work/a', home)).toMatchObject({ sessionId: 's1' })
  })
})

describe('detectCodexSessions', () => {
  it('rollout 첫 줄의 cwd 로 thread 를 되찾는다', () => {
    writeCodex('2026-08-01', 'thread-a', '/work/a', '2026-08-01T10:00:00.000Z')
    writeCodex('2026-08-01', 'thread-b', '/work/b', '2026-08-01T11:00:00.000Z')

    const found = detectCodexSessions(['/work/a', '/work/b'], home)
    expect(found.get('/work/a')).toMatchObject({ backend: 'codex', sessionId: 'thread-a' })
    expect(found.get('/work/b')?.sessionId).toBe('thread-b')
  })

  it('같은 cwd 에 여러 개면 최신 날짜의 것을 고른다', () => {
    writeCodex('2026-07-01', 'older', '/work/a', '2026-07-01T10:00:00.000Z')
    writeCodex('2026-08-02', 'newer', '/work/a', '2026-08-02T10:00:00.000Z')

    expect(detectCodexSessions(['/work/a'], home).get('/work/a')?.sessionId).toBe('newer')
  })

  it('색인이 있으면 대화 이름을 붙인다', () => {
    writeCodex('2026-08-01', 'thread-a', '/work/a', '2026-08-01T10:00:00.000Z')
    writeFileSync(
      join(home, '.codex', 'session_index.jsonl'),
      `${JSON.stringify({ id: 'thread-a', thread_name: 'Ship the importer' })}\n`
    )
    expect(detectCodexSessions(['/work/a'], home).get('/work/a')?.label).toBe('Ship the importer')
  })

  it('찾는 경로가 없거나 세션 디렉터리가 없으면 빈 표다', () => {
    expect(detectCodexSessions([], home).size).toBe(0)
    expect(detectCodexSessions(['/work/a'], home).size).toBe(0)
  })
})

describe('detectAgentSessions', () => {
  it('두 CLI 를 다 쓴 디렉터리면 더 최근에 쓴 쪽을 고른다', () => {
    const codexAt = Date.parse('2026-08-02T10:00:00.000Z')
    writeCodex('2026-08-02', 'thread-a', '/work/a', '2026-08-02T10:00:00.000Z')
    writeClaude('/work/a', 'claude-old', [{ type: 'custom-title', customTitle: 'x' }], codexAt - 1)
    expect(detectAgentSessions(['/work/a'], home).get('/work/a')?.backend).toBe('codex')

    writeClaude('/work/a', 'claude-new', [{ type: 'custom-title', customTitle: 'y' }], codexAt + 1)
    expect(detectAgentSessions(['/work/a'], home).get('/work/a')?.backend).toBe('claude')
  })

  it('아무것도 없으면 그 경로는 표에 없다', () => {
    expect(detectAgentSessions(['/work/none'], home).has('/work/none')).toBe(false)
  })
})
