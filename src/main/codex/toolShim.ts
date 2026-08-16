import { connect } from 'node:net'
import { z } from 'zod'
import { agentToolsFor, WOOI_MCP_INSTRUCTIONS } from '../agent/tools/catalog'
import type { AgentBackendId } from '@shared/types'

/**
 * Codex 용 stdio MCP 서버.
 *
 * `codex app-server` 는 인프로세스 서버를 받지 못하고 **자기가 spawn 하는 프로세스**만 받는다.
 * 그래서 이 파일은 별도 진입점으로 빌드돼(`out/main/toolShim.js`) codex 가 직접 띄운다.
 * 하는 일은 카탈로그를 MCP 로 노출하고, 호출을 메인의 유닉스 소켓으로 넘기는 것뿐이다 —
 * 도구가 무엇을 하는지는 메인만 안다([[agent/tools/registry]]).
 *
 * **workspaceId 를 인자로 받는 이유**: Claude 는 세션마다 서버 인스턴스를 만들어 클로저로 잡지만,
 * 이 프로세스는 모든 워크스페이스가 공유한다. MCP 에는 "누가 불렀는가" 를 싣는 표준 필드가 없고
 * (codex 는 roots 도 선언하지 않으며 서버의 cwd 도 스레드를 따라가지 않는다 — 실측), 스레드마다
 * 서버를 나누려면 app-server 를 재시작해야 해서 다른 워크스페이스의 턴이 끊긴다. 그래서 값은
 * 스레드의 developerInstructions 로 모델에게 알려 주고, 신뢰는 하지 않는다 — 메인이 "실재하고
 * 지금 턴이 도는 워크스페이스인가" 로 좁힌다([[agent/tools/socket]] verifyCaller).
 */

const SOCKET = process.env.WOOI_TOOL_SOCKET ?? ''

/**
 * 이 shim 이 노출할 위임 서브에이전트 종류(쉼표 구분). 비어 있으면 위임 도구가 없다.
 *
 * 왜 env 인가: `tools/list` 시점에는 어느 워크스페이스인지 알 수 없다(workspaceId 는 호출 인자로
 * 온다). 프로세스 전역으로 한 번 등록된 shim 은 모든 워크스페이스를 공유하므로, 워크스페이스마다
 * 다른 도구 집합을 보이려면 **그 워크스페이스 전용 shim** 을 스레드 설정으로 한 번 더 띄우는
 * 수밖에 없다. 그때 이 값으로 무엇을 노출할지 정한다([[codex/thread]]).
 */
/**
 * 이 shim 이 대신 말하는 워크스페이스. 스레드마다 다른 값이 env 로 내려온다
 * ([[codex/thread]] wooiMcpConfig).
 *
 * 모델에게 묻지 않는 것이 요점이다 — 모델이 적는 값은 도구 인자와 이름이 겹칠 수 있고,
 * 그 이름을 알려 주는 지침은 스레드 생성 시점에 굳어 나중에 고칠 수 없다.
 */
const WORKSPACE = process.env.WOOI_TOOL_WORKSPACE ?? ''
const EXTERNAL = process.env.WOOI_TOOL_EXTERNAL === '1'

const EXTERNAL_TOOLS = new Set(['send_to_workspace', 'list_workspace_peers'])

const DELEGATE_BACKENDS = (process.env.WOOI_TOOL_DELEGATE ?? '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean) as AgentBackendId[]

interface JsonRpcMessage {
  id?: number | string
  method?: string
  params?: Record<string, unknown>
}

function send(payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...payload }) + '\n')
}

