import { randomUUID } from 'node:crypto'
import { log } from '../logger'
import { AppServer, wooiMcpServerTable } from './appServer'
import { detectCodex } from './executable'
import { WOOI_MCP_SERVER_NAME } from '../agent/tools/catalog'
import { CodexThread } from './thread'
import { turnPolicyFor, type SandboxPolicy } from './modes'
import {
  answersFor,
  mapCommandApproval,
  mapFileChangeApproval,
  mapUserInputRequest,
  toCodexDecision
} from './mapping'
import {
  RPC,
  SERVER_REQUEST,
  NOTIFY,
  type AccountReadResult,
  type ModelListResult,
  type RateLimitsResult,
  type McpServerOauthLoginCompletedParams,
  type PluginReadResponse,
  type PluginsResponse,
  normalizeMcpAuthStatus
} from './wire'
import type { CodexCommand, CodexConfig, CodexEvent, CodexLoginMethod } from './protocol'
import { toPluginDetail, toPluginInventory } from './plugins'
import type {
  AgentAuthStatus,
  ChatEvent,
  ChatItem,
  CommandPanelKind,
  CodexMcpServer,
  CodexPluginDetail,
  CodexPluginInventory,
  CodexPluginRef,
  CommandResult,
  McpAction,
  McpServerInfo,
  ModelOption,
  PermissionDecision,
  PermissionRequest
} from '@shared/types'
import type { RpcClient } from './jsonrpc'
import { durationLabel } from './rateLimits'

/**
 * codex-host: `codex app-server` 를 소유하는 유틸리티 프로세스의 진입점.
 *
 * app-server 자식 프로세스는 **하나**만 띄우고 워크스페이스마다 스레드를 연다. 알림은 threadId 로
 * 해당 CodexThread 에 라우팅한다. 승인 요청(서버 → 클라이언트 JSON-RPC 요청)은 메인을 거쳐
 * 렌더러 프롬프트로 올라갔다가, 사용자의 결정이 다시 내려와 응답으로 이어진다.
 */

const port = process.parentPort

function post(msg: CodexEvent): void {
  port.postMessage(msg)
}

/** workspaceId → 스레드. */
const threads = new Map<string, CodexThread>()
/** 우리가 발급한 requestId → 승인 결정 resolver(메인의 permissionResponse 가 푼다). */
const pendingApprovals = new Map<string, (d: PermissionDecision) => void>()

let server: AppServer | null = null
/** detectCodex() await 중 겹쳐 들어온 요청이 AppServer를 각각 만드는 것을 막는 단일 초기화 Promise. */
let openingServer: Promise<AppServer> | null = null

async function openServer(): Promise<AppServer> {
  const install = await detectCodex()
  if (!install.path || !install.usable) {
    throw new Error(install.reason ?? 'Codex CLI is not available')
  }
  return new AppServer({
    executable: install.path,
    onNotification: routeNotification,
    requestHandlers: {
      [SERVER_REQUEST.commandApproval]: (params) => approve(params, mapCommandApproval),
      [SERVER_REQUEST.fileChangeApproval]: (params) => approveFileChange(params),
      [SERVER_REQUEST.requestUserInput]: (params) => answer(params),
      [SERVER_REQUEST.permissionsApproval]: (params) => approvePermissions(params),
      [SERVER_REQUEST.elicitation]: (params) => answerElicitation(params),
      [SERVER_REQUEST.dynamicToolCall]: (params) => rejectDynamicTool(params)
    },
    onExit: onServerExit
  })
}

/** 공유 app-server 연결. 처음 필요할 때 codex 를 찾아 띄운다. */
async function rpc(): Promise<RpcClient> {
  if (!server) {
    if (!openingServer) openingServer = openServer()
    try {
      server = await openingServer
    } finally {
      openingServer = null
    }
  }
  return server.rpc()
}

// ── 알림 라우팅 ─────────────────────────────────────────────────────────

