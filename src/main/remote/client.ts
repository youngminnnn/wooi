import { hostname } from 'node:os'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { RemoteConnectionState, RemoteMachine } from '@shared/remote'

export type { RemoteConnectionState }
import { log } from '../logger'
import { isRemoteStorageAvailable, type RemoteKeystore } from './keystore'

/**
 * 릴레이와의 연결 자체를 담당한다 — 설정 해석, 익명 로그인, `machines` 행 유지, heartbeat,
 * 재연결. Realtime 구독과 커맨드 루프는 `bridge.ts` 의 몫이다(여기는 "붙어 있는가"만 안다).
 *
 * 설계상 중요한 것 하나: **원격이 꺼져 있으면 비용이 0이어야 한다.** 그래서 Supabase
 * 클라이언트는 `connect()` 이전에 만들지 않는다 — import 만으로 소켓도 타이머도 생기지 않는다.
 */

// ── 설정 ──────────────────────────────────────────────────────────────────

export interface RemoteConfig {
  url: string
  /**
   * 공개 anon 키. 앱 바이너리에 실려도 안전하다 — 이 키는 "익명 방문자 자격으로 붙는다"는
   * 뜻일 뿐이고, 실제 접근 판정은 전부 Postgres RLS 가 한다.
   * (RLS 를 우회하는 service_role 키는 Edge Function 환경변수에만 존재하며 여기 오지 않는다.)
   */
  anonKey: string
}

/**
 * 배포본에 구워 넣을 기본 설정. M2 에서 실제 프로젝트 값으로 채운다.
 *
 * 지금 비워 두는 이유: M0 은 로컬 스택(`supabase start`)과 클라우드를 오가며 검증하는데,
 * 그때마다 코드를 고치는 대신 환경변수로 가리키는 편이 낫고, 클라우드 키를 레포에 커밋하는
 * 결정은 실제로 배포를 시작할 때 내리면 된다(한 번 커밋한 키는 히스토리에서 지워지지 않는다).
 */
const BAKED_CONFIG: RemoteConfig | null = null

/**
 * 쓸 설정을 정한다. 환경변수가 있으면 그것이, 없으면 구워 넣은 값이 이긴다.
 * 둘 다 없으면 `null` — 원격 기능은 "설정되지 않음"으로 비활성이다.
 */
export function resolveRemoteConfig(env: NodeJS.ProcessEnv = process.env): RemoteConfig | null {
  const url = env.WOOI_SUPABASE_URL?.trim()
  const anonKey = env.WOOI_SUPABASE_ANON_KEY?.trim()
  if (url && anonKey) return { url, anonKey }
  // 한쪽만 준 것은 거의 확실히 실수다 — 조용히 구워 넣은 값으로 떨어지면 로컬 스택을 겨냥한 줄
  // 알았는데 클라우드에 붙는 일이 생긴다.
  if (url || anonKey) {
    log.error(
      'WOOI_SUPABASE_URL 과 WOOI_SUPABASE_ANON_KEY 는 함께 설정해야 합니다 — 원격 비활성화.'
    )
    return null
  }
  return BAKED_CONFIG
}

// ── 백오프 ────────────────────────────────────────────────────────────────

const BASE_DELAY_MS = 1_000
const MAX_DELAY_MS = 30_000

/**
 * 재연결 지연. 지수 백오프 + 전폭 지터.
 *
 * 지터가 없으면 릴레이가 잠깐 죽었다 살아날 때 모든 설치본이 **같은 순간에** 재접속을 시도해
 * 되살아나는 서버를 다시 넘어뜨린다(thundering herd). 공용 프로젝트라 이게 실제 위험이다.
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt))
  return Math.round(random() * ceiling)
}

/** 랩탑이 살아 있음을 알리는 주기. 폰의 "last seen N min ago" 배너가 이 값에 의존한다. */
export const HEARTBEAT_INTERVAL_MS = 60_000

// ── 클라이언트 ────────────────────────────────────────────────────────────

export interface RemoteClientOptions {
  config: RemoteConfig
  keystore: RemoteKeystore
  /** `app.getVersion()`. electron 을 직접 import 하지 않아 테스트에서 갈아끼울 수 있다. */
  appVersion: string
  machineName?: string
  /**
   * 백오프 지터의 난수원. 이 클라이언트에서 비결정적인 것은 이것 하나뿐이라,
   * 테스트가 지연을 고정할 수 있게 밖으로 뺀다.
   */
  random?: () => number
}

type Listener = (state: RemoteConnectionState) => void

