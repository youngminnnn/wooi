import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@shared/types'

let userData = ''

vi.mock('electron', () => ({
  app: { getPath: (): string => userData }
}))

// 스토어는 모듈 싱글턴이라 파일 전체가 같은 userData 를 공유해야 한다 — describe 마다 새로
// 만들면 뒤 블록이 앞 블록의 디렉터리(이미 지워진)를 계속 가리킨다.
beforeAll(() => {
  userData = mkdtempSync(join(tmpdir(), 'wooi-store-test-'))
})

afterAll(() => {
  rmSync(userData, { recursive: true, force: true })
})

describe('Store.getState', () => {
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
 * 디스크 쓰기는 성능을 위해 모아서 한다(update 마다 하면 한 번에 ~10ms 씩 메인이 막힌다).
 * 그래서 두 가지가 반드시 성립해야 한다 — 읽기는 언제나 최신이어야 하고, flush 한 뒤에는
 * 반드시 디스크에 남아 있어야 한다. 하나라도 깨지면 사용자는 방금 한 작업을 잃는다.
 */
describe('Store 쓰기 병합', () => {
  it('update 직후에도 getState 는 최신 값을 돌려준다', async () => {
    const { getStore } = await import('./store')
    const store = getStore()
    store.update((s) => {
      s.settings.theme = 'light'
    })
    expect(store.getState().settings.theme).toBe('light')
  })

  it('flush 하면 디스크에 반영된다', async () => {
    const { getStore, flushStore } = await import('./store')
    const store = getStore()
    store.update((s) => {
      s.settings.theme = 'dark'
    })
    flushStore()

    const file = join(userData, 'wooi.json')
    expect(existsSync(file)).toBe(true)
    const onDisk = JSON.parse(readFileSync(file, 'utf-8')) as {
      settings: { theme: string }
    }
    expect(onDisk.settings.theme).toBe('dark')
  })

  it('밀린 변경이 없으면 flush 는 아무것도 하지 않는다', async () => {
    const { getStore, flushStore } = await import('./store')
    getStore()
    flushStore()
    const before = readFileSync(join(userData, 'wooi.json'), 'utf-8')
    flushStore()
    expect(readFileSync(join(userData, 'wooi.json'), 'utf-8')).toBe(before)
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
    const { getStore, flushStore } = await import('./store')
    const store = getStore()
    // 로드 자체는 디스크를 건드리지 않는다 — 다음 변경 때 기록되는 값을 본다.
    // 쓰기는 디바운스되므로(성능), 파일을 읽어 보려면 여기서 밀린 것을 내려야 한다.
    store.update(() => {})
    flushStore()
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