function routeNotification(method: string, params: unknown): void {
  // 서버가 대기 중이던 승인 요청을 스스로 거둬들였다 — 렌더러의 프롬프트도 닫아 준다.
  if (method === NOTIFY.serverRequestResolved) {
    const requestId = (params as { requestId?: string | number })?.requestId
    if (requestId !== undefined) closeApproval(String(requestId))
    return
  }

  // 브라우저 인증이 끝났다(성공/실패 모두). 모달을 닫고 인증 상태를 다시 읽게 한다.
  if (method === NOTIFY.accountLoginCompleted) {
    const p = params as { success?: boolean; error?: string | null }
    pendingLoginId = null
    post({
      type: 'login',
      update: { phase: 'done', success: !!p?.success, error: p?.error ?? undefined }
    })
    return
  }

  // 계정이 바뀌었다(로그인·로그아웃·토큰 갱신). 메인이 상태를 다시 읽고 세션을 재활용한다.
  if (method === NOTIFY.accountUpdated) {
    post({ type: 'accountChanged' })
    return
  }

  if (method === NOTIFY.mcpOauthLoginCompleted) {
    const p = params as McpServerOauthLoginCompletedParams
    if (p?.name && typeof p.success === 'boolean') {
      post({
        type: 'mcpOauthLoginCompleted',
        name: p.name,
        success: p.success,
        error: typeof p.error === 'string' ? p.error : undefined
      })
    }
    return
  }

  if (method === NOTIFY.skillsChanged) {
    post({ type: 'skillsChanged' })
    return
  }

  const threadId = (params as { threadId?: string })?.threadId
  if (!threadId) return

  const thread = threadFor(threadId)
  // 소유자가 없는 알림은 버린다. thread/started 가 RPC 응답보다 먼저 도착하는 경우가 여기 걸리는데,
  // threadId 는 그 응답에서도 받으므로 잃는 정보가 없다.
  thread?.handleNotification(method, params)
}

function threadFor(threadId: string): CodexThread | undefined {
  for (const thread of threads.values()) {
    if (thread.owns(threadId)) return thread
  }
  return undefined
}

// ── 승인 ────────────────────────────────────────────────────────────────

/** 승인 요청 파라미터 → 렌더러 프롬프트로 옮기는 변환기. */
type ApprovalMapper = (params: never) => Omit<PermissionRequest, 'requestId' | 'workspaceId'>

/**
 * 승인 요청을 렌더러로 올리고 사용자의 결정을 기다린다.
 *
 * 이 Promise 가 풀리기 전까지 codex 쪽 턴은 멈춰 있다. 그래서 어떤 경로로든 **반드시** 결정이
 * 나야 한다 — 정리·호스트 종료 시 대기 중인 요청을 전부 거절로 푸는 이유다.
 */
async function approve(params: unknown, toRequest: ApprovalMapper): Promise<{ decision: unknown }> {
  const decision = await prompt(params, toRequest(params as never))
  // 서버가 준 원본 목록을 함께 넘긴다 — 객체 형태의 결정은 그 객체를 통째로 되돌려야 한다.
  const available = (params as { availableDecisions?: unknown[] })?.availableDecisions
  return { decision: toCodexDecision(decision, available) }
}

/**
 * 파일 변경 승인 — 요청에 diff 가 없으므로, 같은 itemId 의 fileChange 아이템에서 꺼내 붙인다.
 * 그래야 사용자가 무엇을 승인하는지 보고 결정할 수 있다.
 */
async function approveFileChange(params: unknown): Promise<{ decision: unknown }> {
  const p = params as { threadId?: string; itemId?: string }
  const changes = p.itemId ? (threadFor(p.threadId ?? '')?.fileChanges(p.itemId) ?? []) : []
  const decision = await prompt(params, mapFileChangeApproval(p as never, changes))
  return { decision: toCodexDecision(decision) }
}

/**
 * 질문 요청 — 기존 AskUserQuestion UI 를 그대로 쓴다.
 *
 * 그 UI 는 답을 "질문문 → 답" 객체로 돌려주는데 codex 는 질문 순서대로의 배열을 기대하므로,
 * answersFor 가 변환한다. 거절(취소)이면 빈 배열을 보내 codex 가 진행을 결정하게 한다.
 */
async function answer(
  params: unknown
): Promise<{ answers: Record<string, { answers: string[] }> }> {
  const decision = await prompt(params, mapUserInputRequest(params as never))
  if (decision.behavior !== 'allow') return { answers: {} }
  return { answers: answersFor(params as never, decision.updatedInput) }
}

/** Codex 의 세분화된 파일시스템/네트워크 권한 요청. 요청된 범위보다 넓게 허용하지 않는다. */
async function approvePermissions(params: unknown): Promise<{
  permissions: Record<string, unknown>
  scope: 'turn' | 'session'
}> {
  const p = params as {
    reason?: string | null
    cwd?: string
    permissions?: Record<string, unknown>
  }
  const decision = await prompt(params, {
    kind: 'tool',
    toolName: 'RequestPermissions',
    title: p.reason?.trim() || 'Codex requests additional permissions',
    displayName: 'Grant permissions',
    input: { cwd: p.cwd, permissions: p.permissions ?? {} },
    decisionReason: p.reason ?? undefined,
    options: [
      { id: 'turn', label: 'Allow for turn', behavior: 'allow' },
      {
        id: 'session',
        label: 'Allow for session',
        behavior: 'allow',
        rememberForSession: true
      },
      { id: 'decline', label: 'Reject', behavior: 'deny' }
    ]
  })
  return {
    permissions: decision.behavior === 'allow' ? (p.permissions ?? {}) : {},
    scope: decision.optionId === 'session' ? 'session' : 'turn'
  }
}

