import { describe, it, expect } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ChatEvent, ChatItem } from '@shared/types'
import { e2eWooiMcp } from './testWooiMcp'

/**
 * 실패한 턴을 프로세스를 갈아 끼워 1회 다시 돌리는 경로의 종단 테스트.
 *
 * 진짜 `claude` CLI 를 띄우고 가짜 Anthropic API(항상 인증 오류)를 물려, 계정 전환 직후 옛
 * 자격증명으로 턴이 실패하는 상황을 재현한다. 검증 대상은 세 가지다 —
 * (1) 사용자가 다시 보내지 않아도 새 프로세스에서 같은 메시지가 다시 돌아간다,
 * (2) 새 프로세스가 **같은 session_id 를 resume** 해 대화 맥락이 끊기지 않는다,
 * (3) 재시도까지 실패한 뒤에야 오류가 한 번 표시된다(첫 실패는 사용자에게 숨긴다).
 *
 * CLI 프로세스를 실제로 spawn 하므로 기본 `npm test` 에서는 건너뛴다. 실행:
 *   WOOI_E2E=1 npx vitest run src/main/claude/session.restart.e2e.test.ts
 */
describe.skipIf(!process.env.WOOI_E2E)('ClaudeSession failed-turn restart', () => {
  it('인증 오류로 산출 없이 끝난 턴을 같은 세션을 이어받아 1회 다시 돌린다', async () => {
    // session.ts 는 로드 시점에 네이티브 바이너리 경로를 계산하므로, 스킵될 때 로드되지 않도록
    // 정적 import 가 아니라 동적 import 로 가져온다.
    const { ClaudeSession } = await import('./session')

    let apiCalls = 0
    const server = createServer((req, res) => {
      if (req.url?.includes('/v1/messages')) apiCalls++
      // CLI 는 401/429/5xx 를 자체적으로 여러 번 재시도하므로(관측: 9회) 400 으로 빠르게 실패시킨다.
      // 메시지에 인증 맥락을 담아, 프로세스 교체로 풀릴 실패로 분류되게 한다.
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'e2e: OAuth token revoked' }
        })
      )
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`

    const items: ChatItem[] = []
    const events: ChatEvent[] = []

    const session = new ClaudeSession({
      cwd: process.cwd(),
      repoPath: null,
      model: null,
      effort: null,
      fastMode: false,
      permissionMode: 'default',
      autoCompact: false,
      peer: { name: 'wooi/repo/test', inbound: 'refuse' },
      resumeSessionId: null,
      additionalDirs: [],
      wooiMcp: await e2eWooiMcp(),
      emit: (e) => events.push(e),
      persist: (i) => items.push(i),
      requestPermission: async () => ({ behavior: 'deny' }),
      onSessionId: () => {},
      onPermissionMode: () => {},
      settleIdle: () => {}
    })

    session.send('hello')

    // 두 번의 프로세스 기동이 끝나 오류가 표면화될 때까지 기다린다.
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline && !items.some((i) => i.type === 'error')) {
      await new Promise((r) => setTimeout(r, 250))
    }
    session.dispose()
    await new Promise<void>((r) => server.close(() => r()))
    delete process.env.ANTHROPIC_BASE_URL

    const sessionIds = events.flatMap((e) => (e.type === 'session' ? [e.sessionId] : []))

    // (1) CLI 프로세스가 두 번 떴다 = 사용자 재전송 없이 메시지를 다시 돌렸다.
    expect(sessionIds).toHaveLength(2)
    // (2) 두 프로세스가 같은 세션을 이어받았다 = 대화 맥락이 유지된다.
    expect(new Set(sessionIds).size).toBe(1)
    // (2') 두 프로세스 모두 실제로 API 를 호출했다 = 되살린 메시지가 제대로 흘러갔다.
    expect(apiCalls).toBeGreaterThanOrEqual(2)
    // (3) 오류 카드는 재시도까지 실패한 뒤 딱 한 번, 사용자 메시지는 중복 없이 한 번.
    expect(items.filter((i) => i.type === 'error')).toHaveLength(1)
    expect(items.filter((i) => i.type === 'user')).toHaveLength(1)
  }, 120_000)
})
