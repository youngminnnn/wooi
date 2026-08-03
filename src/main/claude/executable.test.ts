import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const original = Object.getOwnPropertyDescriptor(process, 'resourcesPath')

function setResourcesPath(value: string | undefined): void {
  Object.defineProperty(process, 'resourcesPath', { value, configurable: true, writable: true })
}

async function resolve(): Promise<string | null> {
  vi.resetModules()
  const { resolveClaudeExecutable } = await import('./executable')
  return resolveClaudeExecutable()
}

/** app.asar.unpacked 에 풀린 네이티브 바이너리를 흉내 낸 resources 디렉터리. */
function packagedResources(): { resources: string; binary: string } {
  const resources = mkdtempSync(join(tmpdir(), 'wooi-resources-'))
  writeFileSync(join(resources, 'app.asar'), 'not a directory')
  const dir = join(
    resources,
    'app.asar.unpacked',
    'node_modules',
    '@anthropic-ai',
    `claude-agent-sdk-${process.platform}-${process.arch}`
  )
  mkdirSync(dir, { recursive: true })
  const binary = join(dir, 'claude')
  writeFileSync(binary, '#!/bin/sh\n')
  return { resources, binary }
}

afterEach(() => {
  if (original) Object.defineProperty(process, 'resourcesPath', original)
  else setResourcesPath(undefined)
  delete process.env.WOOI_PACKAGED
})

describe('resolveClaudeExecutable', () => {
  it('풀어둔 바이너리가 있으면 그 절대 경로를 쓴다 — asar 안 경로로 spawn 하면 ENOTDIR 이다', async () => {
    const { resources, binary } = packagedResources()
    setResourcesPath(resources)
    await expect(resolve()).resolves.toBe(binary)
  })

  it('메인 프로세스처럼 WOOI_PACKAGED 가 없어도 찾는다(PR 리뷰가 메인에서 SDK 를 띄운다)', async () => {
    const { resources, binary } = packagedResources()
    setResourcesPath(resources)
    delete process.env.WOOI_PACKAGED
    await expect(resolve()).resolves.toBe(binary)
  })

  it('dev 처럼 풀어둔 바이너리가 없으면 null 을 돌려 SDK 기본값을 쓴다', async () => {
    setResourcesPath(mkdtempSync(join(tmpdir(), 'wooi-resources-')))
    await expect(resolve()).resolves.toBeNull()
  })

  it('Electron 밖(resourcesPath 없음)에서는 던지지 않고 null 이다', async () => {
    setResourcesPath(undefined)
    process.env.WOOI_PACKAGED = '1'
    await expect(resolve()).resolves.toBeNull()
  })
})