/** MCP elicitation 을 기존 질문 UI 로 옮긴다. form 필드는 자유 입력 가능한 질문으로 표시한다. */
async function answerElicitation(params: unknown): Promise<{
  action: 'accept' | 'decline'
  content: Record<string, string> | null
  _meta: null
}> {
  const p = params as {
    mode?: string
    serverName?: string
    message?: string
    url?: string
    requestedSchema?: {
      properties?: Record<string, { title?: string; description?: string; enum?: unknown[] }>
      required?: string[]
    }
  }
  const properties = p.requestedSchema?.properties ?? {}
  const questions = Object.entries(properties).map(([name, schema]) => ({
    question: schema.description || schema.title || name,
    header: name,
    options: (schema.enum ?? []).map((value) => ({ label: String(value), description: '' }))
  }))
  if (p.mode === 'url') {
    questions.push({
      question: p.message || `Open the URL requested by ${p.serverName ?? 'the MCP server'}`,
      header: 'URL',
      options: [{ label: p.url ?? '', description: p.url ?? '' }]
    })
  }
  // openai/form은 의도적으로 opaque한 확장 포맷이다. JSON Schema `properties`가 없더라도
  // request_plugin_install 같은 확인 요청은 반드시 사용자가 수락/거절할 수 있어야 한다.
  // 폼 payload 자체는 Codex Apps MCP가 이미 가지고 있으므로 확인 응답에는 빈 객체면 충분하다.
  if (questions.length === 0) {
    questions.push({
      question: p.message || `${p.serverName ?? 'MCP server'} requests confirmation`,
      header: p.mode === 'openai/form' ? 'Confirm' : 'Request',
      options: [
        { label: 'Allow', description: 'Continue with this request' },
        { label: 'Cancel', description: 'Do not continue' }
      ]
    })
  }
  const decision = await prompt(params, {
    kind: 'question',
    toolName: 'McpElicitation',
    title: p.message || `${p.serverName ?? 'MCP server'} requests input`,
    input: { questions }
  })
  if (decision.behavior !== 'allow') return { action: 'decline', content: null, _meta: null }
  const raw = (decision.updatedInput?.answers ?? {}) as Record<string, string>
  const content: Record<string, string> = {}
  for (const [name, schema] of Object.entries(properties)) {
    const question = schema.description || schema.title || name
    if (raw[question] !== undefined) content[name] = raw[question]
  }
  return { action: 'accept', content, _meta: null }
}

/** 클라이언트 확장 도구는 Wooi 에 등록된 실행기가 없으므로 명시적인 도구 실패로 되돌린다. */
async function rejectDynamicTool(params: unknown): Promise<{
  contentItems: Array<{ type: 'inputText'; text: string }>
  success: false
}> {
  const p = params as { namespace?: string | null; tool?: string }
  return {
    contentItems: [
      {
        type: 'inputText',
        text: `Wooi has no client executor for ${p.namespace ? `${p.namespace}/` : ''}${p.tool ?? 'this dynamic tool'}.`
      }
    ],
    success: false
  }
}

function prompt(
  params: unknown,
  request: Omit<PermissionRequest, 'requestId' | 'workspaceId'>
): Promise<PermissionDecision> {
  return new Promise<PermissionDecision>((resolve) => {
    const requestId = randomUUID()
    pendingApprovals.set(requestId, resolve)
    post({
      type: 'permissionRequest',
      request: { ...request, requestId, workspaceId: workspaceFor(params) }
    })
  })
}

/** 서버가 요청을 거둬들였을 때 — 프롬프트를 닫고 대기를 거절로 푼다. */
function closeApproval(requestId: string): void {
  const resolve = pendingApprovals.get(requestId)
  if (!resolve) return
  pendingApprovals.delete(requestId)
  post({ type: 'permissionCancel', requestId })
  resolve({ behavior: 'deny' })
}

/** 대기 중인 승인을 모두 거절로 풀고 렌더러의 프롬프트를 거둔다. */
function clearApprovals(): void {
  for (const [requestId, resolve] of pendingApprovals) {
    post({ type: 'permissionCancel', requestId })
    resolve({ behavior: 'deny' })
  }
  pendingApprovals.clear()
}

