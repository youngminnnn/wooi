import type { SupabaseClient } from '@supabase/supabase-js'
import { deriveDirectionKeys, fromBase64Url, sealJson, toBase64Url } from '@shared/crypto'
import type { NotificationEvent } from '@shared/types'
import { log } from '../logger'
import type { RemoteKeystore } from './keystore'

/**
 * 배너의 종류. 알림 **설정**의 이벤트(NotificationEvent)와 다르다 — 질문도 설정에서는
 * 'needsInput' 채널을 따르지만(사용자가 끄고 켜는 단위는 "입력이 필요함" 하나다), 배너에서는
 * 승인과 다른 말을 해야 한다. 폰은 승인은 Allow/Deny 로, 질문은 선택지로 답하기 때문이다.
 */
export type RemotePushKind = NotificationEvent | 'question'
type PushKind = RemotePushKind | 'summary'

/**
 * 배너 문구의 뒷부분. 앞에는 워크스페이스 이름이 붙는다 — `"design-tokens" finished`.
 *
 * 이름은 릴레이·Expo·APNs/FCM 을 **평문으로** 지나간다. 나머지(프롬프트·트랜스크립트·
 * 워크스페이스 UUID)와 달리 이것만 예외인 이유는, 알림을 열기 전에 어느 워크스페이스인지
 * 아는 값이 그만큼 크기 때문이다. `PRIVACY.md` 의 "Notifications" 절이 이 예외를 밝힌다.
 *
 * 접미사를 상수로 못 박아 두는 이유는 Edge Function 이 같은 표를 갖고 본문을
 * `<이름> <접미사>` 형태로만 검증하기 때문이다 — 버그로 프롬프트나 트랜스크립트가
 * 본문에 실려도 릴레이에서 걸린다. 고칠 때는 `supabase/functions/push/index.ts` 도 같이.
 *
 * **종류를 더할 때는 릴레이를 먼저 배포한다.** 모르는 kind 는 400 으로 거절되므로, 함수가
 * 아직 옛 표를 들고 있으면 배너 문구가 어긋나는 정도가 아니라 알림이 통째로 사라진다.
 * 두 표가 갈리지 않는지는 push.test.ts 가 지킨다.
 */
export const REMOTE_PUSH_SUFFIXES: Readonly<Record<RemotePushKind, string>> = {
  needsInput: 'needs your permission',
  question: 'needs your answer',
  completed: 'finished',
  error: 'encountered an error'
}

/** 이름을 알 수 없거나(요약) 못 쓸 때의 문구. */
export const REMOTE_PUSH_BODIES: Readonly<Record<PushKind, string>> = {
  needsInput: `A workspace ${REMOTE_PUSH_SUFFIXES.needsInput}`,
  question: `A workspace ${REMOTE_PUSH_SUFFIXES.question}`,
  completed: `A workspace ${REMOTE_PUSH_SUFFIXES.completed}`,
  error: `A workspace ${REMOTE_PUSH_SUFFIXES.error}`,
  summary: 'Several workspaces need your attention'
}

/** 배너 한 줄에 들어갈 만큼으로 자른다. 잠금화면은 이보다도 일찍 잘린다. */
export const REMOTE_PUSH_NAME_MAX = 48

/**
 * 이름을 배너에 실을 수 있는 한 줄로 정리한다. 줄바꿈·제어문자는 배너를 깨뜨리고,
 * 빈 이름은 `" finished"` 같은 문구가 되므로 고정 문구로 되돌린다.
 */
export function remotePushBody(kind: PushKind, workspaceName: string): string {
  if (kind === 'summary') return REMOTE_PUSH_BODIES.summary
  const name = workspaceName.replace(/\s+/g, ' ').trim()
  if (name.length === 0) return REMOTE_PUSH_BODIES[kind]
  const clipped =
    name.length > REMOTE_PUSH_NAME_MAX ? `${name.slice(0, REMOTE_PUSH_NAME_MAX - 1)}…` : name
  return `${clipped} ${REMOTE_PUSH_SUFFIXES[kind]}`
}

export const REMOTE_PUSH_BURST_MS = 10_000

export interface RemotePushNotification {
  workspaceId: string
  workspaceName: string
  kind: RemotePushKind
}

interface PushDeviceRow {
  id: string
  expo_push_token: string | null
}

interface PushMessage {
  deviceId: string
  n: string
  p: string
}

export interface RemotePushRequest {
  machineId: string
  kind: PushKind
  dedupeKey: string
  body: string
  messages: PushMessage[]
}

export interface RemotePushOptions {
  supabase: () => SupabaseClient
  keystore: RemoteKeystore
  machineId: () => string | null
  enabled: () => boolean
  call: (request: RemotePushRequest) => Promise<void>
  now?: () => number
  burstMs?: number
}

interface PendingPush extends RemotePushNotification {
  resolve: () => void
}

