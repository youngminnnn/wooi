import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer, type Server } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

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
    env: { ...process.env, WOOI_TOOL_SOCKET: path },
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
    expect(list.tools.map((t) => t.name)).toEqual([
      'create_stacked_workspace',
      'report_to_parent',
      'check_stacked_work'
    ])
  })

  it('모든 도구 스키마에 workspaceId 를 필수로 더한다', async () => {
    // 이 전송 계층은 "누가 불렀는가" 를 실어 주지 못한다 — 그래서 인자로 받는다.
    // 빠지면 메인이 호출자를 특정할 수 없어 전부 거절된다.
    const h = start({ ok: true })
    h.send({ id: 1, method: 'tools/list', params: {} })
    const list = (await h.next(1)).result as {
      tools: Array<{ inputSchema: { properties: Record<string, unknown>; required: string[] } }>
    }
    for (const tool of list.tools) {
      expect(tool.inputSchema.properties).toHaveProperty('workspaceId')
      expect(tool.inputSchema.required).toContain('workspaceId')
    }
  })

  it('카탈로그의 원래 인자도 스키마에 남는다', async () => {
    const h = start({ ok: true })
    h.send({ id: 1, method: 'tools/list', params: {} })
    const list = (await h.next(1)).result as {
      tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>
    }
    const create = list.tools.find((t) => t.name === 'create_stacked_workspace')!
    expect(Object.keys(create.inputSchema.properties).sort()).toEqual([
      'name',
      'task',
      'workspaceId'
    ])
  })

  it('호출을 메인으로 넘기며 workspaceId 를 인자에서 떼어 낸다', async () => {
    // 메인의 핸들러는 Claude 와 공유하므로 workspaceId 가 args 에 섞여 들어가면 안 된다.
    const h = start({ ok: true, data: { branch: 'feat/next' } })
    h.send({
      id: 1,
      method: 'tools/call',
      params: {
        name: 'create_stacked_workspace',
        arguments: { workspaceId: 'ws-1', name: 'feat/next', task: 'do it' }
      }
    })
    const res = (await h.next(1)).result as { content: Array<{ text: string }> }

    expect(h.forwarded()).toEqual({
      workspaceId: 'ws-1',
      tool: 'create_stacked_workspace',
      args: { name: 'feat/next', task: 'do it' }
    })
    expect(JSON.parse(res.content[0].text)).toEqual({ branch: 'feat/next' })
  })

  it('메인이 거절하면 프로토콜 오류가 아니라 도구 실패로 돌려준다', async () => {
    // 모델이 문장을 읽고 스스로 고쳐 다시 부를 수 있어야 한다("커밋하고 다시 호출하라" 등).
    const h = start({ ok: false, error: 'This worktree has uncommitted changes.' })
    h.send({
      id: 1,
      method: 'tools/call',
      params: { name: 'create_stacked_workspace', arguments: { workspaceId: 'ws-1' } }
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
    const source = readFileSync(SHIM, 'utf8')
    const imports = [...source.matchAll(/from\s*["'](\.[^"']+)["']/g)].map((m) => m[1])

    // 상대 import 는 전부 out/main 아래로 떨어져야 한다(그 디렉터리를 통째로 푸는 것이 전제).
    for (const spec of imports) {
      const target = resolve(dirname(SHIM), spec)
      expect(existsSync(target), `${spec} → ${target}`).toBe(true)
      expect(target.startsWith(resolve('out/main'))).toBe(true)
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
