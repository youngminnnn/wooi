import type { SupabaseClient } from '@supabase/supabase-js'
import { deriveDirectionKeys, fromBase64Url, sealJson } from '@shared/crypto'
import type { RemoteMachine, RemoteState } from '@shared/remote'
import type { AppState, PermissionRequest } from '@shared/types'
import { log } from '../logger'
import type { RemoteKeystore } from './keystore'

export const MIRROR_DEBOUNCE_MS = 400

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
          : null
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
}

export class StateMirror {
  private readonly options: StateMirrorOptions
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: { state: RemoteState; json: string } | null = null
  private lastPublishedJson: string | null = null
  private rev = 0
  private disposed = false

  constructor(options: StateMirrorOptions) {
    this.options = options
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
      // 현재 테이블은 machine_id 하나만 PK 라 기기별 암호문을 보존할 수 없다. 마지막 기기가
      // 앞선 행을 덮는 거짓 지원보다, 스키마가 device_id 를 키에 포함할 때까지 첫 기기만 지원한다.
      const device = this.options.keystore.listDevices()[0]
      if (!device) return
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
      if (this.disposed) return
      const { error } = await this.options
        .supabase()
        .from('machine_state')
        .upsert(
          {
            machine_id: state.machine.id,
            rev,
            nonce: toPgBytea(box.nonce),
            state_ct: toPgBytea(box.ct),
            updated_at: new Date().toISOString()
          },
          { onConflict: 'machine_id' }
        )
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
