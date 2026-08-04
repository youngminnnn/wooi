import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DelegateBridge } from './bridge'
import { BRIDGE_ENV } from './protocol'

/**
 * 번들된 위임 MCP 서버 ↔ 브리지 왕복.
 *
 * Codex 경로는 조각이 셋이다: (1) codex 가 thread 설정을 보고 이 서버를 띄우고,
 * (2) 서버가 MCP 를 말하고, (3) 소켓으로 메인에 넘겨 서브런이 돈다. (1)은
 * codex/delegateThread.e2e.test.ts 가 실물로 확인하고, 여기서는 (2)(3)을 확인한다 —
 * 모델도 codex 도 부르지 않으므로 빠르고 결정적이다.
 *
 * `npm run build` 산출물을 직접 돌린다. 소스가 아니라 **배포되는 파일**이 동작해야 의미가 있고,
 * 엔트리가 빌드에서 빠지는 종류의 실수가 여기서 잡힌다.
 */

const SERVER = join(process.cwd(), 'out', 'main', 'delegateServer.js')

/**
 * 실행 런타임 두 가지.
 *
 * 배포된 앱은 별도 node 를 싣지 않으므로 **Electron 바이너리를 node 모드로** 띄운다
 * (mcpConfig.ts). 그 경로가 평범한 node 와 같게 동작한다는 보장은 없으므로 — 번들 포맷·내장
 * 모듈 해석이 갈릴 수 있다 — 둘 다 돌려 본다. Electron 이 없으면 그 항목만 건너뛴다.
 */
const ELECTRON = join(
  process.cwd(),
  'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
)
const RUNTIMES: { name: string; exec: string; env: Record<string, string> }[] = [
  { name: 'node', exec: process.execPath, env: {} },
  ...(existsSync(ELECTRON)
    ? [{ name: 'electron (node mode)', exec: ELECTRON, env: { ELECTRON_RUN_AS_NODE: '1' } }]
    : [])
]

let child: ChildProcessWithoutNullStreams | null = null
let bridge: DelegateBridge | null = null
afterEach(() => {
  child?.kill('SIGKILL')
  child = null
  bridge?.dispose()
  bridge = null
})

/** 줄 단위 JSON-RPC 응답을 id 로 기다린다. */
function reader(
  proc: ChildProcessWithoutNullStreams
): (id: number) => Promise<Record<string, unknown>> {
  const waiting = new Map<number, (msg: Record<string, unknown>) => void>()
  const seen = new Map<number, Record<string, unknown>>()
  let buffer = ''
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let i: number
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i)
      buffer = buffer.slice(i + 1)
      if (!line.trim()) continue
      const msg = JSON.parse(line) as Record<string, unknown>
      const id = msg.id as number
      const resolve = waiting.get(id)
      if (resolve) {
        waiting.delete(id)
        resolve(msg)
      } else seen.set(id, msg)
    }
  })
  return (id) =>
    new Promise((resolve) => {
      const hit = seen.get(id)
      if (hit) {
        seen.delete(id)
        resolve(hit)
        return
      }
      waiting.set(id, resolve)
    })
}

describe.skipIf(!existsSync(SERVER))('위임 MCP 서버 ↔ 브리지', () => {
  it.each(RUNTIMES)(
    '$name 에서 도구를 노출하고 호출을 메인으로 넘긴다',
    async (runtime) => {
      const asked: { workspaceId: string; backend: string; prompt: string }[] = []
      bridge = new DelegateBridge({
        // 서브런을 실제로 돌리지 않는다 — 여기서 보는 것은 배선이지 에이전트가 아니다.
        resolve: (workspaceId, backend) => {
          asked.push({ workspaceId, backend, prompt: '' })
          return null
        },
        onStart: () => {},
        onActivity: () => {},
        onEnd: () => {}
      })

      child = spawn(runtime.exec, [SERVER], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...runtime.env,
          [BRIDGE_ENV.socket]: bridge.socketPath(),
          [BRIDGE_ENV.workspaceId]: 'ws-test',
          [BRIDGE_ENV.backends]: 'claude,codex'
        }
      })
      const await_ = reader(child)
      const send = (msg: Record<string, unknown>): void => {
        child!.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
      }

      send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
      const init = (await await_(1)) as { result?: { serverInfo?: { name?: string } } }
      expect(init.result?.serverInfo?.name).toBe('wooi')

      send({ id: 2, method: 'tools/list' })
      const list = (await await_(2)) as {
        result?: {
          tools?: { name: string; inputSchema?: { properties?: Record<string, unknown> } }[]
        }
      }
      const tool = list.result?.tools?.[0]
      expect(tool?.name).toBe('delegate')
      // enum 이 환경변수에서 왔는지 — 여기가 비면 모델이 백엔드를 고를 수 없다.
      expect((tool?.inputSchema?.properties?.backend as { enum?: string[] })?.enum).toEqual([
        'claude',
        'codex'
      ])

      send({
        id: 3,
        method: 'tools/call',
        params: {
          name: 'delegate',
          arguments: { backend: 'claude', description: 'probe', prompt: 'hello' }
        }
      })
      const call = (await await_(3)) as {
        result?: { isError?: boolean; content?: { text?: string }[] }
      }
      // resolve 가 null 을 돌려주므로 거절이 정상이다 — 요청이 **소켓을 건너갔다**는 것이 요점이다.
      expect(asked).toEqual([{ workspaceId: 'ws-test', backend: 'claude', prompt: '' }])
      expect(call.result?.isError).toBe(true)
      expect(call.result?.content?.[0]?.text).toContain('no longer delegate')

      // 모르는 메서드에 응답하지 않으면 클라이언트가 멈춘다.
      send({ id: 4, method: 'nope/nope' })
      const unknown = (await await_(4)) as { error?: { code?: number } }
      expect(unknown.error?.code).toBe(-32601)
    },
    30_000
  )
})
