import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasUserAutoCompactWindow } from './userSettings'

/**
 * 이 헬퍼는 "사용자가 직접 정한 설정을 덮어쓰지 않는다" 를 보장하는 게이트다. 잘못되면 조용히
 * 과금 동작이 달라지므로(자동 압축 시점) 파일 조합별로 확인한다.
 *
 * user 스코프는 CLAUDE_CONFIG_DIR 로 임시 디렉토리에 격리한다 — 그러지 않으면 테스트를 돌리는
 * 사람의 실제 ~/.claude/settings.json 값에 따라 결과가 갈린다(그 파일에 autoCompactWindow 가
 * 있으면 "없음" 케이스가 전부 실패한다).
 */
describe('hasUserAutoCompactWindow', () => {
  let dir: string
  let configDir: string
  let prevConfigDir: string | undefined

  const writeSettings = (root: string, name: string, body: string): void => {
    mkdirSync(join(root, '.claude'), { recursive: true })
    writeFileSync(join(root, '.claude', name), body)
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wooi-usersettings-'))
    configDir = mkdtempSync(join(tmpdir(), 'wooi-usersettings-home-'))
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = configDir
  })
  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir
    rmSync(dir, { recursive: true, force: true })
    rmSync(configDir, { recursive: true, force: true })
  })

  it('user 스코프(CLAUDE_CONFIG_DIR)에 값이 있으면 지정된 것으로 본다', () => {
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ autoCompactWindow: 250000 }))
    expect(hasUserAutoCompactWindow(dir, null)).toBe(true)
  })

  it('설정 파일이 없으면 지정하지 않은 것으로 본다', () => {
    expect(hasUserAutoCompactWindow(dir, null)).toBe(false)
  })

  it('project 스코프에 값이 있으면 지정된 것으로 본다', () => {
    writeSettings(dir, 'settings.json', JSON.stringify({ autoCompactWindow: 400000 }))
    expect(hasUserAutoCompactWindow(dir, null)).toBe(true)
  })

  it('local 오버라이드만 있어도 지정된 것으로 본다', () => {
    writeSettings(dir, 'settings.local.json', JSON.stringify({ autoCompactWindow: 150000 }))
    expect(hasUserAutoCompactWindow(dir, null)).toBe(true)
  })

  it('다른 키만 있으면 지정하지 않은 것으로 본다', () => {
    writeSettings(dir, 'settings.json', JSON.stringify({ autoCompactEnabled: true }))
    expect(hasUserAutoCompactWindow(dir, null)).toBe(false)
  })

  it('숫자가 아닌 값은 무시한다', () => {
    writeSettings(dir, 'settings.json', JSON.stringify({ autoCompactWindow: '200000' }))
    expect(hasUserAutoCompactWindow(dir, null)).toBe(false)
  })

  it('JSON 이 깨져 있으면 주입을 막지 않는다', () => {
    writeSettings(dir, 'settings.json', '{ not json')
    expect(hasUserAutoCompactWindow(dir, null)).toBe(false)
  })

  it('worktree 에 없고 원본 repo 에만 있어도 찾는다(gitignore 된 settings.local.json)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'wooi-usersettings-repo-'))
    try {
      writeSettings(repo, 'settings.local.json', JSON.stringify({ autoCompactWindow: 300000 }))
      expect(hasUserAutoCompactWindow(dir, repo)).toBe(true)
      // repoPath 를 안 넘기면 worktree 만 보므로 못 찾는다.
      expect(hasUserAutoCompactWindow(dir, null)).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
