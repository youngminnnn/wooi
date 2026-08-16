import { IPC } from '@shared/types'
import {
  REMOTE_IPC,
  REMOTE_MAX_PROMPT_BYTES,
  REMOTE_TRANSCRIPT_MAX_LIMIT,
  type RemoteTranscriptQuery
} from '@shared/remote'

/**
 * 원격(모바일)에서 호출할 수 있는 명령의 단일 출처. **기본 거부**다 —
 * 이 맵에 없는 채널은 브리지가 무조건 거절하고 감사 로그를 남긴다.
 *
 * 등록(commandRegistry.handle)과 노출(여기)을 일부러 분리했다. 새 IPC 핸들러를 추가하는 것만으로
 * 원격 표면이 넓어지면 안 되기 때문이다 — 넓히려면 이 파일을 고쳐야 하고, allowlist.test.ts 의
 * DENY 단언이 위험한 채널을 다시 막는다.
 */

/** 검증기가 참조하는 브리지 상태(순환 의존을 피하려고 함수로 주입받는다). */
export interface RemoteValidateContext {
  /**
   * 아직 응답되지 않은 권한 요청의 도구 이름. 모르면 undefined.
   * `updatedInput` 을 AskUserQuestion 에만 허용하기 위해 필요하다.
   */
  pendingPermissionTool: (requestId: string) => string | undefined
}

export interface RemoteCommandSpec {
  /**
   * 원격 인자를 검증·정규화한다. 부적합하면 throw — 통과한 값만 핸들러로 간다.
   * 반환값이 실제로 핸들러에 넘어가므로, 여기서 좁힌 것이 곧 원격이 할 수 있는 전부다.
   */
  readonly validate: (args: readonly unknown[], ctx: RemoteValidateContext) => unknown[]
  /** 부작용이 있는 명령인지 — 감사 로그·레이트리밋 대상. */
  readonly mutating: boolean
}

// ── 원시 검증기 ───────────────────────────────────────────────────────────

function fail(message: string): never {
  throw new Error(`remote command rejected: ${message}`)
}

function expectArity(args: readonly unknown[], min: number, max = min): void {
  if (args.length < min || args.length > max) {
    fail(`expected ${min === max ? min : `${min}..${max}`} args, got ${args.length}`)
  }
}

function asWorkspaceId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    fail('workspaceId must be a non-empty string ≤128 chars')
  }
  return value
}

function asRequestId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    fail('requestId must be a non-empty string ≤128 chars')
  }
  return value
}

