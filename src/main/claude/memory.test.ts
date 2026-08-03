import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendMemory, memoryFile } from './memory'

function tmpWorktree(): string {
  return mkdtempSync(join(tmpdir(), 'wooi-memory-'))
}

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
})

describe('memoryFile', () => {
  it('project 기억은 worktree 의 CLAUDE.md 다', () => {
    expect(memoryFile('project', '/repo/wt')).toBe('/repo/wt/CLAUDE.md')
  })

  it('user 기억은 CLAUDE_CONFIG_DIR 을 따른다', () => {
    process.env.CLAUDE_CONFIG_DIR = '/custom/config'
    expect(memoryFile('user', '/repo/wt')).toBe('/custom/config/CLAUDE.md')
  })
})

describe('appendMemory', () => {
  it('파일이 없으면 새로 만들어 항목을 남긴다', () => {
    const wt = tmpWorktree()
    const { path, error } = appendMemory('project', wt, '  always run typecheck  ')
    expect(error).toBeUndefined()
    expect(readFileSync(path!, 'utf-8')).toBe('- always run typecheck\n')
  })

  it('줄바꿈으로 끝나지 않는 파일에도 항목이 달라붙지 않는다', () => {
    const wt = tmpWorktree()
    writeFileSync(join(wt, 'CLAUDE.md'), '# CLAUDE.md')
    appendMemory('project', wt, 'second')
    expect(readFileSync(join(wt, 'CLAUDE.md'), 'utf-8')).toBe('# CLAUDE.md\n- second\n')
  })

  it('여러 줄 입력도 한 항목으로 접는다', () => {
    const wt = tmpWorktree()
    const { path } = appendMemory('project', wt, 'first line\n\n  second line')
    expect(readFileSync(path!, 'utf-8')).toBe('- first line second line\n')
  })

  it('빈 내용은 쓰지 않고 에러로 돌려준다', () => {
    const wt = tmpWorktree()
    expect(appendMemory('project', wt, '   ').error).toBe('Nothing to remember.')
  })

  it('쓸 수 없는 경로는 던지지 않고 에러를 돌려준다', () => {
    expect(appendMemory('project', '/dev/null/nope', 'x').error).toBeTruthy()
  })
})