export class RemoteClient {
  private readonly options: RemoteClientOptions
  private client: SupabaseClient | null = null
  private listeners = new Set<Listener>()
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private disposed = false
  private state: RemoteConnectionState = {
    status: 'offline',
    lastError: null,
    needsCaptcha: false,
    machineId: null
  }

  constructor(options: RemoteClientOptions) {
    this.options = options
  }

  getState(): RemoteConnectionState {
    return this.state
  }

  getMachine(): RemoteMachine {
    return {
      id: this.options.keystore.identity().machineId,
      name: this.options.machineName ?? hostname(),
      appVersion: this.options.appVersion
    }
  }

  /** 상태 변화를 구독한다. 반환값을 호출하면 해제된다. */
  onChange(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * 릴레이에 붙는다. 이미 붙어 있으면 아무것도 하지 않는다.
   * 실패는 던지지 않고 상태로 보고한 뒤 백오프 재시도를 건다 — 호출자(브리지·설정 UI)가
   * 네트워크 실패마다 예외를 처리하게 만들 이유가 없다.
   */
  async connect(): Promise<void> {
    if (this.disposed || this.state.status === 'online' || this.state.status === 'connecting')
      return

    if (!isRemoteStorageAvailable()) {
      this.set({
        status: 'unavailable',
        lastError: 'OS encrypted storage is unavailable',
        needsCaptcha: false
      })
      return
    }

    this.clearRetry()
    this.set({ status: 'connecting', lastError: null })

    try {
      const client = this.ensureClient()
      await this.ensureSession(client)
      const machineId = await this.ensureMachine(client)
      this.attempt = 0
      this.startHeartbeat()
      this.set({ status: 'online', lastError: null, needsCaptcha: false, machineId })
    } catch (err) {
      const message = errorText(err)
      // CAPTCHA 가 켜진 프로젝트에서는 UI 없이 재시도해 봐야 영원히 실패한다.
      // 그러니 백오프 루프에 넣지 않고 사용자에게 넘긴다.
      const needsCaptcha = /captcha/i.test(message)
      this.set({ status: 'offline', lastError: message, needsCaptcha })
      if (!needsCaptcha) this.scheduleRetry()
    }
  }

  /** 연결을 끊는다. 타이머와 소켓을 모두 정리하므로 이후 비용이 0이 된다. */
  async disconnect(): Promise<void> {
    this.clearRetry()
    this.stopHeartbeat()
    if (this.client) {
      try {
        await this.client.removeAllChannels()
      } catch (err) {
        log.error('원격 채널 정리 실패', err)
      }
    }
    this.client = null
    if (!this.disposed) this.set({ status: 'offline' })
  }

  /** 되돌릴 수 없는 종료. 앱 종료 경로에서 호출한다. */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.disconnect()
    this.listeners.clear()
  }

  /**
   * 브리지가 쓸 클라이언트. `connect()` 성공 전에는 없다 —
   * 호출자가 연결 여부를 확인하도록 강제한다.
   */
  supabase(): SupabaseClient {
    if (!this.client || this.state.status !== 'online') {
      throw new Error('remote client is not connected')
    }
    return this.client
  }

