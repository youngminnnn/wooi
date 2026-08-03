import { describe, it, expect } from 'vitest'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { ChatEvent, ChatItem } from '@shared/types'

/**
 * 훅(.claude/settings.json 의 `hooks`)이 Wooi 세션에서도 터미널 `claude` 와 똑같이 도는지 확인한다.
 *
 * 훅은 settingSources 로 읽는 설정 파일에 들어 있으므로, 우리가 넘기는 옵션이 그 스코프를 빠뜨리면
 * 조용히 무시된다 — 사용자 입장에선 "터미널에선 되는데 Wooi 에선 안 되는" 대표적인 차이다.
 * SessionStart 훅은 모델 왕복 없이 프로세스 기동만으로 발화하므로, 가짜 API 를 물려도 검증할 수 있다.
 *
 * CLI 프로세스를 실제로 spawn 하므로 기본 `npm test` 에서는 건너뛴다. 실행:
 *   WOOI_E2E=1 npx vitest run src/main/claude/session.hooks.e2e.test.ts
 * (Wooi 가 띄운 셸에서 돌릴 때는 상속된 WOOI_PACKAGED 를 지워야 한다: `env -u WOOI_PACKAGED …`)
 */
describe.skipIf(!process.env.WOOI_E2E)('ClaudeSession hooks', () => {
  it('프로젝트 .claude/settings.json 의 SessionStart 훅이 실행된다', async () => {
    const { ClaudeSession } = await import('./session')

    const cwd = mkdtempSync(join(tmpdir(), 'wooi-hooks-'))
    const marker = join(cwd, 'hook-ran.txt')
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    writeFileSync(
      join(cwd, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: `printf ok > ${JSON.stringify(marker)}` }] }
          ]
        }
      })
    )

    const server = createServer((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'e2e: no model calls needed' }
        })
      )
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`

    const items: ChatItem[] = []
    const events: ChatEvent[] = []
    const session = new ClaudeSession({
      cwd,
      repoPath: null,
      model: null,
      effort: null,
      fastMode: false,
      permissionMode: 'default',
      autoCompact: false,
      resumeSessionId: null,
      additionalDirs: [],
      emit: (e) => events.push(e),
      persist: (i) => items.push(i),
      requestPermission: async () => ({ behavior: 'deny' }),
      onSessionId: () => {},
      onPermissionMode: () => {},
      settleIdle: () => {}
    })

    session.send('hello')

    const deadline = Date.now() + 90_000
    while (Date.now() < deadline && !existsSync(marker)) {
      await new Promise((r) => setTimeout(r, 250))
    }
    session.dispose()
    await new Promise<void>((r) => server.close(() => r()))
    delete process.env.ANTHROPIC_BASE_URL

    expect(existsSync(marker)).toBe(true)
    expect(readFileSync(marker, 'utf-8')).toBe('ok')
    expect(events.length).toBeGreaterThan(0)
  }, 120_000)

  it('실패한 훅은 이유와 함께 시스템 항목으로 표시된다', async () => {
    const { ClaudeSession } = await import('./session')

    const cwd = mkdtempSync(join(tmpdir(), 'wooi-hooks-'))
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    writeFileSync(
      join(cwd, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: 'echo wooi-hook-boom >&2; exit 3' }] }
          ]
        }
      })
    )

    const server = createServer((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'e2e: no model calls needed' }
        })
      )
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`

    const items: ChatItem[] = []
    const session = new ClaudeSession({
      cwd,
      repoPath: null,
      model: null,
      effort: null,
      fastMode: false,
      permissionMode: 'default',
      autoCompact: false,
      resumeSessionId: null,
      additionalDirs: [],
      emit: () => {},
      persist: (i) => items.push(i),
      requestPermission: async () => ({ behavior: 'deny' }),
      onSessionId: () => {},
      onPermissionMode: () => {},
      settleIdle: () => {}
    })

    session.send('hello')

    const failed = (): ChatItem | undefined =>
      items.find((i) => i.type === 'system' && i.text.includes('hook failed'))
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline && !failed()) {
      await new Promise((r) => setTimeout(r, 250))
    }
    session.dispose()
    await new Promise<void>((r) => server.close(() => r()))
    delete process.env.ANTHROPIC_BASE_URL

    const item = failed()
    expect(item).toBeDefined()
    expect(item && item.type === 'system' ? item.text : '').toContain('wooi-hook-boom')
  }, 120_000)
})
