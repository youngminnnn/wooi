import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer, type Server } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { agentToolsFor } from '../agent/tools/catalog'

/**
 * 빌드된 shim 을 **실제 프로세스로 띄워** MCP 규약과 소켓 전달을 확인한다.
 *
 * 인프로세스로는 검증할 수 없는 것들이라 이렇게 한다 — shim 은 stdin 리스너를 module scope 에
 * 걸고, codex 가 spawn 하는 것도 이 빌드 산출물 자체다. 소스를 import 해 함수만 부르면 정작
 * codex 가 보게 될 것과 다른 것을 검증하게 된다.
 *
 * 산출물이 없으면(빌드 전) 건너뛴다.
 */

const SHIM = resolve('out/main/toolShim.js')

let shim: ChildProcessWithoutNullStreams | null = null
let socket: Server | null = null
let dir: string | null = null

afterEach(() => {
  shim?.kill()
  shim = null
  socket?.close()
  socket = null
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

interface Harness {
  send: (msg: unknown) => void
  next: (id: number) => Promise<Record<string, unknown>>
  /** shim 이 소켓으로 넘긴 마지막 요청. */
  forwarded: () => unknown
}

/** shim 을 띄우고, 메인 역할을 하는 소켓 스텁을 물린다. */
function start(reply: { ok: boolean; data?: unknown; error?: string }): Harness {
  dir = mkdtempSync(join(tmpdir(), 'wooi-shim-'))
  const path = join(dir, 'tools.sock')

  let forwarded: unknown = null
  socket = createServer((conn) => {
    let buf = ''
    conn.on('data', (chunk) => {
      buf += chunk.toString()
      if (!buf.includes('\n')) return
      forwarded = JSON.parse(buf.split('\n')[0])
      conn.write(JSON.stringify(reply) + '\n')
      conn.end()
    })
  })
  socket.listen(path)

  shim = spawn(process.execPath, [SHIM], {
    env: { ...process.env, WOOI_TOOL_SOCKET: path, WOOI_TOOL_WORKSPACE: 'ws-1' },
    stdio: ['pipe', 'pipe', 'pipe']
  })

  const seen: Record<string, unknown>[] = []
  shim.stdout.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) seen.push(JSON.parse(line))
    }
  })

  return {
    send: (msg) => shim!.stdin.write(JSON.stringify(msg) + '\n'),
    next: async (id) => {
      for (let i = 0; i < 100; i++) {
        const found = seen.find((m) => m.id === id)
        if (found) return found
        await new Promise((r) => setTimeout(r, 25))
      }
      throw new Error(`no response for id ${id}`)
    },
    forwarded: () => forwarded
  }
}

