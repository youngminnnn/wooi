import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runLoginShell } from '../shell'
import { detectGrok, invalidateGrokInstall, MIN_GROK_VERSION } from './executable'

vi.mock('../shell', () => ({ runLoginShell: vi.fn() }))
vi.mock('../logger', () => ({ log: { warn: vi.fn() } }))

const shell = vi.mocked(runLoginShell)

describe('detectGrok', () => {
  beforeEach(() => {
    invalidateGrokInstall()
    shell.mockReset()
  })

  it('accepts an installed current CLI using JSON version output', async () => {
    shell.mockResolvedValueOnce({ stdout: '/usr/local/bin/grok\n', stderr: '', code: 0 })
    shell.mockResolvedValueOnce({ stdout: '{"version":"0.2.0"}', stderr: '', code: 0 })
    await expect(detectGrok()).resolves.toEqual({ usable: true })
  })

  it('reports a missing CLI', async () => {
    shell.mockResolvedValueOnce({ stdout: '', stderr: '', code: 1 })
    await expect(detectGrok()).resolves.toMatchObject({
      usable: false,
      reason: expect.stringContaining('not installed')
    })
  })

  it('reports a CLI older than the ACP floor', async () => {
    shell.mockResolvedValueOnce({ stdout: '/usr/local/bin/grok\n', stderr: '', code: 0 })
    shell.mockResolvedValueOnce({ stdout: '{"version":"0.1.0"}', stderr: '', code: 0 })
    await expect(detectGrok()).resolves.toEqual({
      usable: false,
      reason: `Grok Build 0.1.0 is too old — Wooi needs ${MIN_GROK_VERSION} or newer`
    })
  })

  it('falls back when the JSON version flag is unsupported', async () => {
    shell.mockResolvedValueOnce({ stdout: '/usr/local/bin/grok\n', stderr: '', code: 0 })
    shell.mockResolvedValueOnce({ stdout: '', stderr: 'unknown flag', code: 2 })
    shell.mockResolvedValueOnce({ stdout: 'grok 0.2.0', stderr: '', code: 0 })
    await expect(detectGrok()).resolves.toEqual({ usable: true })
  })
})
