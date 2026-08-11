import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WOOI_COMMANDS } from '@shared/wooiCommands'
import { resolveWooiPlugin, wooiPluginDir, writeWooiPlugin } from './plugin'

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'wooi-plugin-'))
}

describe('writeWooiPlugin', () => {
  it('writes a manifest whose name is the command prefix', () => {
    const dir = writeWooiPlugin(scratch())
    const manifest = JSON.parse(
      readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')
    ) as { name: string }
    // Claude Code 는 이 name 을 그대로 `/wooi:pr` 의 접두사로 쓴다. 바뀌면 명령이 통째로 바뀐다.
    expect(manifest.name).toBe('wooi')
  })

  it('writes one command file per catalog entry', () => {
    const dir = writeWooiPlugin(scratch())
    const files = readdirSync(join(dir, 'commands')).sort()
    expect(files).toEqual(WOOI_COMMANDS.map((c) => `${c.name}.md`).sort())
  })

  it('carries description and argument hint into the frontmatter', () => {
    const dir = writeWooiPlugin(scratch())
    const pr = WOOI_COMMANDS.find((c) => c.name === 'pr')!
    const body = readFileSync(join(dir, 'commands', 'pr.md'), 'utf8')
    expect(body.startsWith('---\n')).toBe(true)
    expect(body).toContain(`description: ${JSON.stringify(pr.description)}`)
    expect(body).toContain(`argument-hint: ${JSON.stringify(pr.argumentHint)}`)
    expect(body).toContain('$ARGUMENTS')
  })

  it('omits argument-hint for commands that take no arguments', () => {
    const dir = writeWooiPlugin(scratch())
    expect(readFileSync(join(dir, 'commands', 'children.md'), 'utf8')).not.toContain(
      'argument-hint'
    )
  })

  it('removes command files it no longer owns', () => {
    // 이름을 바꾸거나 지운 명령의 파일이 남으면 자동완성에는 계속 뜨는데 아무 데도 이어지지 않는다.
    const root = scratch()
    mkdirSync(join(root, 'commands'), { recursive: true })
    writeFileSync(join(root, 'commands', 'retired.md'), 'stale', 'utf8')
    writeWooiPlugin(root)
    expect(readdirSync(join(root, 'commands'))).not.toContain('retired.md')
  })

  it('is idempotent', () => {
    const root = scratch()
    writeWooiPlugin(root)
    const first = readFileSync(join(root, 'commands', 'pr.md'), 'utf8')
    writeWooiPlugin(root)
    expect(readFileSync(join(root, 'commands', 'pr.md'), 'utf8')).toBe(first)
  })
})

describe('resolveWooiPlugin', () => {
  it('returns nothing until the plugin has actually been written', () => {
    const root = scratch()
    const prev = process.env.WOOI_USER_DATA
    process.env.WOOI_USER_DATA = root
    try {
      expect(wooiPluginDir()).toBe(join(root, 'claude-plugin'))
      // 없는 경로를 세션 옵션에 넘기면 CLI 가 세션 자체를 못 연다 — 그래서 존재할 때만 돌려준다.
      expect(resolveWooiPlugin()).toBeNull()
      writeWooiPlugin(join(root, 'claude-plugin'))
      expect(resolveWooiPlugin()).toBe(join(root, 'claude-plugin'))
    } finally {
      if (prev === undefined) delete process.env.WOOI_USER_DATA
      else process.env.WOOI_USER_DATA = prev
    }
  })

  it('returns nothing when the user data path is unknown', () => {
    const prev = process.env.WOOI_USER_DATA
    delete process.env.WOOI_USER_DATA
    try {
      expect(wooiPluginDir()).toBeNull()
      expect(resolveWooiPlugin()).toBeNull()
    } finally {
      if (prev !== undefined) process.env.WOOI_USER_DATA = prev
    }
  })
})
