import { describe, expect, it, vi } from 'vitest'

const warn = vi.fn()

vi.mock('electron', () => ({ app: undefined }))
vi.mock('./logger', () => ({ log: { error: vi.fn(), warn } }))

describe('wooiMcpSettings', () => {
  it('Electron app을 쓸 수 없는 실행 환경에서는 무경고로 빈 설정을 돌려준다', async () => {
    const { wooiMcpSettings } = await import('./mcpSettings')

    expect(wooiMcpSettings()).toEqual({ servers: [], disabledInherited: [] })
    expect(warn).not.toHaveBeenCalled()
  })
})
