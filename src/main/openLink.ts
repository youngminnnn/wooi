import { fileURLToPath } from 'node:url'

/** Keep local files out of openExternal, which only handles web URLs here. */
export async function openLink(
  target: string,
  shell: {
    openExternal: (url: string) => Promise<void>
    openPath: (path: string) => Promise<string>
  }
): Promise<void> {
  if (/^https?:\/\//i.test(target)) {
    await shell.openExternal(target)
    return
  }
  let path: string
  if (/^file:\/\//i.test(target)) {
    path = fileURLToPath(target.replace(/#L\d+(?:C\d+)?(?:-L?\d+)?$/, ''))
  } else if (target.startsWith('/') && !target.startsWith('//')) {
    path = decodeURIComponent(target.replace(/#L\d+(?:C\d+)?(?:-L?\d+)?$/, ''))
  } else {
    return
  }
  path = path.replace(/:\d+(?::\d+)?$/, '')
  const error = await shell.openPath(path)
  if (error) throw new Error(error)
}
