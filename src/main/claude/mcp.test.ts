import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpSettings, WooiMcpServer } from '@shared/types'

/**
 * MCP 주입 목록이 합쳐지는 규칙을 고정한다.
 *
 * 이 병합은 **조용히 틀리는** 종류의 코드다 — 우선순위가 뒤집히거나 비활성 항목이 새어 들어가도
 * 예외 하나 없이 세션이 뜨고, 사용자는 "어제까진 되던 도구가 없다" 로만 알아챈다.
 *
 * Wooi 스코프 설정은 인자로 들어오므로(호스트에는 store 가 없다) 갈아 끼울 것이 없다.
 * ~/.claude.json 만 임시 디렉터리에 실제 파일로 둔다.
 */

import { mcpInventory, resolveUserMcpServers } from './mcp'

let settings: McpSettings = { servers: [], disabledInherited: [] }

const REPO = '/repos/acme'

function writeConfig(json: unknown): void {
  const dir = mkdtempSync(join(tmpdir(), 'wooi-mcp-'))
  writeFileSync(join(dir, '.claude.json'), JSON.stringify(json))
  process.env.CLAUDE_CONFIG_DIR = dir
}

function stdio(name: string, command: string, enabled = true): WooiMcpServer {
  return { id: name, name, enabled, transport: 'stdio', command, args: [], env: {} }
}

beforeEach(() => {
  settings = { servers: [], disabledInherited: [] }
  delete process.env.CLAUDE_CONFIG_DIR
})

describe('resolveUserMcpServers', () => {
  it('user 스코프와 해당 repo 의 project 스코프를 합치고, project 가 이긴다', () => {
    writeConfig({
      mcpServers: { shared: { command: 'user' }, onlyUser: { command: 'u' } },
      projects: { [REPO]: { mcpServers: { shared: { command: 'project' } } } }
    })
    const merged = resolveUserMcpServers(REPO, settings)
    expect(merged.shared).toEqual({ command: 'project' })
    expect(merged.onlyUser).toEqual({ command: 'u' })
  })

  it('다른 repo 의 project 스코프는 새어 들어오지 않는다', () => {
    writeConfig({ projects: { '/repos/other': { mcpServers: { leak: { command: 'x' } } } } })
    expect(resolveUserMcpServers(REPO, settings)).toEqual({})
  })

  it('Wooi 스코프 서버를 더하되, 켜진 것만 넣는다', () => {
    writeConfig({})
    settings = { servers: [stdio('on', 'a'), stdio('off', 'b', false)], disabledInherited: [] }
    const merged = resolveUserMcpServers(REPO, settings)
    expect(Object.keys(merged)).toEqual(['on'])
    expect(merged.on).toEqual({ type: 'stdio', command: 'a', args: [], env: {} })
  })

  it('이름이 겹치면 ~/.claude.json 이 Wooi 스코프를 이긴다', () => {
    writeConfig({ mcpServers: { linear: { command: 'from-config' } } })
    settings = { servers: [stdio('linear', 'from-wooi')], disabledInherited: [] }
    expect(resolveUserMcpServers(REPO, settings).linear).toEqual({ command: 'from-config' })
  })

  it('승계 항목을 끄면 그 이름을 같은 이름의 Wooi 서버가 대신 가져간다', () => {
    writeConfig({ mcpServers: { linear: { command: 'from-config' } } })
    settings = { servers: [stdio('linear', 'from-wooi')], disabledInherited: ['linear'] }
    expect(resolveUserMcpServers(REPO, settings).linear).toEqual({
      type: 'stdio',
      command: 'from-wooi',
      args: [],
      env: {}
    })
  })

  it('끈 승계 항목은 대체할 서버가 없으면 그냥 빠진다', () => {
    writeConfig({ mcpServers: { linear: { command: 'x' }, kept: { command: 'y' } } })
    settings = { servers: [], disabledInherited: ['linear'] }
    expect(Object.keys(resolveUserMcpServers(REPO, settings))).toEqual(['kept'])
  })

  it('이름 규칙에 맞지 않는 Wooi 항목은 주입하지 않는다(손으로 고친 설정 파일 대비)', () => {
    writeConfig({})
    settings = { servers: [stdio('bad name', 'a'), stdio('', 'b')], disabledInherited: [] }
    expect(resolveUserMcpServers(REPO, settings)).toEqual({})
  })

  it('원격 서버는 transport 를 그대로 실어 보낸다', () => {
    writeConfig({})
    settings = {
      servers: [
        {
          id: '1',
          name: 'remote',
          enabled: true,
          transport: 'sse',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer t' }
        }
      ],
      disabledInherited: []
    }
    expect(resolveUserMcpServers(null, settings).remote).toEqual({
      type: 'sse',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer t' }
    })
  })

  it('설정 파일이 없거나 깨져도 빈 목록으로 떨어진다(세션 생성을 막지 않는다)', () => {
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'wooi-mcp-none-'))
    expect(resolveUserMcpServers(REPO, settings)).toEqual({})

    const dir = mkdtempSync(join(tmpdir(), 'wooi-mcp-broken-'))
    writeFileSync(join(dir, '.claude.json'), '{ not json')
    process.env.CLAUDE_CONFIG_DIR = dir
    expect(resolveUserMcpServers(REPO, settings)).toEqual({})
  })
})

describe('mcpInventory', () => {
  it('전송 방식을 판별하고 등록된 repo 의 project 항목만 싣는다', () => {
    writeConfig({
      mcpServers: {
        local: { command: 'npx', args: ['-y', 'pkg'] },
        remote: { type: 'http', url: 'https://example.com/mcp' }
      },
      projects: {
        [REPO]: { mcpServers: { repoScoped: { command: 'run' } } },
        '/repos/unknown': { mcpServers: { hidden: { command: 'run' } } }
      }
    })
    const inventory = mcpInventory([REPO])
    expect(inventory.configExists).toBe(true)
    expect(inventory.inherited).toEqual([
      { name: 'local', origin: 'user', transport: 'stdio', detail: 'npx -y pkg' },
      { name: 'remote', origin: 'user', transport: 'http', detail: 'https://example.com/mcp' },
      {
        name: 'repoScoped',
        origin: 'project',
        projectPath: REPO,
        transport: 'stdio',
        detail: 'run'
      }
    ])
  })

  it('설정 파일이 없으면 configExists 가 false 다', () => {
    process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'wooi-mcp-none-'))
    const inventory = mcpInventory([REPO])
    expect(inventory.configExists).toBe(false)
    expect(inventory.inherited).toEqual([])
  })
})
