import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

const protocolHandle = vi.fn()
const fakeSession = {
  setPermissionRequestHandler: vi.fn(),
  setPermissionCheckHandler: vi.fn(),
  setDevicePermissionHandler: vi.fn(),
  on: vi.fn(),
  removeAllListeners: vi.fn(),
  clearStorageData: vi.fn(() => Promise.resolve()),
  protocol: { handle: protocolHandle, unhandle: vi.fn() }
}

vi.mock('electron', () => ({
  app: { getAppPath: () => '' },
  session: { fromPartition: () => fakeSession }
}))
vi.mock('./logger', () => ({ log: { info: vi.fn(), error: vi.fn() } }))

const roots: string[] = []

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wooi-visualization-test-'))
  roots.push(dir)
  return dir
}

afterEach(async () => {
  const { rmSync } = await import('node:fs')
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('validateVisualizationFile', () => {
  it('accepts a regular lowercase .html file inside its worktree', async () => {
    const worktree = root()
    const file = join(worktree, 'visualizations', 'chart.html')
    mkdirSync(join(worktree, 'visualizations'))
    writeFileSync(file, '<h1>chart</h1>')
    const { validateVisualizationFile } = await import('./artifactProtocol')
    expect(validateVisualizationFile(worktree, file)).toBe(realpathSync(file))
  })

  it('rejects traversal, directories, non-HTML files, oversized files, and symlinks', async () => {
    const worktree = root()
    const outside = root()
    const html = join(worktree, 'chart.html')
    const text = join(worktree, 'chart.htm')
    const linked = join(worktree, 'linked.html')
    writeFileSync(html, '<h1>chart</h1>')
    writeFileSync(text, 'nope')
    writeFileSync(join(worktree, 'large.html'), 'x'.repeat(1024 * 1024 + 1))
    writeFileSync(join(outside, 'outside.html'), '<h1>outside</h1>')
    mkdirSync(join(worktree, 'directory.html'))
    symlinkSync(join(outside, 'outside.html'), linked)
    const { validateVisualizationFile } = await import('./artifactProtocol')

    expect(() =>
      validateVisualizationFile(worktree, join(worktree, '..', basename(outside), 'outside.html'))
    ).toThrow(/inside this workspace/)
    expect(() => validateVisualizationFile(worktree, join(worktree, 'directory.html'))).toThrow(
      /regular file/
    )
    expect(() => validateVisualizationFile(worktree, text)).toThrow(/\.html/)
    expect(() => validateVisualizationFile(worktree, join(worktree, 'large.html'))).toThrow(/1 MiB/)
    expect(() => validateVisualizationFile(worktree, linked)).toThrow(/symlinks/)
  })

  it('serves the registered snapshot even if the source path is replaced later', async () => {
    const worktree = root()
    const outside = root()
    const file = join(worktree, 'chart.html')
    writeFileSync(file, '<h1>safe</h1>')
    writeFileSync(join(outside, 'outside.html'), '<h1>outside</h1>')
    const { ensureArtifactSession, registerVisualization } = await import('./artifactProtocol')
    const url = registerVisualization('ws-1', worktree, file)
    ensureArtifactSession('wooi-artifact-ws-1')
    const handler = protocolHandle.mock.calls.at(-1)?.[1] as
      ((request: { url: string }) => Promise<Response>) | undefined
    expect(handler).toBeTypeOf('function')

    unlinkSync(file)
    symlinkSync(join(outside, 'outside.html'), file)
    const response = await handler!({ url })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('<h1>safe</h1>')
  })

  it('does not serve an artifact route through another workspace partition', async () => {
    const { ensureArtifactSession } = await import('./artifactProtocol')
    ensureArtifactSession('wooi-artifact-ws-1')
    const handler = protocolHandle.mock.calls.at(-1)?.[1] as
      ((request: { url: string }) => Promise<Response>) | undefined
    const response = await handler!({
      url: 'wooi-artifact://a/w/ws-2/artifact-id/1/index.html'
    })
    expect(response.status).toBe(404)
  })
})