/** 승인 요청의 threadId 로 워크스페이스를 되찾는다. 못 찾으면 빈 문자열. */
function workspaceFor(params: unknown): string {
  const threadId = (params as { threadId?: string })?.threadId
  if (!threadId) return ''
  for (const [workspaceId, thread] of threads) {
    if (thread.owns(threadId)) return workspaceId
  }
  return ''
}

// ── 스레드 수명주기 ─────────────────────────────────────────────────────

function ensure(workspaceId: string, config: CodexConfig): CodexThread {
  const existing = threads.get(workspaceId)
  if (existing) {
    existing.update(config)
    return existing
  }

  const thread = new CodexThread(workspaceId, config, {
    rpc,
    emit: (event: ChatEvent) => post({ type: 'event', workspaceId, event }),
    persist: (item: ChatItem) => post({ type: 'persist', workspaceId, item }),
    onThreadId: (sessionId: string) => post({ type: 'sessionId', workspaceId, sessionId }),
    onRateLimit: () => post({ type: 'rateLimit', workspaceId }),
    settleIdle: () => post({ type: 'settleIdle', workspaceId })
  })
  threads.set(workspaceId, thread)
  return thread
}

function dispose(workspaceId: string): void {
  threads.get(workspaceId)?.dispose()
  threads.delete(workspaceId)
}

/** app-server 가 죽었다 — 대기 중이던 승인을 풀고 진행 중 워크스페이스를 idle 로 되돌린다. */
function onServerExit(code: number | null): void {
  log.error(`codex app-server exited (${code}); recovering`)
  server = null
  clearApprovals()
  for (const workspaceId of threads.keys()) post({ type: 'settleIdle', workspaceId })
  // 스레드 객체는 유지한다 — threadId 가 남아 있어 다음 메시지가 resume 으로 이어진다.
}

// ── 명령 처리 ───────────────────────────────────────────────────────────

async function handle(msg: CodexCommand): Promise<void> {
  switch (msg.type) {
    case 'prewarm':
      await rpc().catch((err) =>
        log.warn(`codex: prewarm failed: ${err instanceof Error ? err.message : String(err)}`)
      )
      break

    case 'send':
      await ensure(msg.workspaceId, msg.config).send(
        msg.text,
        msg.images,
        { prefix: msg.prefix, silent: msg.silent, origin: msg.origin },
        msg.skill
      )
      break

    case 'interrupt':
      await threads.get(msg.workspaceId)?.interrupt()
      break

    case 'setPermissionMode':
      // 모드는 다음 턴의 정책으로 반영된다(codex 는 턴 파라미터로 정책을 받는다).
      threads.get(msg.workspaceId)?.setPermissionMode(msg.mode)
      break

    case 'goalSet':
      await respond(msg.reqId, () =>
        ensure(msg.workspaceId, msg.config).setGoal({
          objective: msg.objective,
          status: msg.status,
          tokenBudget: msg.tokenBudget
        })
      )
      break

    case 'goalGet':
      await respond(msg.reqId, () => ensure(msg.workspaceId, msg.config).getGoal())
      break

    case 'goalClear':
      await respond(msg.reqId, () => ensure(msg.workspaceId, msg.config).clearGoal())
      break

    case 'dispose':
      dispose(msg.workspaceId)
      break

    case 'disposeAll':
      for (const workspaceId of [...threads.keys()]) dispose(workspaceId)
      clearApprovals()
      server?.dispose()
      server = null
      break

    case 'permissionResponse': {
      const resolve = pendingApprovals.get(msg.requestId)
      if (resolve) {
        pendingApprovals.delete(msg.requestId)
        resolve(msg.decision)
      }
      break
    }

    case 'listModels':
      await respond(msg.reqId, listModels)
      break

    case 'listSkills':
      await respond(msg.reqId, async () => {
        const result = await (await rpc()).request(RPC.skillsList, { cwds: [msg.cwd] })
        return result
      })
      break

    case 'runCommand':
      await respond(msg.reqId, () => runCommand(msg.workspaceId, msg.kind))
      break

    case 'mcpAction':
      await respond(msg.reqId, () => mcpAction(msg.serverName, msg.action))
      break

    case 'mcpConfigList':
      await respond(msg.reqId, listConfiguredMcpServers)
      break

    case 'mcpSetEnabled':
      await respond(msg.reqId, () => setMcpServerEnabled(msg.serverName, msg.enabled))
      break

    case 'mcpOauthLogin':
      await respond(msg.reqId, () => loginMcpServer(msg.serverName))
      break

    case 'pluginList':
      await respond(msg.reqId, () => listPlugins(msg.cwds))
      break

    case 'pluginRead':
      await respond(msg.reqId, () => readPlugin(msg.ref))
      break

    case 'compact':
      await ensure(msg.workspaceId, msg.config).compact()
      break

    case 'review':
      await ensure(msg.workspaceId, msg.config).review()
      break

    case 'shell':
      await ensure(msg.workspaceId, msg.config).shell(msg.command)
      break

    case 'fork':
      await ensure(msg.workspaceId, msg.config).fork()
      break

    case 'accountStatus':
      await respond(msg.reqId, accountStatus)
      break

    case 'rateLimits':
      await respond(msg.reqId, rateLimits)
      break

    case 'loginStart':
      await respond(msg.reqId, () => loginStart(msg.method, msg.apiKey))
      break

    case 'loginCancel':
      await cancelLogin()
      break

    case 'logout':
      await respond(msg.reqId, logout)
      break
  }
}