function byteLength(text: string): number {
  // Node 도 RN 도 Buffer 를 기대하지 않게 TextEncoder 를 쓴다(이 파일은 main 전용이지만
  // 상한 상수를 shared 와 공유하므로 계산 방식도 같게 둔다).
  return new TextEncoder().encode(text).length
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ── 개별 명령 검증기 ──────────────────────────────────────────────────────

/** `permission:respond` — 원격 표면에서 가장 위험한 채널이라 가장 좁게 검증한다. */
function validatePermissionRespond(
  args: readonly unknown[],
  ctx: RemoteValidateContext
): unknown[] {
  expectArity(args, 2)
  const requestId = asRequestId(args[0])
  const decision = args[1]
  if (!isPlainObject(decision)) fail('decision must be an object')

  if (decision.behavior === 'deny') {
    // deny 는 다른 필드를 일절 받지 않는다 — 거절에 페이로드가 붙을 이유가 없다.
    if (Object.keys(decision).length !== 1) fail('deny decision must carry no other fields')
    return [requestId, { behavior: 'deny' }]
  }

  if (decision.behavior !== 'allow') fail('decision.behavior must be "allow" or "deny"')

  const remember = decision.rememberForSession
  if (remember !== undefined && typeof remember !== 'boolean') {
    fail('rememberForSession must be a boolean')
  }

  const allow: Record<string, unknown> = { behavior: 'allow' }
  if (remember !== undefined) allow.rememberForSession = remember

  if (decision.updatedInput !== undefined) {
    // updatedInput 은 도구 입력을 원격에서 **바꿔치기** 하는 통로다. AskUserQuestion 은 사용자의
    // 선택을 입력에 주입해야만 동작하므로 예외로 두고, 그 밖의 도구에서는 절대 허용하지 않는다
    // (예: Bash 의 command 를 갈아끼우는 원격 코드 실행).
    const tool = ctx.pendingPermissionTool(requestId)
    if (tool !== 'AskUserQuestion') {
      fail(`updatedInput is only allowed for AskUserQuestion (pending tool: ${tool ?? 'unknown'})`)
    }
    if (!isPlainObject(decision.updatedInput)) fail('updatedInput must be an object')
    allow.updatedInput = decision.updatedInput
  }

  return [requestId, allow]
}

/**
 * `workspace:setPermissionMode` — **다운그레이드 전용**.
 *
 * 원격에서 acceptEdits/auto 로 올릴 수 있으면, 폰 하나로 랩탑에서 무제한 자동 실행을 켤 수 있다.
 * 잠금 해제된 폰을 도난당한 시나리오에서 이게 곧 전면 침해가 된다. 낮추는 방향만 허용한다.
 */
function validateSetPermissionMode(args: readonly unknown[]): unknown[] {
  expectArity(args, 2)
  const workspaceId = asWorkspaceId(args[0])
  const mode = args[1]
  if (mode !== 'default' && mode !== 'plan') {
    fail(`permissionMode "${String(mode)}" cannot be set remotely (only "default" or "plan")`)
  }
  return [workspaceId, mode]
}

function validateChatSend(args: readonly unknown[]): unknown[] {
  // 이미지 첨부는 MVP 에서 받지 않는다 — base64 본문이 릴레이 예산을 삼키고,
  // 검증할 표면(미디어 타입·크기·디코딩)이 통째로 늘어난다.
  expectArity(args, 2)
  const workspaceId = asWorkspaceId(args[0])
  const text = args[1]
  if (typeof text !== 'string') fail('text must be a string')
  if (text.trim().length === 0) fail('text must not be blank')
  const bytes = byteLength(text)
  if (bytes > REMOTE_MAX_PROMPT_BYTES) {
    fail(`text is ${bytes} bytes, limit is ${REMOTE_MAX_PROMPT_BYTES}`)
  }
  // 세 번째 인자(images)를 명시적으로 넘기지 않는다 — 핸들러가 undefined 를 받게 한다.
  return [workspaceId, text]
}

function validateTranscript(args: readonly unknown[]): unknown[] {
  expectArity(args, 1, 2)
  const workspaceId = asWorkspaceId(args[0])
  const raw = args[1]
  const query: RemoteTranscriptQuery = { limit: REMOTE_TRANSCRIPT_MAX_LIMIT }
  if (raw !== undefined) {
    if (!isPlainObject(raw)) fail('query must be an object')
    if (raw.beforeTs !== undefined) {
      if (typeof raw.beforeTs !== 'number' || !Number.isFinite(raw.beforeTs)) {
        fail('beforeTs must be a finite number')
      }
      query.beforeTs = raw.beforeTs
    }
    if (raw.limit !== undefined) {
      if (typeof raw.limit !== 'number' || !Number.isInteger(raw.limit) || raw.limit < 1) {
        fail('limit must be a positive integer')
      }
      query.limit = Math.min(raw.limit, REMOTE_TRANSCRIPT_MAX_LIMIT)
    }
  }
  return [workspaceId, query]
}

function validateWatch(args: readonly unknown[]): unknown[] {
  expectArity(args, 1)
  if (args[0] === null) return [null]
  return [asWorkspaceId(args[0])]
}

function validateWorkspaceIdOnly(args: readonly unknown[]): unknown[] {
  expectArity(args, 1)
  return [asWorkspaceId(args[0])]
}

function validateSetMuted(args: readonly unknown[]): unknown[] {
  expectArity(args, 2)
  const workspaceId = asWorkspaceId(args[0])
  if (typeof args[1] !== 'boolean') fail('muted must be a boolean')
  return [workspaceId, args[1]]
}

function validateNoArgs(args: readonly unknown[]): unknown[] {
  expectArity(args, 0)
  return []
}

// ── 허용목록 ──────────────────────────────────────────────────────────────

export const REMOTE_COMMANDS: ReadonlyMap<string, RemoteCommandSpec> = new Map<
  string,
  RemoteCommandSpec
>([
  // 읽기
  [IPC.appGetState, { validate: validateNoArgs, mutating: false }],
  [IPC.chatGetHistory, { validate: validateWorkspaceIdOnly, mutating: false }],
  [REMOTE_IPC.transcript, { validate: validateTranscript, mutating: false }],
  [REMOTE_IPC.watch, { validate: validateWatch, mutating: false }],
  [REMOTE_IPC.ping, { validate: validateNoArgs, mutating: false }],

  // 쓰기
  [IPC.chatSend, { validate: validateChatSend, mutating: true }],
  [IPC.chatInterrupt, { validate: validateWorkspaceIdOnly, mutating: true }],
  [IPC.permissionRespond, { validate: validatePermissionRespond, mutating: true }],
  [IPC.workspaceSetPermissionMode, { validate: validateSetPermissionMode, mutating: true }],
  [IPC.workspaceSetMuted, { validate: validateSetMuted, mutating: true }],
  // 인자를 받지 않고 명령 행의 기기만 끊으므로 다른 기기를 지정할 수 없다.
  // 임의 기기를 받는 IPC.remoteRevokeDevice 는 이와 달리 영구 거부한다.
  [REMOTE_IPC.unpairSelf, { validate: validateNoArgs, mutating: true }]
])

/**
 * 원격 인자를 검증해 핸들러로 넘길 인자 배열을 돌려준다.
 * 허용목록에 없거나 검증에 실패하면 throw 한다.
 */
export function validateRemoteCommand(
  channel: string,
  args: readonly unknown[],
  ctx: RemoteValidateContext
): unknown[] {
  const spec = REMOTE_COMMANDS.get(channel)
  if (!spec) fail(`channel "${channel}" is not remotely invocable`)
  return spec.validate(args, ctx)
}

/** 이 채널이 부작용을 갖는지(감사 로그·레이트리밋 판단용). 미등록이면 true 로 보수적으로 답한다. */
export function isMutatingRemoteCommand(channel: string): boolean {
  return REMOTE_COMMANDS.get(channel)?.mutating ?? true
}
