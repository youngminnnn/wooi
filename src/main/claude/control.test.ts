import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Query } from '@anthropic-ai/claude-agent-sdk'
import {
  LIVE_ONLY_COMMANDS,
  collectPermissions,
  noLiveSessionError,
  permissionSettingsFiles,
  readMcpServersSettled,
  runCommandOn
} from './control'

/**
 * 단명 제어 쿼리가 조용히 부정확한 카드 값을 만들지 않도록 경계를 고정한다.
 * 라이브 세션 여부가 usage 결과에 남는지, MCP 가 정착할 때까지만 기다리는지, 파일로 확인 가능한
 * 권한 규칙과 출처를 빠짐없이 합치는지를 실제 SDK 없이 작은 가짜 Query 와 임시 파일로 검증한다.
 */

function usageQuery(): Query {
  return {
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
      session: {
        total_cost_usd: 1.25,
        total_api_duration_ms: 10,
        total_duration_ms: 20,
        total_lines_added: 3,
        total_lines_removed: 2,
        model_usage: {}
      },
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 42, resets_at: '2026-08-23T12:00:00Z' }
      }
    })
  } as unknown as Query
}

function server(name: string, status: 'pending' | 'connected') {
  return { name, status, scope: 'user' }
}

describe('라이브 세션 전용 명령', () => {
  it('context 만 라이브 세션 전용으로 분류한다', () => {
    expect(LIVE_ONLY_COMMANDS).toContain('context')
    expect(LIVE_ONLY_COMMANDS).not.toContain('usage')
    expect(LIVE_ONLY_COMMANDS).not.toContain('mcp')
  })

  it('세션 없음 오류에 명령과 다음 행동을 담는다', () => {
    const message = noLiveSessionError('context').message
    expect(message).toContain('/context')
    expect(message).toContain('Send a message')
  })
})

describe('runCommandOn usage', () => {
  it('기본 경로는 세션 값이 라이브 데이터임을 표시하고 레이트리밋 창을 매핑한다', async () => {
    const result = await runCommandOn('usage', usageQuery())
    expect(result.kind).toBe('usage')
    if (result.kind !== 'usage') throw new Error('usage 결과가 아니다')
    expect(result.usage.sessionDataAvailable).toBe(true)
    expect(result.usage.rateLimits[0]).toMatchObject({ label: '5-hour', utilization: 42 })
  })

  it('단명 경로는 세션 값을 사용할 수 없다고 표시한다', async () => {
    const result = await runCommandOn('usage', usageQuery(), { live: false })
    if (result.kind !== 'usage') throw new Error('usage 결과가 아니다')
    expect(result.usage.sessionDataAvailable).toBe(false)
  })
})

describe('readMcpServersSettled', () => {
  it('빈 목록과 pending 을 지나 연결이 정착한 마지막 목록을 돌려준다', async () => {
    const responses = [
      [],
      [server('one', 'pending')],
      [server('one', 'connected'), server('two', 'connected')]
    ]
    let calls = 0
    let clock = 0
    const q = { mcpServerStatus: async () => responses[calls++] }
    const result = await readMcpServersSettled(q as Pick<Query, 'mcpServerStatus'>, {
      timeoutMs: 1000,
      intervalMs: 100,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      }
    })
    expect(result.map((s) => [s.name, s.status])).toEqual([
      ['one', 'connected'],
      ['two', 'connected']
    ])
    expect(calls).toBe(3)
  })

  it('pending 이 계속되면 상한에서 멈추고 마지막 목록을 돌려준다', async () => {
    let calls = 0
    let clock = 0
    const q = {
      mcpServerStatus: async () => {
        calls += 1
        return [server('slow', 'pending')]
      }
    }
    const result = await readMcpServersSettled(q as Pick<Query, 'mcpServerStatus'>, {
      timeoutMs: 300,
      intervalMs: 100,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      }
    })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ name: 'slow', status: 'pending' })
    expect(calls).toBe(4)
  })

  it('처음부터 연결돼 있으면 다시 조회하지 않는다', async () => {
    let calls = 0
    const q = {
      mcpServerStatus: async () => {
        calls += 1
        return [server('ready', 'connected')]
      }
    }
    const result = await readMcpServersSettled(q as Pick<Query, 'mcpServerStatus'>)
    expect(result).toHaveLength(1)
    expect(calls).toBe(1)
  })
})

describe('permissionSettingsFiles', () => {
  it('macOS 관리형 정책을 가장 낮은 우선순위로 둔다', () => {
    const files = permissionSettingsFiles('/repo', '/home/test', 'darwin')
    expect(files[0]).toBe('/Library/Application Support/ClaudeCode/managed-settings.json')
    expect(files.at(-1)).toBe('/repo/.claude/settings.local.json')
  })

  it('Linux 관리형 정책과 주입한 home 경로를 사용한다', () => {
    const files = permissionSettingsFiles('/repo', '/home/test', 'linux')
    expect(files[0]).toBe('/etc/claude-code/managed-settings.json')
    expect(files).toContain('/home/test/.claude/settings.local.json')
  })
})

describe('collectPermissions', () => {
  it('유효한 권한 파일만 출처에 넣고 규칙을 합쳐 중복을 제거한다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wooi-permissions-'))
    const first = join(dir, 'first.json')
    const second = join(dir, 'second.json')
    const broken = join(dir, 'broken.json')
    const noPermissions = join(dir, 'other.json')
    const missing = join(dir, 'missing.json')
    writeFileSync(first, JSON.stringify({ permissions: { allow: ['Read', 'Bash'], ask: ['Web'] } }))
    writeFileSync(
      second,
      JSON.stringify({ permissions: { allow: ['Read'], ask: ['Edit'], deny: ['Delete'] } })
    )
    writeFileSync(broken, '{ broken')
    writeFileSync(noPermissions, JSON.stringify({ theme: 'dark' }))

    const result = collectPermissions([missing, first, broken, noPermissions, second], 'default')
    if (result.kind !== 'permissions') throw new Error('permissions 결과가 아니다')
    expect(result.permissions.sources).toEqual([first, second])
    expect(result.permissions.allow).toEqual(['Read', 'Bash'])
    expect(result.permissions.ask).toEqual(['Web', 'Edit'])
    expect(result.permissions.deny).toEqual(['Delete'])
    expect(result.permissions.mode).toBe('default')
  })
})