  /**
   * `pair` Edge Function 호출. 상태 코드를 **그대로** 돌려준다 —
   * 페어링 흐름은 409("아직 claim 안 됨")와 404("코드 없음")를 다르게 다뤄야 하는데,
   * supabase-js 의 `functions.invoke()` 는 그 구분을 오류 객체 안쪽으로 숨긴다.
   */
  async pair(body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
    const { data } = await this.supabase().auth.getSession()
    const token = data.session?.access_token
    if (!token) throw new Error('remote client has no session')

    const res = await fetch(`${this.options.config.url}/functions/v1/pair`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: this.options.config.anonKey,
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(body)
    })
    let json: unknown = null
    try {
      json = await res.json()
    } catch {
      /* 본문 없는 응답 */
    }
    return { status: res.status, json }
  }

  // ── 내부 ────────────────────────────────────────────────────────────────

  private ensureClient(): SupabaseClient {
    if (this.client) return this.client
    const { config, keystore } = this.options
    this.client = createClient(config.url, config.anonKey, {
      auth: {
        // 세션 blob 을 우리 키스토어(safeStorage 봉인)에 넣는다.
        // 기본 저장소는 브라우저 localStorage 라 Node 에서는 아예 동작하지 않고,
        // 파일로 흘리면 평문 bearer token 이 디스크에 남는다.
        storage: keystoreAuthStorage(keystore),
        persistSession: true,
        autoRefreshToken: true,
        // 이 클라이언트는 브라우저 리다이렉트를 받지 않는다.
        detectSessionInUrl: false
      },
      global: { headers: { 'x-wooi-client': 'desktop' } }
    })
    return this.client
  }

  /** 저장된 세션이 있으면 그대로 쓰고, 없으면 익명 사용자를 새로 만든다. */
  private async ensureSession(client: SupabaseClient): Promise<void> {
    const { data, error } = await client.auth.getSession()
    if (error) throw error
    if (data.session) return

    const signIn = await client.auth.signInAnonymously()
    if (signIn.error) throw signIn.error
    if (!signIn.data.session) throw new Error('anonymous sign-in returned no session')
    log.info('원격: 새 익명 세션을 만들었습니다.')
  }

  /**
   * `machines` 행이 존재하고 최신 정보를 갖도록 한다.
   *
   * upsert 인 이유: 보존 작업이 오래 쉰 머신을 지웠거나 사용자가 원격 데이터를 초기화했을 수
   * 있는데, 그때 키스토어의 machineId 로 조용히 되살아나야 한다. 다른 사람 소유의 id 라면
   * RLS 가 막아 에러가 나고 — 그게 맞는 동작이다.
   */
  private async ensureMachine(client: SupabaseClient): Promise<string> {
    const { machineId } = this.options.keystore.identity()
    const { error } = await client.from('machines').upsert(
      {
        id: machineId,
        name: this.options.machineName ?? hostname(),
        platform: process.platform,
        app_version: this.options.appVersion,
        last_seen_at: new Date().toISOString()
      },
      { onConflict: 'id' }
    )
    if (error) throw error
    return machineId
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeat = setInterval(() => {
      void this.beat()
    }, HEARTBEAT_INTERVAL_MS)
    // 앱 종료를 막지 않는다.
    this.heartbeat.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
  }

  private async beat(): Promise<void> {
    if (!this.client || this.state.status !== 'online' || !this.state.machineId) return
    const { error } = await this.client
      .from('machines')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', this.state.machineId)
    if (!error) return

    // heartbeat 실패는 곧 "폰에게 죽은 것처럼 보인다" 이므로 조용히 넘기지 않는다.
    log.error('원격 heartbeat 실패 — 재연결합니다.', error.message)
    this.stopHeartbeat()
    this.set({ status: 'offline', lastError: error.message })
    this.scheduleRetry()
  }

  private scheduleRetry(): void {
    if (this.disposed) return
    this.clearRetry()
    const delay = backoffDelay(this.attempt++, this.options.random)
    this.retry = setTimeout(() => {
      this.retry = null
      void this.connect()
    }, delay)
    this.retry.unref?.()
  }

  private clearRetry(): void {
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
  }

  private set(patch: Partial<RemoteConnectionState>): void {
    const next = { ...this.state, ...patch }
    if (
      next.status === this.state.status &&
      next.lastError === this.state.lastError &&
      next.needsCaptcha === this.state.needsCaptcha &&
      next.machineId === this.state.machineId
    ) {
      return
    }
    this.state = next
    for (const listener of this.listeners) {
      try {
        listener(next)
      } catch (err) {
        log.error('원격 상태 리스너 실패', err)
      }
    }
  }
}

// ── auth 저장소 어댑터 ────────────────────────────────────────────────────

/**
 * supabase-js 의 세션 저장소를 키스토어로 돌린다.
 *
 * 키를 무시하고 값 하나만 다루는 이유: 이 클라이언트는 프로젝트 하나에만 붙으므로 supabase-js
 * 가 쓰는 키(`sb-<ref>-auth-token`)는 언제나 같다. 키까지 저장하면 프로젝트를 바꿨을 때
 * 옛 항목이 남아 "왜 다른 uid 로 붙지?"가 된다.
 */
function keystoreAuthStorage(keystore: RemoteKeystore): {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
} {
  return {
    getItem: () => {
      try {
        return keystore.getAuthSession()
      } catch (err) {
        log.error('원격 세션 읽기 실패', errorText(err))
        return null
      }
    },
    setItem: (_key, value) => keystore.setAuthSession(value),
    removeItem: () => keystore.setAuthSession(null)
  }
}

/**
 * 무엇이 오든 읽을 수 있는 메시지를 뽑는다.
 *
 * `instanceof Error` 만 보면 안 된다: Supabase 의 오류 타입이 실제 Error 인지 평범한
 * `{message, code, hint}` 객체인지는 버전마다 달랐고, 후자를 `String()` 에 넣으면
 * `[object Object]` 가 되어 **가장 필요한 정보가 통째로 사라진다** — 그리고 그 문자열은
 * 상태에 실려 사용자 화면과 로그에 그대로 나간다.
 */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const { message } = err as { message: unknown }
    if (typeof message === 'string' && message) return message
  }
  return String(err)
}
