import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

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