/** 요청-응답 명령을 실행하고 결과/오류를 reqId 로 회신한다. */
async function respond(reqId: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    post({ type: 'response', reqId, ok: true, data: await fn() })
  } catch (err) {
    post({
      type: 'response',
      reqId,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

// ── 계정 ────────────────────────────────────────────────────────────────

/** 진행 중인 ChatGPT 로그인의 loginId. 취소에 쓴다. */
let pendingLoginId: string | null = null

/**
 * 설치·로그인 상태.
 *
 * 설치 확인은 app-server 없이도 되지만, 로그인 여부는 app-server 의 `account/read` 가 정본이다 —
 * 자격증명이 파일이 아니라 OS 키체인에 있을 수 있어(config 의 cli_auth_credentials_store)
 * 파일 존재 여부로는 판단할 수 없다.
 */
async function accountStatus(): Promise<AgentAuthStatus> {
  const install = await detectCodex()
  if (!install.path) return { installed: false, loggedIn: false }
  if (!install.usable) {
    return {
      installed: true,
      loggedIn: false,
      version: install.version ?? undefined,
      error: install.reason
    }
  }

  try {
    const client = await rpc()
    const result = await client.request<AccountReadResult>(RPC.accountRead, { refreshToken: false })
    const account = result?.account
    return {
      installed: true,
      version: install.version ?? undefined,
      loggedIn: !!account,
      email: account?.email ?? undefined,
      planType: account?.planType ?? undefined,
      authMethod: account?.type
    }
  } catch (err) {
    // app-server 를 못 띄웠거나 조회가 실패했다 — "미설치"가 아니라 "상태 불명"으로 보고한다.
    return {
      installed: true,
      loggedIn: false,
      version: install.version ?? undefined,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/** ChatGPT 플랜 사용량. API 키 인증이면 rate limit 개념이 없어 null 이 온다. */
async function rateLimits(): Promise<RateLimitsResult['rateLimits'] | null> {
  const client = await rpc()
  const result = await client.tryRequest<RateLimitsResult>(RPC.rateLimitsRead, {})
  return result?.rateLimits ?? null
}

/**
 * 로그인을 시작한다.
 *
 * ChatGPT 방식은 app-server 가 **콜백 서버까지 직접 호스팅**하므로 우리는 authUrl 을 열어 주고
 * `account/login/completed` 알림만 기다리면 된다 — Claude 처럼 PTY 출력을 파싱할 필요가 없다.
 */
async function loginStart(method: CodexLoginMethod, apiKey?: string): Promise<void> {
  const client = await rpc()

  if (method === 'apiKey') {
    if (!apiKey?.trim()) throw new Error('An API key is required.')
    await client.request(RPC.accountLoginStart, { type: 'apiKey', apiKey: apiKey.trim() })
    // API 키는 왕복 한 번으로 끝난다 — 알림을 기다리지 않고 바로 완료로 알린다.
    post({ type: 'login', update: { phase: 'done', success: true } })
    post({ type: 'accountChanged' })
    return
  }

  const result = await client.request<{ loginId?: string; authUrl?: string }>(
    RPC.accountLoginStart,
    { type: 'chatgpt' }
  )
  pendingLoginId = result?.loginId ?? null
  if (!result?.authUrl) throw new Error('Codex did not return a sign-in URL.')
  post({ type: 'login', update: { phase: 'awaiting-browser', url: result.authUrl } })
}

async function cancelLogin(): Promise<void> {
  const loginId = pendingLoginId
  pendingLoginId = null
  if (!loginId) return
  try {
    const client = await rpc()
    await client.tryRequest(RPC.accountLoginCancel, { loginId })
  } catch (err) {
    log.warn(`codex: login cancel failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function logout(): Promise<void> {
  const client = await rpc()
  await client.request(RPC.accountLogout, {})
}

// ── 인터랙티브 명령 카드 ────────────────────────────────────────────────

/**
 * /context·/usage·/permissions 카드용 데이터.
 *
 * Claude 는 SDK 제어 메서드로 물어보지만, Codex 는 그런 조회 API 가 없다 — 대신 턴 알림으로
 * 흘러온 값(토큰 사용량)과 계정 API(rate limit), 그리고 우리가 계산한 정책을 조합해 만든다.
 * 지원 목록은 CODEX_META.capabilities.interactiveCommands 가 SSOT 이고, 오케스트레이터가
 * 그 목록으로 먼저 가드하므로 여기 도달하는 kind 는 셋 중 하나다.
 */
async function runCommand(workspaceId: string, kind: CommandPanelKind): Promise<CommandResult> {
  const thread = threads.get(workspaceId)

  if (kind === 'mcp') return { kind: 'mcp', servers: await listMcpServers() }

  if (kind === 'context') {
    const usage = thread?.contextUsage()
    if (!usage) {
      throw new Error('No context usage yet — send a message first.')
    }
    const effective = await readEffectiveConfig(thread?.currentCwd())
    return {
      kind: 'context',
      context: {
        totalTokens: usage.usedTokens,
        maxTokens: usage.maxTokens,
        percentage: Math.round(usage.percentage * 100),
        model: thread?.currentModel() ?? effective.model ?? 'default',
        // Codex 는 카테고리별 분해를 주지 않는다 — 합계만 한 항목으로 보여 준다.
        categories: [{ name: 'Conversation', tokens: usage.usedTokens }]
      }
    }
  }

  if (kind === 'usage') {
    const limits = await rateLimits()
    const windows = [
      toWindow('Primary', limits?.primary),
      toWindow('Secondary', limits?.secondary)
    ].filter((w): w is NonNullable<typeof w> => w !== null)
    const account = await accountStatus()
    return {
      kind: 'usage',
      usage: {
        // Codex 는 턴별 USD 원가를 알려 주지 않는다.
        totalCostUsd: 0,
        linesAdded: 0,
        linesRemoved: 0,
        subscriptionType: account.planType ?? null,
        rateLimitsAvailable: windows.length > 0,
        rateLimits: windows,
        // Codex 에는 "한도 초과분 크레딧 지갑" 개념이 없다(플랜 창만 있다).
        extraUsage: null
      }
    }
  }

  // permissions — Wooi 의 turn override 와 Codex 의 effective config 를 함께 보여 준다.
  const mode = thread?.currentMode() ?? 'default'
  const policy = turnPolicyFor(mode, thread?.currentCwd() ?? '')
  const effective = await readEffectiveConfig(thread?.currentCwd())
  return {
    kind: 'permissions',
    permissions: {
      mode,
      allow: describeSandbox(policy.sandboxPolicy),
      ask:
        policy.approvalPolicy === 'never'
          ? []
          : [
              `Anything outside the sandbox (${effective.approval_policy ?? policy.approvalPolicy})`
            ],
      deny: [],
      sources: effective.sources
    }
  }
}

async function readEffectiveConfig(cwd?: string): Promise<{
  model?: string | null
  approval_policy?: string | null
  sources: string[]
}> {
  const client = await rpc()
  const result = await client.request<{
    config?: { model?: string | null; approval_policy?: string | null }
    layers?: Array<{ source?: unknown; filePath?: string | null }>
  }>(RPC.configRead, { cwd: cwd || undefined, includeLayers: true })
  const sources = (result.layers ?? [])
    .map((layer) => layer.filePath ?? (layer.source ? JSON.stringify(layer.source) : ''))
    .filter(Boolean) as string[]
  return { ...result.config, sources }
}

async function listMcpServers(): Promise<McpServerInfo[]> {
  const client = await rpc()
  const result = await client.request<{
    data?: Array<{
      name?: string
      serverInfo?: { version?: string | null }
      tools?: Record<string, { description?: string }>
      authStatus?: string
    }>
  }>(RPC.mcpStatusList, { limit: 100 })
  return (result.data ?? []).map((server) => {
    const tools = Object.entries(server.tools ?? {}).map(([name, tool]) => ({
      name,
      description: tool.description
    }))
    return {
      name: server.name ?? 'mcp',
      status:
        server.authStatus === 'notLoggedIn'
          ? ('needs-auth' as const)
          : server.serverInfo
            ? ('connected' as const)
            : ('failed' as const),
      toolCount: tools.length,
      tools,
      version: server.serverInfo?.version ?? undefined,
      error: server.serverInfo ? undefined : 'Server did not initialize.'
    }
  })
}

async function mcpAction(serverName: string, action: McpAction): Promise<McpServerInfo[]> {
  const client = await rpc()
  if (action === 'enable' || action === 'disable') {
    await client.request(RPC.configValueWrite, {
      keyPath: `mcp_servers.${serverName}.enabled`,
      value: action === 'enable',
      mergeStrategy: 'replace'
    })
  }
  await client.request(RPC.mcpReload, {})
  return listMcpServers()
}

/**
 * 설정 화면용 — `~/.codex/config.toml` 에 **설정된** MCP 서버 목록.
 *
 * `/mcp` 패널이 쓰는 mcpServerStatus/list 와 다른 것을 본다. 그쪽은 런타임 상태라 꺼 둔 서버가
 * "초기화 실패" 로 보이거나 아예 빠지고, 그러면 설정 화면에서 다시 켤 방법이 사라진다.
 * config/read 는 `enabled: false` 인 항목까지 그대로 돌려주므로 토글의 근거로 맞다.
 *
 * Wooi 가 `-c` 로 밀어 넣은 서버도 이 응답에 섞여 온다(실측) — 그건 사용자의 파일에 있는 것이
 * 아니라 우리가 이번 프로세스에만 얹은 것이므로 걸러낸다. 그러지 않으면 설정 화면에 같은
 * 서버가 "Wooi 관리" 와 "Codex 설정" 양쪽에 두 번 나온다.
 */
async function listConfiguredMcpServers(): Promise<CodexMcpServer[]> {
  const client = await rpc()
  const [result, authStatuses] = await Promise.all([
    client.request<{
      config?: { mcp_servers?: Record<string, Record<string, unknown>> }
    }>(RPC.configRead, { includeLayers: false }),
    listMcpAuthStatuses(client)
  ])
  const ours = new Set([WOOI_MCP_SERVER_NAME, ...Object.keys(wooiMcpServerTable())])
  return Object.entries(result.config?.mcp_servers ?? {})
    .filter(([name]) => !ours.has(name))
    .map(([name, server]) => ({
      name,
      detail: describeCodexMcpServer(server),
      // codex 기본값은 "켜짐" 이다 — 키가 없다고 꺼진 것으로 그리면 전부 꺼진 것처럼 보인다.
      enabled: server.enabled !== false,
      authStatus: authStatuses.get(name) ?? 'unknown'
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** 런타임 목록에 없거나 새 상태가 온 서버는 unknown 으로 남겨, 로그인 필요로 오판하지 않는다. */
async function listMcpAuthStatuses(
  client: RpcClient
): Promise<Map<string, CodexMcpServer['authStatus']>> {
  const statuses = new Map<string, CodexMcpServer['authStatus']>()
  let cursor: string | null = null
  do {
    const page: {
      data?: Array<{ name?: string; authStatus?: string }>
      nextCursor?: string | null
    } = await client.request(RPC.mcpStatusList, { cursor, detail: 'toolsAndAuthOnly', limit: 100 })
    for (const server of page.data ?? []) {
      if (server.name) statuses.set(server.name, normalizeMcpAuthStatus(server.authStatus))
    }
    cursor = page.nextCursor ?? null
  } while (cursor)
  return statuses
}

/** 목록의 한 줄 요약. stdio 는 명령줄, 원격은 URL. */
function describeCodexMcpServer(server: Record<string, unknown>): string {
  if (typeof server.url === 'string') return server.url
  if (typeof server.command !== 'string') return ''
  const args = Array.isArray(server.args) ? server.args.filter((a) => typeof a === 'string') : []
  return [server.command, ...args].join(' ')
}

/**
 * 서버 하나를 켜고 끈다. **사용자의 config.toml 에 직접 쓴다** — Claude 쪽(~/.claude.json)은
 * 우리가 절대 쓰지 않고 주입 단계에서 빼지만, codex 는 자기 설정을 스스로 읽으므로 그 방법이
 * 없다. 쓰고 나서 reload 해야 이미 떠 있는 app-server 에 반영된다.
 */
async function setMcpServerEnabled(
  serverName: string,
  enabled: boolean
): Promise<CodexMcpServer[]> {
  const client = await rpc()
  await client.request(RPC.configValueWrite, {
    keyPath: `mcp_servers.${serverName}.enabled`,
    value: enabled,
    mergeStrategy: 'replace'
  })
  await client.request(RPC.mcpReload, {})
  return listConfiguredMcpServers()
}

/** OAuth 완료는 별도 알림으로 오므로 이 요청은 브라우저를 열 URL 까지만 책임진다. */
async function loginMcpServer(serverName: string): Promise<string> {
  const result = await (
    await rpc()
  ).request<{ authorizationUrl?: string }>(RPC.mcpOauthLogin, {
    name: serverName
  })
  if (!result.authorizationUrl) throw new Error('Codex did not return an authorization URL.')
  return result.authorizationUrl
}

/**
 * 설정 화면용 — 이 설치본에 깔린 Agent Plugins.
 *
 * `plugin/list` 가 아니라 `plugin/installed` 를 부른다. 이름은 비슷하지만 전자는 원격 카탈로그를
 * 포함한 **전체 목록**이라 실측에서 2,500개가 넘게 왔다 — 설치된 것을 보여 주는 화면이 그걸
 * 받으면 느릴 뿐 아니라 틀린다.
 *
 * `cwds` 는 리포 안에 든 마켓플레이스(`.agents/plugins/marketplace.json`)를 찾는 데 쓰인다.
 * 메인이 등록된 리포 경로를 넘겨 준다 — 워크스페이스가 아니라 설치 단위 조회이므로 여기서
 * 알아낼 방법이 없다.
 *
 * tryRequest 인 이유: `plugin/*` 는 codex 0.146 부터다. 그 전 버전에서 -32601 을 던지면 설정
 * 화면 전체가 오류로 덮이는데, 우리가 알려야 할 것은 "이 버전은 플러그인을 모른다" 하나다.
 */
async function listPlugins(cwds: string[]): Promise<CodexPluginInventory> {
  const client = await rpc()
  const response = await client.tryRequest<PluginsResponse>(RPC.pluginInstalled, {
    cwds: cwds.length > 0 ? cwds : null
  })
  return toPluginInventory(response)
}

/**
 * 플러그인 하나가 무엇을 싣고 있는지. 목록 행을 펼칠 때만 부른다 — 설치된 플러그인마다 미리
 * 부르면 목록 한 번에 왕복이 수십 번 생긴다.
 *
 * `marketplacePath` 와 `remoteMarketplaceName` 중 **정확히 하나**만 실어야 한다(둘 다 보내면
 * -32600). 로컬 마켓플레이스는 경로를 갖고, 원격 카탈로그는 경로가 없어 이름으로 지칭한다.
 */
async function readPlugin(ref: CodexPluginRef): Promise<CodexPluginDetail> {
  const client = await rpc()
  const response = await client.tryRequest<PluginReadResponse>(RPC.pluginRead, {
    pluginName: ref.pluginName,
    ...(ref.marketplacePath
      ? { marketplacePath: ref.marketplacePath }
      : { remoteMarketplaceName: ref.marketplaceName })
  })
  return toPluginDetail(response?.plugin)
}

/** rate limit 창 하나를 UsageInfo 모양으로. 데이터가 없으면 null. */
function toWindow(
  fallbackLabel: string,
  window:
    { usedPercent?: number; resetsAt?: number; windowDurationMins?: number } | null | undefined
): { label: string; utilization: number | null; resetsAt: string | null } | null {
  if (!window || window.usedPercent === undefined) return null
  return {
    label: durationLabel(window.windowDurationMins, fallbackLabel),
    utilization: window.usedPercent,
    resetsAt: window.resetsAt ? new Date(window.resetsAt * 1000).toISOString() : null
  }
}

/** 샌드박스 정책을 사람이 읽는 허용 목록으로. */
function describeSandbox(policy: SandboxPolicy): string[] {
  if (policy.type === 'dangerFullAccess') {
    return ['Read anywhere', 'Write anywhere', 'Run any command', 'Network access']
  }
  if (policy.type === 'readOnly') return ['Read files']
  return [
    'Read files',
    ...policy.writableRoots.map((root) => `Write under ${root}`),
    'Run commands in the workspace',
    ...(policy.networkAccess ? ['Network access'] : [])
  ]
}

/** codex 카탈로그의 모델 목록. 모델별 지원 effort 까지 함께 내려 UI 가 좁힐 수 있게 한다. */
async function listModels(): Promise<ModelOption[]> {
  const client = await rpc()
  const result = await client.tryRequest<ModelListResult>(RPC.modelList, { includeHidden: false })
  return (result?.data ?? [])
    .filter((m): m is typeof m & { id: string } => !!m.id && !m.hidden)
    .map((m) => ({
      id: m.id,
      label: m.displayName || m.id,
      efforts: m.supportedReasoningEfforts
        ?.map((e) => e.reasoningEffort)
        .filter((e): e is string => !!e) as ModelOption['efforts'],
      ...(m.serviceTiers?.some((tier) => tier.id === 'fast') ? { fastMode: true as const } : {})
    }))
}

port.on('message', (e: { data: CodexCommand }) => {
  void handle(e.data).catch((err) => log.error('codex-host command failed', err))
})

// 앱이 어떤 경로로 종료되든 app-server 자식이 고아로 남지 않게 한다.
process.on('exit', () => server?.dispose())

log.info('codex-host ready')