export class RemotePush {
  private readonly now: () => number
  private readonly burstMs: number
  private pending: PendingPush[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly sent = new Set<string>()

  constructor(private readonly options: RemotePushOptions) {
    this.now = options.now ?? Date.now
    this.burstMs = options.burstMs ?? REMOTE_PUSH_BURST_MS
  }

  notify(notification: RemotePushNotification): Promise<void> {
    if (!this.options.enabled() || !this.options.machineId()) return Promise.resolve()

    return new Promise((resolve) => {
      this.pending.push({ ...notification, resolve })
      if (new Set(this.pending.map((item) => item.workspaceId)).size >= 3) {
        this.clearTimer()
        void this.flush(true)
        return
      }
      if (this.burstMs <= 0) {
        void this.flush(false)
        return
      }
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null
          void this.flush(false)
        }, this.burstMs)
        this.timer.unref?.()
      }
    })
  }

  dispose(): void {
    this.clearTimer()
    const pending = this.pending
    this.pending = []
    for (const item of pending) item.resolve()
  }

  private async flush(summary: boolean): Promise<void> {
    const pending = this.pending
    this.pending = []
    if (pending.length === 0) return

    try {
      if (summary || new Set(pending.map((item) => item.workspaceId)).size >= 3) {
        await this.send(pending[pending.length - 1], 'summary')
      } else {
        for (const item of pending) await this.send(item, item.kind)
      }
    } catch (err) {
      // 알림 전송은 데스크톱 작업의 부가 기능이라 실패가 세션 이벤트 경로를 깨면 안 된다.
      log.error('원격 푸시 전송 실패', errorText(err))
    } finally {
      for (const item of pending) item.resolve()
    }
  }

  private async send(notification: RemotePushNotification, kind: PushKind): Promise<void> {
    if (!this.options.enabled()) return
    const machineId = this.options.machineId()
    if (!machineId) return

    const dedupeKey =
      kind === 'summary'
        ? `summary:${Math.floor(this.now() / 60_000)}`
        : `${notification.workspaceId}:${kind}:${Math.floor(this.now() / 60_000)}`
    if (this.sent.has(dedupeKey)) return

    const { data, error } = await this.options
      .supabase()
      .from('devices')
      .select('id,expo_push_token')
      .eq('machine_id', machineId)
      .is('revoked_at', null)
      .not('expo_push_token', 'is', null)
    if (error) throw error

    const rows = (data ?? []) as PushDeviceRow[]
    const tokenDeviceIds = new Set(
      rows.filter((row) => row.expo_push_token !== null).map((row) => row.id)
    )
    if (tokenDeviceIds.size === 0) return

    const messages = this.options.keystore
      .listDevices()
      .filter((device) => tokenDeviceIds.has(device.deviceId))
      .map((device) => {
        const header = { v: 1, machineId, deviceId: device.deviceId, kind: 'push' } as const
        const { laptopToPhone } = deriveDirectionKeys(
          fromBase64Url(device.sessionKey),
          device.deviceId
        )
        const box = sealJson(laptopToPhone, header, {
          workspaceId: notification.workspaceId,
          workspaceName: notification.workspaceName
        })
        return {
          deviceId: device.deviceId,
          n: toBase64Url(box.nonce),
          p: toBase64Url(box.ct)
        }
      })
    if (messages.length === 0) return

    this.sent.add(dedupeKey)
    try {
      await this.options.call({
        machineId,
        kind,
        dedupeKey,
        body: remotePushBody(kind, notification.workspaceName),
        messages
      })
    } catch (err) {
      this.sent.delete(dedupeKey)
      throw err
    }
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 이 시간(초) 이상 아무 입력이 없으면, 창이 앞에 있어도 자리를 비운 것으로 본다.
 * 랩탑을 열어 둔 채 나간 경우가 "쓰고 있는 중"으로 오인되면 폰이 영영 울리지 않는다.
 */
export const REMOTE_PUSH_IDLE_SECONDS = 60

export interface RemotePushActivity {
  /** Wooi 창(메인·분리 패널 아무거나) 이 지금 포커스를 갖고 있는가. */
  appFocused: boolean
  /** 마지막 입력 이후 흐른 초. `powerMonitor.getSystemIdleTime()` 값. */
  idleSeconds: number
  /** 데스크톱을 쓰는 중에도 항상 보내라는 설정(`remotePushWhileActive`). */
  always: boolean
}

/**
 * 폰을 깨울지 말지. 기본은 **데스크톱을 쓰는 중이면 보내지 않는다** — 눈앞의 창이 이미
 * 같은 사실을 보여 주는데 주머니까지 울리면 알림이 두 번 온 것으로만 느껴진다.
 *
 * "쓰는 중" 은 창이 앞에 있고 사람이 실제로 입력하고 있을 때로 좁게 잡는다. 둘 중 하나라도
 * 아니면(다른 앱을 보고 있거나, 창은 떠 있지만 자리를 비웠거나) 폰이 유일한 통로다.
 */
export function shouldSendRemotePush(activity: RemotePushActivity): boolean {
  if (activity.always) return true
  return !activity.appFocused || activity.idleSeconds >= REMOTE_PUSH_IDLE_SECONDS
}
