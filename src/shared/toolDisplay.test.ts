import { describe, expect, it } from 'vitest'
import { FOLD, fold, toolDisplayName, toolUseSummary } from './toolDisplay'

describe('fold', () => {
  it.each([
    ['', '', 0],
    ['1\n2\n3', '1\n2\n3', 0],
    ['1\n2\n3\n4', '1\n2\n3\n4', 0],
    ['1\n2\n3\n4\n5', '1\n2\n3', 2]
  ])('folds %j with the one-hidden-line exception', (text, head, remaining) => {
    expect(fold(text)).toEqual({ head, remaining })
  })
})

describe('tool display policy', () => {
  it('limits Bash headers to two lines and 160 characters', () => {
    expect(toolUseSummary('Bash', { command: 'a\nb\nc' })).toBe('a\nb')
    expect(toolUseSummary('Bash', { command: 'x'.repeat(200) })).toHaveLength(FOLD.commandChars)
  })

  it('turns MCP names into a readable tool and server pair', () => {
    expect(toolDisplayName('mcp__github__create_pull_request')).toBe('create pull request (github)')
  })

  // 플러그인이 붙여 주는 서버 이름에는 밑줄이 들어간다. 구분자를 최소로 먹지 않으면 여기서 갈린다.
  it('splits MCP names whose server contains underscores', () => {
    expect(toolDisplayName('mcp__plugin_firebase_firebase__firebase_deploy')).toBe(
      'firebase deploy (plugin_firebase_firebase)'
    )
  })

  // CLI 는 스킬도 평범한 도구 한 줄로 그린다 — `Skill(wiki-ingest:wiki-ingest)`.
  // 이름은 userFacingName 이 그대로 "Skill", 괄호 안은 renderToolUseMessage 가 고른 스킬 이름이다.
  it('renders a skill call the way the CLI does', () => {
    expect(toolDisplayName('Skill')).toBe('Skill')
    expect(toolUseSummary('Skill', { skill: 'wiki-ingest:wiki-ingest' })).toBe(
      'wiki-ingest:wiki-ingest'
    )
  })

  it('leaves names it does not recognise alone', () => {
    expect(toolDisplayName('Bash')).toBe('Bash')
    expect(toolDisplayName('Glob')).toBe('Search')
  })
})

describe('fold with a custom limit', () => {
  it('gives failures more room before folding', () => {
    const text = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n')
    expect(fold(text, FOLD.error)).toEqual({
      head: text.split('\n').slice(0, FOLD.error).join('\n'),
      remaining: 2
    })
  })
})
