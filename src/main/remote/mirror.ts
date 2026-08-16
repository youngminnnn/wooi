import type { SupabaseClient } from '@supabase/supabase-js'
import { deriveDirectionKeys, fromBase64Url, sealJson } from '@shared/crypto'
import type { RemoteMachine, RemotePr, RemoteRateLimit, RemoteState } from '@shared/remote'
import type { AgentBackendId, AppState, PermissionMode, PermissionRequest } from '@shared/types'
import { backendMeta } from '../agent/backend'
import { getCachedPrStatus } from '../prStatusCache'
import { log } from '../logger'
import type { RemoteKeystore } from './keystore'

export const MIRROR_DEBOUNCE_MS = 400

/**
 * 이 조합에서 에이전트가 **묻지 않고 실행**하는가.
 *
 * 모드 이름은 백엔드마다 뜻이 다르다. Claude 의 'default' 는 도구를 쓸 때마다 묻지만,
 * Codex 의 'default' 는 워크스페이스 안에서는 묻지 않고 편집·실행한다. 폰은 백엔드를
 * 모르므로 이 판단은 여기서 해서 투영에 실어 보낸다.
 *
 * 새 모드를 추가할 때 여기 빠뜨리면 **묻는 것으로 취급된다** — 그쪽이 안전한 실패가
 * 아니므로(마찰이 아니라 방어가 사라진다) 모드를 늘릴 때 이 함수를 같이 본다.
 */
export function actsWithoutAsking(backend: AgentBackendId, mode: PermissionMode): boolean {
  // 읽기 전용은 애초에 아무것도 실행하지 못한다.
  if (mode === 'plan' || mode === 'readOnly') return false
  // 분류기가 대신 승인하거나(auto), 승인 자체가 없다(fullAccess).
  if (mode === 'auto' || mode === 'fullAccess') return true
  // 파일 편집이 프롬프트 없이 그대로 적용된다.
  if (mode === 'acceptEdits') return true
  // 'default' 만 남는다 — 여기서 백엔드가 갈린다.
  return backend === 'codex'
}

/**
 * 사용량 제한 상태를 폰이 읽을 모양으로 줄인다.
 *
 * 자동 이어가기가 예약돼 있으면 그것이 우선이다 — 사용자가 알아야 할 것은 "언제 다시
 * 시작하는가"이고, 그게 없을 때에야 "멈춰 있고 내가 다시 눌러야 한다"가 된다.
 */
export function projectRateLimit(workspace: {
  pendingRateLimitResume?: { retryAt: number } | null
  rateLimited?: { resetsAt?: number | null } | null
}): RemoteRateLimit | null {
  const resume = workspace.pendingRateLimitResume
  if (resume) return { kind: 'resuming', at: resume.retryAt }
  const paused = workspace.rateLimited
  if (paused) return { kind: 'paused', at: paused.resetsAt ?? null }
  return null
}

/**
 * 컴포저 아래 모드 표시. 데스크톱과 같은 서술자에서 뽑으므로 두 화면이 갈리지 않는다.
 * 모르는 모드거나 표시할 것이 없으면 null — 그때 데스크톱도 아무것도 띄우지 않는다.
 */
export function projectPermissionModeFooter(
  backend: AgentBackendId,
  mode: PermissionMode
): { symbol: string; text: string } | null {
  const info = backendMeta(backend).permissionModes.find((item) => item.id === mode)
  return info?.footer ?? null
}

/**
 * PR 상태. 아직 조회된 적이 없으면 `undefined` 를 그대로 흘려보낸다 — 모르는 것을 "없음"으로
 * 단정하지 않기 위해서다(폰은 그동안 PR 색을 칠하지 않고 기다린다).
 */
export function projectPr(workspaceId: string): RemotePr | null | undefined {
  const status = getCachedPrStatus(workspaceId)
  if (status === undefined) return undefined
  if (status === null) return null
  return { number: status.number, state: status.state, label: status.label }
}

export function projectState(
  app: AppState,
  machine: RemoteMachine,
  pending: PermissionRequest[]
): RemoteState {
  const pendingWorkspaceIds = new Set(pending.map((request) => request.workspaceId))
  return {
    rev: 0,
    machine: {
      id: machine.id,
      name: machine.name,
      appVersion: machine.appVersion
    },
    repos: app.repos.map((repo) => ({
      id: repo.id,
      name: repo.name
    })),
    workspaces: app.workspaces.map((workspace) => ({
      id: workspace.id,
      repoId: workspace.repoId,
      name: workspace.name,
      displayName: workspace.displayName,
      branch: workspace.branch,
      status: workspace.status,
      permissionMode: workspace.permissionMode,
      model: workspace.model,
      effort: workspace.effort,
      archived: workspace.archived,
      muted: workspace.muted ?? false,
      prNumber: workspace.prNumber,
      lastActiveAt: workspace.lastActiveAt,
      attention: pendingWorkspaceIds.has(workspace.id)
        ? 'permission'
        : workspace.status === 'error'
          ? 'error'
          : null,
      actsWithoutAsking: actsWithoutAsking(workspace.agentBackend, workspace.permissionMode),
      agentBackend: workspace.agentBackend,
      multiAgent: workspace.multiAgent === true,
      parentWorkspaceId: workspace.parentWorkspaceId,
      rateLimit: projectRateLimit(workspace),
      permissionModeFooter: projectPermissionModeFooter(
        workspace.agentBackend,
        workspace.permissionMode
      ),
      pr: projectPr(workspace.id)
    })),
    pendingPermissions: pending.map((request) => ({
      requestId: request.requestId,
      workspaceId: request.workspaceId,
      toolName: request.toolName,
      title: request.title,
      displayName: request.displayName,
      input: request.input,
      decisionReason: request.decisionReason,
      kind: request.kind,
      diff: request.diff,
      rule: request.rule,
      options: request.options
    }))
  }
}

