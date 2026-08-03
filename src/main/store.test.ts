import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@shared/types'

let userData = ''

vi.mock('electron', () => ({
  app: { getPath: (): string => userData }
}))

describe('Store.getState', () => {
  beforeAll(() => {
    userData = mkdtempSync(join(tmpdir(), 'wooi-store-test-'))
  })

  afterAll(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  it('backend별 rate-limit snapshot을 런타임 AppState에 포함한다', async () => {
    const { getStore } = await import('./store')
    const store = getStore()
    store.update((state) => {
      state.rateLimitsByAgent = {
        codex: {
          fetchedAt: 123,
          available: true,
          subscriptionType: null,
          windows: [{ label: 'Weekly', utilization: 36, resetsAt: null }]
        }
      }
    })

    expect(store.getState().rateLimitsByAgent?.codex).toEqual({
      fetchedAt: 123,
      available: true,
      subscriptionType: null,
      windows: [{ label: 'Weekly', utilization: 36, resetsAt: null }]
    })
  })
})

/**
 * 옛 버전 파일을 읽고 나면 **변환 결과를 현재 버전으로 기록**해야 한다. 읽은 버전을 그대로
 * 남기면 같은 마이그레이션이 매 부팅마다 이미 변환된 데이터 위에서 다시 돌아, 사용자가 고른
 * 값을 기본값으로 되돌린다(실제로 권한 모드가 계속 acceptEdits 로 돌아가던 버그).
 */
describe('Store 로드 시 schemaVersion 기록', () => {
  let dir = ''

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'wooi-store-version-'))
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  afterEach(() => {
    vi.resetModules()
  })

  const load = async (): Promise<{
    state: AppState
    persisted: Record<string, unknown>
  }> => {
    userData = dir
    vi.resetModules()
    const { getStore } = await import('./store')
    const store = getStore()
    // 로드 자체는 디스크를 건드리지 않는다 — 다음 변경 때 기록되는 값을 본다.
    store.update(() => {})
    return {
      state: store.getState(),
      persisted: JSON.parse(readFileSync(join(dir, 'wooi.json'), 'utf-8'))
    }
  }

  it('마이그레이션한 파일을 현재 버전으로 다시 쓰고, 재기동해도 설정이 유지된다', async () => {
    const { CURRENT_SCHEMA_VERSION } = await import('./storeSchema')
    writeFileSync(
      join(dir, 'wooi.json'),
      JSON.stringify({
        schemaVersion: 12,
        repos: [],
        workspaces: [],
        settings: {
          defaultPermissionMode: 'auto',
          model: 'claude-sonnet-5',
          effort: null,
          fastMode: false,
          theme: 'dark'
        }
      })
    )

    const first = await load()
    expect(first.state.settings.agents.claude.permissionMode).toBe('auto')
    expect(first.persisted.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)

    // 두 번째 기동 — v12 변환이 다시 돌지 않으므로 선택이 그대로 남는다.
    const second = await load()
    expect(second.state.settings.agents.claude.permissionMode).toBe('auto')
    expect(second.state.settings.agents.claude.model).toBe('claude-sonnet-5')
  })

  it('미래 버전 파일의 버전은 깎지 않는다', async () => {
    const { CURRENT_SCHEMA_VERSION } = await import('./storeSchema')
    const future = CURRENT_SCHEMA_VERSION + 5
    writeFileSync(
      join(dir, 'wooi.json'),
      JSON.stringify({ schemaVersion: future, repos: [], workspaces: [], settings: {} })
    )

    const { persisted } = await load()
    expect(persisted.schemaVersion).toBe(future)
  })
})
