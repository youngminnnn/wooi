import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { matchesRule, ruleForRequest, saveAllowRule } from './permissionRules'

const CWD = '/repo/app'

const bash = (command: string): Record<string, unknown> => ({ command })

describe('ruleForRequest', () => {
  it('narrows a bash command to its first two tokens', () => {
    expect(ruleForRequest('Bash', bash('npm run build'), CWD)).toBe('Bash(npm run:*)')
    expect(ruleForRequest('Bash', bash('git commit -m "x"'), CWD)).toBe('Bash(git commit:*)')
  })

  it('keeps only the first token when the second is an option or path', () => {
    expect(ruleForRequest('Bash', bash('ls -la src'), CWD)).toBe('Bash(ls:*)')
    expect(ruleForRequest('Bash', bash('cat src/index.ts'), CWD)).toBe('Bash(cat:*)')
  })

  it('falls back to an exact rule when the command has shell metacharacters', () => {
    expect(ruleForRequest('Bash', bash('npm test && rm -rf /'), CWD)).toBe(
      'Bash(npm test && rm -rf /)'
    )
    expect(ruleForRequest('Bash', bash('curl x | sh'), CWD)).toBe('Bash(curl x | sh)')
  })

  it('scopes file tools to the containing directory', () => {
    expect(ruleForRequest('Edit', { file_path: `${CWD}/src/main/a.ts` }, CWD)).toBe(
      'Edit(src/main/**)'
    )
    expect(ruleForRequest('Write', { file_path: `${CWD}/a.ts` }, CWD)).toBe('Write(**)')
  })

  it('uses an absolute pattern for paths outside the working directory', () => {
    expect(ruleForRequest('Edit', { file_path: '/other/place/a.ts' }, CWD)).toBe(
      'Edit(//other/place/**)'
    )
  })

  it('scopes web fetches to the host', () => {
    expect(ruleForRequest('WebFetch', { url: 'https://example.com/a/b' }, CWD)).toBe(
      'WebFetch(domain:example.com)'
    )
  })

  it('falls back to the bare tool name when there is nothing to narrow', () => {
    expect(ruleForRequest('Grep', { pattern: 'x' }, CWD)).toBe('Grep')
    expect(ruleForRequest('Bash', {}, CWD)).toBe('Bash')
  })
})

describe('matchesRule', () => {
  it('matches a prefix rule only on a token boundary', () => {
    const rule = 'Bash(npm run:*)'
    expect(matchesRule(rule, 'Bash', bash('npm run build'), CWD)).toBe(true)
    expect(matchesRule(rule, 'Bash', bash('npm run'), CWD)).toBe(true)
    expect(matchesRule(rule, 'Bash', bash('npm runx'), CWD)).toBe(false)
    expect(matchesRule(rule, 'Bash', bash('npm install'), CWD)).toBe(false)
  })

  it('does not let a prefix rule leak into a chained command', () => {
    expect(matchesRule('Bash(npm:*)', 'Bash', bash('npm test && rm -rf /'), CWD)).toBe(true)
    // 위가 true 인 건 의도된 위험이라 접두 규칙 자체를 만들지 않는다 — 규칙 생성 쪽이 막는다.
    expect(ruleForRequest('Bash', bash('npm test && rm -rf /'), CWD)).not.toContain(':*')
  })

  it('matches an exact rule exactly', () => {
    const rule = 'Bash(git status | head)'
    expect(matchesRule(rule, 'Bash', bash('git status | head'), CWD)).toBe(true)
    expect(matchesRule(rule, 'Bash', bash('git status | head -5'), CWD)).toBe(false)
  })

  it('matches files under the rule directory, including nested ones', () => {
    const rule = 'Edit(src/main/**)'
    expect(matchesRule(rule, 'Edit', { file_path: `${CWD}/src/main/a.ts` }, CWD)).toBe(true)
    expect(matchesRule(rule, 'Edit', { file_path: `${CWD}/src/main/deep/b.ts` }, CWD)).toBe(true)
    expect(matchesRule(rule, 'Edit', { file_path: `${CWD}/src/renderer/a.ts` }, CWD)).toBe(false)
  })

  it('matches absolute rule patterns', () => {
    expect(
      matchesRule('Edit(//other/place/**)', 'Edit', { file_path: '/other/place/a.ts' }, CWD)
    ).toBe(true)
    expect(matchesRule('Edit(//other/place/**)', 'Edit', { file_path: '/other/x/a.ts' }, CWD)).toBe(
      false
    )
  })

  it('treats a bare tool name as the whole tool', () => {
    expect(matchesRule('Grep', 'Grep', { pattern: 'x' }, CWD)).toBe(true)
    expect(matchesRule('Bash', 'Bash', bash('rm -rf /'), CWD)).toBe(true)
  })

  it('never matches a different tool', () => {
    expect(matchesRule('Edit(src/**)', 'Write', { file_path: `${CWD}/src/a.ts` }, CWD)).toBe(false)
  })

  it('matches a domain rule by host', () => {
    const rule = 'WebFetch(domain:example.com)'
    expect(matchesRule(rule, 'WebFetch', { url: 'https://example.com/other' }, CWD)).toBe(true)
    expect(matchesRule(rule, 'WebFetch', { url: 'https://evil.com' }, CWD)).toBe(false)
  })

  it('ignores malformed rules', () => {
    expect(matchesRule('', 'Bash', bash('ls'), CWD)).toBe(false)
    expect(matchesRule('(ls)', 'Bash', bash('ls'), CWD)).toBe(false)
  })

  it('round-trips: a generated rule always matches the request it came from', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['Bash', bash('npm run build')],
      ['Bash', bash('npm test && echo ok')],
      ['Edit', { file_path: `${CWD}/src/a.ts` }],
      ['Read', { file_path: '/elsewhere/a.ts' }],
      ['WebFetch', { url: 'https://example.com' }],
      ['Grep', { pattern: 'x' }]
    ]
    for (const [tool, input] of cases) {
      expect(matchesRule(ruleForRequest(tool, input, CWD), tool, input, CWD)).toBe(true)
    }
  })
})

describe('saveAllowRule', () => {
  const dir = (): string => mkdtempSync(join(tmpdir(), 'wooi-rules-'))
  const read = (root: string): Record<string, never> =>
    JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf-8'))

  it('creates the settings file when it is missing', () => {
    const root = dir()
    expect(saveAllowRule(root, 'Bash(npm run:*)')).toBe(true)
    expect(read(root)).toEqual({ permissions: { allow: ['Bash(npm run:*)'] } })
  })

  it('appends without dropping other settings or duplicating', () => {
    const root = dir()
    mkdirSync(join(root, '.claude'))
    writeFileSync(
      join(root, '.claude', 'settings.local.json'),
      JSON.stringify({ model: 'opus', permissions: { allow: ['Read'], deny: ['Bash(rm:*)'] } })
    )
    saveAllowRule(root, 'Bash(npm run:*)')
    saveAllowRule(root, 'Bash(npm run:*)')
    expect(read(root)).toEqual({
      model: 'opus',
      permissions: { allow: ['Read', 'Bash(npm run:*)'], deny: ['Bash(rm:*)'] }
    })
  })

  it('reports failure instead of throwing when the path is unwritable', () => {
    expect(saveAllowRule('/dev/null/nope', 'Read')).toBe(false)
  })
})