export interface StateMirrorOptions {
  supabase: () => SupabaseClient
  keystore: RemoteKeystore
  machine: () => RemoteMachine
  /**
   * 발행 번호의 시작점. 기본값이 벽시계인 것이 중요하다 — 아래 `rev` 주석 참고.
   * 테스트만 고정값을 준다.
   */
  startRev?: number
}

export class StateMirror {
  private readonly options: StateMirrorOptions
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: { state: RemoteState; json: string } | null = null
  private lastPublishedJson: string | null = null
  /**
   * 발행 번호. 폰은 **뒤로 가는 rev 를 오래된 상태로 보고 버린다** — 그래야 두 refresh 가
   * 뒤바뀐 순서로 도착해도 최신을 덮어쓰지 않는다.
   *
   * 그래서 0 부터 세면 안 된다. 랩탑 앱을 재시작할 때마다 카운터가 0 으로 돌아가고, 폰은
   * 재시작 이후의 모든 상태를 "옛날 것"으로 판단해 조용히 버린다 — 화면은 재시작 직전에서
   * 멈추고, 새로 뜬 권한 요청이 폰에 영영 나타나지 않는다(실기기에서 정확히 그랬다).
   *
   * 벽시계(ms)로 시작하면 프로세스가 바뀌어도 항상 커진다. 컬럼은 bigint 라 자리도 넉넉하다.
   */
  private rev: number
  private disposed = false

  constructor(options: StateMirrorOptions) {
    this.options = options
    this.rev = options.startRev ?? Date.now()
  }

  publish(app: AppState, pending: PermissionRequest[]): void {
    if (this.disposed) return
    try {
      const state = projectState(app, this.options.machine(), pending)
      const json = JSON.stringify(state)
      if (json === this.lastPublishedJson) return
      this.pending = { state, json }
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => {
        this.timer = null
        void this.flush()
      }, MIRROR_DEBOUNCE_MS)
      this.timer.unref?.()
    } catch (err) {
      log.error('원격 상태 투영 실패', errorText(err))
    }
  }

  /**
   * 중복 제거와 디바운스를 건너뛰고 즉시 발행한다.
   *
   * 새로 페어링된 기기를 위한 것이다. 그 기기는 직전 발행의 수신자가 아니었으므로
   * 릴레이에는 그 기기가 열 수 있는 암호문이 없는데, 투영 내용은 직전과 같아서
   * 일반 publish 는 "바뀐 게 없다"며 걸러 버린다.
   */
  publishNow(app: AppState, pending: PermissionRequest[]): void {
    if (this.disposed) return
    try {
      const state = projectState(app, this.options.machine(), pending)
      this.pending = { state, json: JSON.stringify(state) }
      this.lastPublishedJson = null
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
      void this.flush()
    } catch (err) {
      log.error('원격 상태 즉시 발행 실패', errorText(err))
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending = null
  }

  private async flush(): Promise<void> {
    const snapshot = this.pending
    this.pending = null
    if (!snapshot || this.disposed) return

    const rev = ++this.rev
    const state = { ...snapshot.state, rev }
    try {
      // 기기마다 자기 키로 봉인해 자기 행에 올린다(0006 이 PK 를 machine_id+device_id 로 넓혔다).
      // 상태는 기기별 키로 봉인되므로 한 행을 공유할 수 없다 — 공유하면 나중에 봉인한 쪽이
      // 앞 기기가 열 수 없는 암호문으로 행을 덮어쓴다.
      const devices = this.options.keystore.listDevices()
      if (devices.length === 0) return

      const rows = devices.map((device) => {
        const header = {
          v: 1,
          machineId: state.machine.id,
          deviceId: device.deviceId,
          kind: 'state'
        } as const
        const { laptopToPhone } = deriveDirectionKeys(
          fromBase64Url(device.sessionKey),
          device.deviceId
        )
        const box = sealJson(laptopToPhone, header, state)
        return {
          machine_id: state.machine.id,
          device_id: device.deviceId,
          rev,
          nonce: toPgBytea(box.nonce),
          state_ct: toPgBytea(box.ct),
          updated_at: new Date().toISOString()
        }
      })

      if (this.disposed) return
      const { error } = await this.options
        .supabase()
        .from('machine_state')
        .upsert(rows, { onConflict: 'machine_id,device_id' })
      if (error) throw error
      this.lastPublishedJson = snapshot.json
    } catch (err) {
      log.error('원격 상태 게시 실패', errorText(err))
    }
  }
}

/**
 * bytea 컬럼에 넣을 수 있는 형식으로 바꾼다 — `\x` 접두사 + 소문자 hex.
 *
 * `Uint8Array` 를 그대로 넘기면 안 된다. supabase-js 는 본문을 JSON 으로 직렬화하는데
 * `JSON.stringify(new Uint8Array([1,2]))` 는 배열이 아니라 **객체** `{"0":1,"1":2}` 가 되고,
 * Postgres 는 그 문자들을 그대로 바이트로 저장한다. 그러면 24바이트 nonce 가 ~193바이트로
 * 부풀어 폰에서 "nonce must be 24 bytes" 로만 드러난다 — 실기기에서 실제로 겪은 실패다.
 */
function toPgBytea(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return `\\x${hex}`
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
