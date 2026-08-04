import { connect, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { AGENT_BACKEND_LABELS, type AgentBackendId } from '@shared/types'
import { BRIDGE_ENV, type BridgeRequest, type BridgeResponse } from './protocol'

/**
 * 번들된 stdio MCP 서버 — Codex 워크스페이스에 위임 도구를 붙이는 유일한 경로.
 *
 * codex app-server 가 `thread/start` 의 `config.mcp_servers` 를 보고 **이 파일을 자식 프로세스로**
 * 띄운다(실측 확인: codex/probe.e2e.test.ts). 그래서 여기는 메인 프로세스 밖이고, store 도
 * 권한 UI 도 세션도 닿지 않는다.
 *
 * 그러므로 이 파일은 아무것도 판단하지 않는다. MCP 프레이밍만 처리하고, 도구 호출은 소켓으로
 * 메인에 넘겨 결과를 그대로 돌려준다. 실제 실행·권한·중단·표시는 전부 메인(subagent/bridge.ts)이
 * 한다 — Claude 경로(claude/delegate.ts)가 같은 일을 프로세스 안에서 하는 것과 대비된다.
 *
 * Electron 바이너리를 `ELECTRON_RUN_AS_NODE=1` 로 띄워 실행한다(별도 node 를 배포하지 않으므로).
 */

const SOCKET = process.env[BRIDGE_ENV.socket] ?? ''
const WORKSPACE_ID = process.env[BRIDGE_ENV.workspaceId] ?? ''
const BACKENDS = (process.env[BRIDGE_ENV.backends] ?? '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean) as AgentBackendId[]

const PROTOCOL_VERSION = '2024-11-05'

// ── 메인과의 소켓 ────────────────────────────────────────────────────────

let socket: Socket | null = null
/** 응답을 기다리는 위임 호출. 소켓이 끊기면 전부 실패로 풀어 준다(도구가 영원히 매달리지 않게). */
const pending = new Map<string, (response: BridgeResponse) => void>()

function bridge(): Socket {
  if (socket) return socket
  const next = connect(SOCKET)
  next.setEncoding('utf8')
  let buffer = ''
  next.on('data', (chunk: string) => {
    buffer += chunk
    let index: number
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      try {
        const response = JSON.parse(line) as BridgeResponse
        pending.get(response.id)?.(response)
        pending.delete(response.id)
      } catch {
        /* 프로토콜이 아닌 줄은 버린다. */
      }
    }
  })
  const fail = (message: string): void => {
    socket = null
    for (const [id, resolve] of pending) resolve({ type: 'result', id, error: message })
    pending.clear()
  }
  next.on('error', () => fail('Lost the connection to Wooi, so the task could not run.'))
  next.on('close', () => fail('Wooi closed the connection before the task finished.'))
  socket = next
  return next
}

function delegate(backend: string, description: string, prompt: string): Promise<BridgeResponse> {
  return new Promise((resolve) => {
    const id = randomUUID()
    const request: BridgeRequest = {
      type: 'delegate',
      id,
      workspaceId: WORKSPACE_ID,
      backend: backend as AgentBackendId,
      description,
      prompt
    }
    pending.set(id, resolve)
    try {
      bridge().write(`${JSON.stringify(request)}\n`)
    } catch (err) {
      pending.delete(id)
      resolve({ type: 'result', id, error: `Could not reach Wooi: ${String(err)}` })
    }
  })
}

// ── MCP (stdio, 줄바꿈 구분 JSON-RPC) ────────────────────────────────────

interface JsonRpcMessage {
  jsonrpc?: string
  id?: string | number
  method?: string
  params?: Record<string, unknown>
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

/**
 * 도구 설명 — Claude 쪽(claude/delegate.ts 의 describeTool)과 **같은 내용을 유지한다**.
 * 두 백엔드가 같은 도구를 다르게 이해하면, 같은 워크스페이스 설정인데 메인이 누구냐에 따라
 * 위임이 걸리기도 하고 안 걸리기도 하는 상태가 된다.
 */
function toolDescription(): string {
  const names = BACKENDS.map((b) => AGENT_BACKEND_LABELS[b] ?? b).join(', ')
  return (
    'Run a task with a specific coding agent product and wait for its answer. ' +
    `This is a multi-agent workspace: ${names} are all available to you. ` +
    'Reach for this whenever the user names an agent ("have Claude look at this", "run it on both ' +
    'and compare") — that request maps directly onto this tool. Call it once per agent you need. ' +
    'If the agent you want is your own kind, prefer your built-in subagents instead: they share ' +
    'your context and cost less. ' +
    'The agent runs in this same worktree under your permission mode, starts from an empty ' +
    'context, and reports back exactly once as text; it cannot ask you anything mid-run, so put ' +
    'everything it needs in the prompt.'
  )
}

const TOOL = {
  name: 'delegate',
  description: toolDescription(),
  inputSchema: {
    type: 'object',
    properties: {
      backend: {
        type: 'string',
        enum: BACKENDS,
        description: 'Which agent product runs this task. Match what the user asked for by name.'
      },
      description: {
        type: 'string',
        description: 'A 3-6 word label for this task, shown while it runs (e.g. "Audit auth flow").'
      },
      prompt: {
        type: 'string',
        description:
          'The complete task brief. The delegated agent starts with a blank context and cannot ' +
          'see this conversation, so restate every fact it needs: files, constraints, and what to return.'
      }
    },
    required: ['backend', 'description', 'prompt'],
    additionalProperties: false
  }
}

async function handle(message: JsonRpcMessage): Promise<void> {
  const { id, method, params } = message
  // 알림(id 없음)은 답하지 않는다 — notifications/initialized 가 여기 걸린다.
  const isRequest = id !== undefined && id !== null

  if (method === 'initialize') {
    if (isRequest) {
      send({
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'wooi', version: '1.0.0' }
        }
      })
    }
    return
  }

  if (method === 'tools/list') {
    if (isRequest) send({ id, result: { tools: [TOOL] } })
    return
  }

  if (method === 'tools/call') {
    if (!isRequest) return
    const args = (params?.arguments ?? {}) as Record<string, unknown>
    const name = params?.name
    if (name !== TOOL.name) {
      send({ id, error: { code: -32602, message: `Unknown tool: ${String(name)}` } })
      return
    }
    const response = await delegate(
      String(args.backend ?? ''),
      String(args.description ?? 'Delegated task'),
      String(args.prompt ?? '')
    )
    send({
      id,
      result: {
        content: [{ type: 'text', text: response.error ?? response.text ?? '' }],
        ...(response.error ? { isError: true } : {})
      }
    })
    return
  }

  // 모르는 메서드는 규격대로 거절한다. 조용히 무시하면 클라이언트가 응답을 기다리며 멈춘다.
  if (isRequest) send({ id, error: { code: -32601, message: `Unknown method: ${String(method)}` } })
}

// 소켓은 **시작하자마자** 연다. 첫 도구 호출까지 미루면, 메인이 사라졌거나 소켓 경로가 틀린
// 경우가 사용자가 위임을 시도한 순간에야 드러난다 — 그때는 이미 모델이 한 턴을 쓴 뒤다.
// 연결이 끊기면 fail() 이 socket 을 비우므로 다음 호출이 알아서 다시 연다.
bridge()

let stdinBuffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  stdinBuffer += chunk
  let index: number
  while ((index = stdinBuffer.indexOf('\n')) >= 0) {
    const line = stdinBuffer.slice(0, index)
    stdinBuffer = stdinBuffer.slice(index + 1)
    if (!line.trim()) continue
    let message: JsonRpcMessage
    try {
      message = JSON.parse(line) as JsonRpcMessage
    } catch {
      continue
    }
    void handle(message)
  }
})
// stdin 이 닫히면 클라이언트가 사라진 것이다. 매달린 호출을 남기지 않고 그대로 끝낸다.
process.stdin.on('end', () => process.exit(0))
