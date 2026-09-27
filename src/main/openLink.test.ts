import { describe, expect, it, vi } from 'vitest'
import { openLink } from './openLink'

function mockShell() {
  return {
    openExternal: vi.fn().mockResolvedValue(undefined),
    openPath: vi.fn().mockResolvedValue('')
  }
}

describe('openLink', () => {
  it.each([
    ['/Users/test/report.pdf', '/Users/test/report.pdf'],
    ['/Users/test/My%20Report.md:12:3', '/Users/test/My Report.md'],
    ['/Users/test/code.ts#L12-L15', '/Users/test/code.ts'],
    ['file:///Users/test/My%20Report.pdf', '/Users/test/My Report.pdf'],
    ['file:///Users/test/code.ts:12', '/Users/test/code.ts'],
    ['file:///Users/test/code.ts#L12', '/Users/test/code.ts']
  ])('opens %s as a local file', async (link, path) => {
    const shell = mockShell()
    await openLink(link, shell)
    expect(shell.openPath).toHaveBeenCalledWith(path)
    expect(shell.openExternal).not.toHaveBeenCalled()
  })

  it('opens web URLs unchanged, including fragments', async () => {
    const shell = mockShell()
    const url = 'https://example.com/file.ts#L12'
    await openLink(url, shell)
    expect(shell.openExternal).toHaveBeenCalledWith(url)
    expect(shell.openPath).not.toHaveBeenCalled()
  })

  it.each(['javascript:alert(1)', 'data:text/html,hello', '//example.com/path', 'custom:run'])(
    'rejects %s',
    async (link) => {
      const shell = mockShell()
      await openLink(link, shell)
      expect(shell.openPath).not.toHaveBeenCalled()
      expect(shell.openExternal).not.toHaveBeenCalled()
    }
  )

  it('reports OS file-opening failures', async () => {
    const shell = mockShell()
    shell.openPath.mockResolvedValue('File not found')
    await expect(openLink('/missing.pdf', shell)).rejects.toThrow('File not found')
  })

  it('does not open a remote file URL', async () => {
    const shell = mockShell()
    await expect(openLink('file://remote/path', shell)).rejects.toThrow()
    expect(shell.openPath).not.toHaveBeenCalled()
  })
})
