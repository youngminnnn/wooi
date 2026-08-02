import { randomUUID } from 'node:crypto'
import { log } from '../logger'
import { AppServer } from './appServer'
import { detectCodex } from './executable'
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
  type RateLimitsResult
} from './wire'
import type { CodexCommand, CodexConfig, CodexEvent, CodexLoginMethod } from './protocol'
import type {
  AgentAuthStatus,
  ChatEvent,
  ChatItem,
  CommandPanelKind,
  CommandResult,
  ModelOption,
  PermissionDecision,
  PermissionRequest
} from '@shared/types'
import type { RpcClient } from './jsonrpc'

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

/** 공유 app-server 연결. 처음 필요할 때 codex 를 찾아 띄운다. */
async function rpc(): Promise<RpcClient> {
  if (!server) {
    const install = await detectCodex()
    if (!install.path || !install.usable) {
      throw new Error(install.reason ?? 'Codex CLI is not available')
    }
    server = new AppServer({
      executable: install.path,
      onNotification: routeNotification,
      requestHandlers: {
        [SERVER_REQUEST.commandApproval]: (params) => approve(params, mapCommandApproval),
        [SERVER_REQUEST.fileChangeApproval]: (params) => approveFileChange(params),
        [SERVER_REQUEST.requestUserInput]: (params) => answer(params)
      },
      onExit: onServerExit
    })
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
async function approve(params: unknown, toRequest: ApprovalMapper): Promise<{ decision: string }> {
  const decision = await prompt(params, toRequest(params as never))
  return { decision: toCodexDecision(decision) }
}

/**
 * 파일 변경 승인 — 요청에 diff 가 없으므로, 같은 itemId 의 fileChange 아이템에서 꺼내 붙인다.
 * 그래야 사용자가 무엇을 승인하는지 보고 결정할 수 있다.
 */
async function approveFileChange(params: unknown): Promise<{ decision: string }> {
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
    case 'send':
      await ensure(msg.workspaceId, msg.config).send(msg.text, msg.images)
      break

    case 'interrupt':
      await threads.get(msg.workspaceId)?.interrupt()
      break

    case 'setPermissionMode':
      // 모드는 다음 턴의 정책으로 반영된다(codex 는 턴 파라미터로 정책을 받는다).
      threads.get(msg.workspaceId)?.setPermissionMode(msg.mode)
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

    case 'runCommand':
      await respond(msg.reqId, () => runCommand(msg.workspaceId, msg.kind))
      break

    case 'compact':
      await threads.get(msg.workspaceId)?.compact()
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

  if (kind === 'context') {
    const usage = thread?.contextUsage()
    if (!usage) {
      throw new Error('No context usage yet — send a message first.')
    }
    return {
      kind: 'context',
      context: {
        totalTokens: usage.usedTokens,
        maxTokens: usage.maxTokens,
        percentage: Math.round(usage.percentage * 100),
        model: thread?.currentModel() ?? 'default',
        // Codex 는 카테고리별 분해를 주지 않는다 — 합계만 한 항목으로 보여 준다.
        categories: [{ name: 'Conversation', tokens: usage.usedTokens }]
      }
    }
  }

  if (kind === 'usage') {
    const limits = await rateLimits()
    const windows = [
      toWindow('5-hour', limits?.primary),
      toWindow('Weekly', limits?.secondary)
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

  // permissions — 현재 모드와 그 모드가 실제로 무엇을 허용하는지 보여 준다.
  const mode = thread?.currentMode() ?? 'default'
  const policy = turnPolicyFor(mode, thread?.currentCwd() ?? '')
  return {
    kind: 'permissions',
    permissions: {
      mode,
      allow: describeSandbox(policy.sandboxPolicy),
      ask: policy.approvalPolicy === 'never' ? [] : ['Anything outside the sandbox'],
      deny: [],
      // Codex 는 규칙을 config.toml 에서 읽는다 — 출처를 알려 준다.
      sources: ['~/.codex/config.toml']
    }
  }
}

/** rate limit 창 하나를 UsageInfo 모양으로. 데이터가 없으면 null. */
function toWindow(
  label: string,
  window: { usedPercent?: number; resetsAt?: number } | null | undefined
): { label: string; utilization: number | null; resetsAt: string | null } | null {
  if (!window || window.usedPercent === undefined) return null
  return {
    label,
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
        .filter((e): e is string => !!e) as ModelOption['efforts']
    }))
}

port.on('message', (e: { data: CodexCommand }) => {
  void handle(e.data).catch((err) => log.error('codex-host command failed', err))
})

// 앱이 어떤 경로로 종료되든 app-server 자식이 고아로 남지 않게 한다.
process.on('exit', () => server?.dispose())

log.info('codex-host ready')