/** 카탈로그의 zod 스키마를 MCP 가 요구하는 JSON Schema 로 바꾼다. */
function inputSchemaOf(shape: z.ZodRawShape): Record<string, unknown> {
  const schema = z.toJSONSchema(z.object(shape), { io: 'input' }) as Record<string, unknown>
  const properties = (schema.properties ?? {}) as Record<string, unknown>
  const required = (schema.required ?? []) as string[]
  // 카탈로그가 정의한 그대로 내보낸다. 한때 여기에 호출자 id 인자를 하나 덧붙였는데, 그것이
  // 대상을 지목하는 도구의 `workspaceId` 와 이름이 겹쳐 Codex 에서 그 도구들이 언제나 실패했다.
  // 호출자는 이제 스레드 env 로 온다([[codex/thread]] wooiMcpConfig).
  return {
    type: 'object',
    properties: {
      ...properties
    },
    required
  }
}

function tools(): unknown[] {
  // Codex 는 도구 호출을 직렬화한다 — 설명이 그 사실을 반영해야 한다(catalog.ts).
  // 목록만 줄여서는 보안 경계가 되지 않아 메인 registry도 같은 subset을 강제한다. 그래도 여기서
  // 먼저 거르는 이유는 앱 밖 모델이 쓸 수 없는 강한 도구를 발견하거나 호출하게 두지 않기 위해서다.
  return agentToolsFor(DELEGATE_BACKENDS, true)
    .filter((spec) => !EXTERNAL || EXTERNAL_TOOLS.has(spec.name))
    .map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: inputSchemaOf(spec.inputSchema),
    ...(spec.annotations ? { annotations: spec.annotations } : {})
  }))
}

/** 도구 호출 1건을 메인으로 넘긴다. 연결 1개당 요청 1개(줄 단위 JSON). */
function callMain(workspaceId: string, tool: string, args: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!SOCKET) return reject(new Error('Wooi is not reachable (no socket configured).'))
    const socket = connect(SOCKET)
    let buffer = ''
    socket.on('connect', () =>
      socket.write(
        JSON.stringify({
          ...(EXTERNAL ? { caller: 'external' } : { workspaceId }),
          tool,
          args
        }) + '\n'
      )
    )
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
    })
    socket.on('error', (err) => reject(err))
    socket.on('close', () => {
      const line = buffer.split('\n')[0]
      if (!line) return reject(new Error('Wooi closed the connection without answering.'))
      try {
        const res = JSON.parse(line) as { ok: boolean; data?: unknown; error?: string }
        if (res.ok) resolve(res.data)
        else reject(new Error(res.error ?? 'The tool failed.'))
      } catch {
        reject(new Error('Wooi sent a malformed response.'))
      }
    })
  })
}

async function handle(msg: JsonRpcMessage): Promise<void> {
  const { id, method, params } = msg
  if (method === 'initialize') {
    return send({
      id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'wooi', version: '1.0.0' },
        instructions: WOOI_MCP_INSTRUCTIONS
      }
    })
  }
  if (method === 'tools/list') return send({ id, result: { tools: tools() } })

  if (method === 'tools/call') {
    const name = String(params?.name ?? '')
    const args = (params?.arguments ?? {}) as Record<string, unknown>
    // 인자는 도구가 정의한 그대로 넘긴다. 호출자는 이 프로세스가 env 로 알고 있다.
    try {
      const data = await callMain(WORKSPACE, name, args)
      return send({
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(data ?? null) }] }
      })
    } catch (err) {
      // 프로토콜 오류가 아니라 **도구 실패**로 돌려준다 — 모델이 문장을 읽고 고쳐 다시 부를 수
      // 있어야 한다(예: "커밋하고 다시 호출하라").
      return send({
        id,
        result: {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }]
        }
      })
    }
  }

  // 알림(id 없음)은 응답하지 않는다. 그 외 모르는 메서드는 표준 코드로 거절한다.
  if (id !== undefined) send({ id, error: { code: -32601, message: `Unknown method: ${method}` } })
}

let buffer = ''
process.stdin.on('data', (chunk: Buffer) => {
  buffer += chunk.toString()
  let i: number
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim()
    buffer = buffer.slice(i + 1)
    if (!line) continue
    try {
      void handle(JSON.parse(line) as JsonRpcMessage)
    } catch {
      // 깨진 줄 하나 때문에 서버를 죽이지 않는다.
    }
  }
})