describe.skipIf(!existsSync(SHIM))('codex tool shim', () => {
  it('MCP 핸드셰이크에 응답하고 카탈로그를 노출한다', async () => {
    const h = start({ ok: true })
    h.send({ id: 1, method: 'initialize', params: {} })
    const init = (await h.next(1)).result as Record<string, unknown>
    expect((init.serverInfo as { name: string }).name).toBe('wooi')

    h.send({ id: 2, method: 'tools/list', params: {} })
    const list = (await h.next(2)).result as { tools: Array<{ name: string }> }
    // 소스 카탈로그와 **빌드된 산출물**이 같은지를 본다. 이름을 여기 베껴 두면 도구를 하나
    // 더할 때마다 전송 테스트가 깨질 뿐, 정작 확인하려는 것(빌드가 최신 카탈로그를 실었는가)은
    // 확인되지 않는다. 위임 백엔드 없이 띄웠으므로 shim 이 계산하는 것도 agentToolsFor() 다.
    expect(list.tools.map((t) => t.name)).toEqual(agentToolsFor().map((t) => t.name))
  })

  it('스키마에 전송용 인자를 덧붙이지 않는다', async () => {
    // 한때 호출자 id 를 인자로 받았는데, 대상을 지목하는 도구의 `workspaceId` 와 이름이 겹쳐
    // 모델이 둘을 동시에 적을 수 없었다. 호출자는 이제 env 로 온다.
    const h = start({ ok: true })
    h.send({ id: 1, method: 'tools/list', params: {} })
    const list = (await h.next(1)).result as {
      tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>
    }
    for (const tool of list.tools) {
      expect(Object.keys(tool.inputSchema.properties)).not.toContain('callerWorkspaceId')
    }
  })

  it('카탈로그의 원래 인자도 스키마에 남는다', async () => {
    const h = start({ ok: true })
    h.send({ id: 1, method: 'tools/list', params: {} })
    const list = (await h.next(1)).result as {
      tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>
    }
    const create = list.tools.find((t) => t.name === 'create_stacked_workspace')!
    expect(Object.keys(create.inputSchema.properties).sort()).toEqual(['name', 'task'])
  })

  it('대상을 지목하는 도구의 workspaceId 는 대상 그대로 메인에 닿는다', async () => {
    // 이 세 도구가 Codex 에서 언제나 실패했던 회귀. 호출자는 env(WOOI_TOOL_WORKSPACE)에서 오고,
    // 인자의 workspaceId 는 손대지 않은 채 대상으로 넘어가야 한다.
    const h = start({ ok: true, data: { delivered: false } })
    h.send({
      id: 1,
      method: 'tools/call',
      params: {
        name: 'send_to_workspace',
        arguments: { workspaceId: 'ws-them', message: 'heads up' }
      }
    })
    await h.next(1)
    expect(h.forwarded()).toEqual({
      workspaceId: 'ws-1',
      tool: 'send_to_workspace',
      args: { workspaceId: 'ws-them', message: 'heads up' }
    })
  })

  it('메인이 거절하면 프로토콜 오류가 아니라 도구 실패로 돌려준다', async () => {
    // 모델이 문장을 읽고 스스로 고쳐 다시 부를 수 있어야 한다("커밋하고 다시 호출하라" 등).
    const h = start({ ok: false, error: 'This worktree has uncommitted changes.' })
    h.send({
      id: 1,
      method: 'tools/call',
      params: { name: 'create_stacked_workspace', arguments: {} }
    })
    const res = (await h.next(1)).result as { isError: boolean; content: Array<{ text: string }> }

    expect(res.isError).toBe(true)
    expect(res.content[0].text).toMatch(/uncommitted changes/)
  })

  it('모르는 메서드는 표준 코드로 거절한다(요청이 매달리지 않도록)', async () => {
    const h = start({ ok: true })
    h.send({ id: 1, method: 'resources/list', params: {} })
    const res = await h.next(1)
    expect((res.error as { code: number }).code).toBe(-32601)
  })

  /**
   * 패키징 빌드에서 shim 을 실행하는 것은 우리가 아니라 codex 다. asar 밖에 풀린 파일만 보이므로,
   * shim 이 import 하는 것까지 **함께** 풀려 있어야 한다.
   *
   * 실제로 여기서 한 번 깨졌다: rollup 이 카탈로그를 공유 청크로 분리했는데 asarUnpack 이
   * toolShim.js 하나만 풀어, 패키징 빌드에서 ERR_MODULE_NOT_FOUND 로 죽었다. 유닛 테스트도
   * dev 실행도 멀쩡했다 — 그 조합은 패키징에서만 드러난다.
   */
  it('shim 이 끌어오는 것까지 asarUnpack 범위 안에 있다', () => {
    const pending = [SHIM]
    const visited = new Set<string>()

    // 패키징된 shim 은 일반 Node 프로세스가 실행하므로 app.asar 안의 node_modules 를 읽지
    // 못한다. 상대 import 는 모두 unpack 범위에 있어야 하고, node: 외의 bare import 는 빌드에
    // 남아 있으면 안 된다. 진입점만 보면 공유 청크 안의 외부 의존성을 놓치므로 재귀해서 본다.
    while (pending.length > 0) {
      const file = pending.pop()!
      if (visited.has(file)) continue
      visited.add(file)

      const source = readFileSync(file, 'utf8')
      const imports = [...source.matchAll(/^import\s+(?:[^"']+\s+from\s+)?["']([^"']+)["']/gm)].map(
        (m) => m[1]
      )
      for (const spec of imports) {
        if (spec.startsWith('node:')) continue
        expect(spec.startsWith('.'), `${file} has unpackaged dependency ${spec}`).toBe(true)
        const target = resolve(dirname(file), spec)
        expect(existsSync(target), `${spec} → ${target}`).toBe(true)
        expect(target.startsWith(resolve('out/main'))).toBe(true)
        pending.push(target)
      }
    }

    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      build: { asarUnpack: string[] }
    }
    expect(
      pkg.build.asarUnpack.some((p) => p === 'out/main/**'),
      'asarUnpack must unpack all of out/main — shim-only leaves its shared chunks inside the asar'
    ).toBe(true)
  })
})
