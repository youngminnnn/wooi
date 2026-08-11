import { app } from 'electron'
import { readFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './fsutil'
import { log } from './logger'
import {
  CURRENT_SCHEMA_VERSION,
  EMPTY_STATE,
  DEFAULT_SETTINGS,
  migrate,
  normalizeShape,
  type PersistedState
} from './storeSchema'
import type { AppSettings, AppState, Repo, ReviewSession, Workspace } from '@shared/types'

/**
 * 쓰기를 모으는 창. 상태 변화 하나하나가 아니라 이 간격마다 한 번만 디스크에 내려간다.
 * 짧게 잡아 크래시 시 잃는 양을 눈에 띄지 않는 수준으로 묶어 두되, 한 턴에서 쏟아지는
 * 수십 번의 상태 전이는 확실히 1회로 합쳐지도록 한 값이다.
 */
const PERSIST_DEBOUNCE_MS = 250

/**
 * 백업 미러를 갱신하는 최소 간격. 백업의 목적은 "주 파일이 손상됐을 때 돌아갈 최근 상태"라
 * 매번 복사할 이유가 없다 — 복사도 동기 I/O 이고, 주 파일 자체가 이미 원자적으로 쓰인다.
 */
const BACKUP_MIN_INTERVAL_MS = 30_000

/**
 * 앱 설정(리포·workspace·세팅)을 userData 아래 단일 JSON 파일로 영속화한다.
 * electron-store 대신 직접 둔 이유: 의존성 최소화 + ESM/CJS 마찰 회피.
 * 트랜스크립트(대화 기록)는 용량이 커서 별도 파일로 관리한다([[transcripts]]).
 *
 * 파일에는 schemaVersion 을 함께 기록하고, 로드 시 현재 버전까지 순차 마이그레이션한다.
 *
 * **쓰기는 모아서 한다.** 예전에는 update() 마다 곧바로 전체 JSON 직렬화 + fsync + 디렉터리
 * fsync + 백업 복사를 동기로 수행했는데, 이 한 번이 메인 스레드를 ~10ms 붙잡는다. 워크스페이스
 * 여러 개가 동시에 돌면 상태 전이(running/idle·sessionId·fastMode)가 초당 수십 번 쏟아지므로,
 * 메인이 통째로 막혀 IPC·창 이벤트가 밀린다 — 사용자에게는 앱 전체의 버벅임으로 보인다.
 * 그래서 변경은 메모리에 즉시 반영하고(읽기는 항상 최신), 디스크 쓰기만 디바운스한다.
 */
class Store {
  private filePath: string
  /** 직전에 정상 영속된 상태의 미러. 주 파일이 손상됐을 때 복구 출처로 쓴다. */
  private backupPath: string
  private state: PersistedState
  /** 메모리 상태가 마지막으로 디스크에 내려간 것보다 앞서 있는가. */
  private dirty = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private lastBackupAt = 0

  constructor() {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.filePath = join(dir, 'wooi.json')
    this.backupPath = join(dir, 'wooi.bak.json')
    this.state = this.load()
  }

  /**
   * 주 파일 → 백업 파일 순으로 읽기를 시도하고, 둘 다 실패하면 빈 상태로 시작한다.
   * 주 파일이 손상(부분 쓰기·디스크 비트로트·외부 편집)됐어도 직전 정상 상태를 살려,
   * 설정·워크스페이스 목록 전체가 한 번의 손상으로 날아가지 않게 한다.
   */
  private load(): PersistedState {
    const fromMain = this.tryLoad(this.filePath)
    if (fromMain) return fromMain

    const fromBackup = this.tryLoad(this.backupPath)
    if (fromBackup) {
      log.error('wooi.json 손상/누락 — 백업(wooi.bak.json)에서 복구했습니다.')
      // 복구한 상태를 곧장 주 파일로 다시 써, 다음 부팅부터 정상 파일을 읽게 한다.
      try {
        writeFileAtomic(this.filePath, JSON.stringify(fromBackup, null, 2))
      } catch (err) {
        log.error('백업으로부터 주 파일 재기록 실패', err)
      }
      return fromBackup
    }

    if (existsSync(this.filePath) || existsSync(this.backupPath)) {
      log.error('wooi.json 과 백업 모두 읽기 실패 — 빈 상태로 시작합니다.')
    }
    return this.empty()
  }

  /** 한 파일을 읽어 파싱·마이그레이션한다. 없거나 손상이면 null. */
  private tryLoad(path: string): PersistedState | null {
    if (!existsSync(path)) return null
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>

      // 버전 필드가 없거나 비정상(음수·소수·비숫자)이면 레거시(v0)로 간주한다.
      const rawVersion = raw.schemaVersion
      const version =
        typeof rawVersion === 'number' && Number.isInteger(rawVersion) && rawVersion >= 0
          ? rawVersion
          : 0
      // 마이그레이션 뒤에 모양을 한 번 더 메운다 — 버전이 이미 최신인 파일에 구버전 빌드가
      // 이어서 쓴 레코드는 마이그레이션이 손대지 못하고 지나간다([[storeSchema]] normalizeShape).
      const migrated = normalizeShape(migrate(raw, version))

      // 부팅 시점엔 살아 있는 Claude 세션이 하나도 없다(세션은 첫 메시지 때 lazy 생성).
      // 따라서 직전 종료/크래시 때 'running' 으로 남은 상태는 실제로는 진행되지 않는 유령
      // 상태이므로 idle 로 되돌려, 재시작 후 사이드바가 '진행 중'에 갇히지 않게 한다.
      const workspaces = ((migrated.workspaces as Workspace[]) ?? []).map((w) =>
        w.status === 'running' ? { ...w, status: 'idle' as const } : w
      )

      // 리뷰도 같은 이유로 씻어낸다 — 실행 중이던 query 프로세스는 종료와 함께 사라졌으므로,
      // 'preparing'/'running' 으로 남은 세션은 재시작 후 영원히 스피너에 갇힌다.
      const reviews = ((migrated.reviews as ReviewSession[]) ?? []).map((r) =>
        r.status === 'running' || r.status === 'preparing'
          ? { ...r, status: 'cancelled' as const }
          : r
      )

      // 마이그레이션한 결과는 **현재 버전으로 기록한다**. 읽은 버전을 그대로 남기면 다음 부팅에
      // 같은 마이그레이션이 이미 변환된 데이터 위에서 다시 돌아, 옛 필드를 찾지 못하고 기본값으로
      // 덮어쓴다(예: v12→v13 이 agents.claude.permissionMode 를 매번 acceptEdits 로 되돌림).
      // 다만 미래 버전 파일(다운그레이드 상황)은 버전을 깎지 않고 보존해, 신버전으로 되돌렸을 때
      // 데이터가 손상되지 않게 한다 — 그래서 max 다. 알려진 필드만 읽는다.
      // 마이그레이션 후에도 누락 필드가 없도록 settings 는 기본값과 최종 병합한다.
      const saved = (migrated.settings as Partial<AppSettings>) ?? {}
      return {
        schemaVersion: Math.max(version, CURRENT_SCHEMA_VERSION),
        repos: (migrated.repos as Repo[]) ?? [],
        workspaces,
        reviews,
        settings: {
          ...DEFAULT_SETTINGS,
          ...saved,
          // agents 는 백엔드별 레코드라 얕은 병합으로는 부족하다 — 저장 파일이 일부 백엔드만
          // 담고 있으면(나중에 추가된 백엔드, 손으로 편집한 파일) 그 항목이 통째로 undefined 가
          // 되어 읽는 쪽이 전부 터진다. 기본값 위에 저장값을 덮어 항상 전 백엔드를 채운다.
          agents: { ...DEFAULT_SETTINGS.agents, ...(saved.agents ?? {}) }
        }
      }
    } catch {
      // 손상/파싱 실패 — 호출 측이 백업으로 폴백할 수 있게 null 을 돌려준다.
      return null
    }
  }

  private empty(): PersistedState {
    return { schemaVersion: CURRENT_SCHEMA_VERSION, ...structuredClone(EMPTY_STATE) }
  }

  private persist(): void {
    const json = JSON.stringify(this.state, null, 2)
    writeFileAtomic(this.filePath, json)
    // 주 파일을 성공적으로 쓴 뒤에만 백업을 갱신한다 — 그래야 백업은 항상 "한 번은 정상이었던"
    // 상태를 가리킨다. 백업 쓰기 실패는 best-effort 로 무시한다(주 파일은 이미 안전하다).
    // 매번 복사하지는 않는다: 백업은 "최근의 정상 상태"면 충분하고, 복사도 동기 I/O 다.
    const now = Date.now()
    if (now - this.lastBackupAt < BACKUP_MIN_INTERVAL_MS) return
    try {
      copyFileSync(this.filePath, this.backupPath)
      this.lastBackupAt = now
    } catch {
      // 백업 갱신 실패는 무시 — 다음 persist 에서 다시 시도된다.
    }
  }

  /** 다음 디바운스 창에 쓰기를 예약한다(이미 예약돼 있으면 그대로 둔다). */
  private schedulePersist(): void {
    this.dirty = true
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, PERSIST_DEBOUNCE_MS)
    // 이 타이머 때문에 프로세스가 살아 있을 이유는 없다.
    this.flushTimer.unref?.()
  }

  /**
   * 밀린 변경을 지금 즉시 디스크에 내린다. 종료(before-quit)처럼 "여기서 잃으면 안 되는"
   * 지점에서 호출한다. 밀린 변경이 없으면 아무것도 하지 않는다.
   */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (!this.dirty) return
    this.dirty = false
    try {
      this.persist()
    } catch (err) {
      // 여기서 던지면 종료 경로가 끊긴다. 다음 변경이 다시 예약하도록 dirty 를 되돌린다.
      this.dirty = true
      log.error('상태 영속화 실패', err)
    }
  }

  getState(): AppState {
    // schemaVersion 은 파일 형식 전용이므로 런타임 AppState 에는 싣지 않는다.
    return structuredClone({
      repos: this.state.repos,
      workspaces: this.state.workspaces,
      reviews: this.state.reviews,
      settings: this.state.settings,
      rateLimits: this.state.rateLimits,
      rateLimitsByAgent: this.state.rateLimitsByAgent
    })
  }

  /**
   * mutator 로 state 를 변경한다. 메모리에는 즉시 반영되고(이후 getState 는 항상 최신),
   * 디스크 쓰기는 다음 디바운스 창으로 미뤄 여러 변경을 한 번에 내린다.
   */
  update(mutate: (state: AppState) => void): void {
    mutate(this.state)
    this.schedulePersist()
  }
}

let store: Store | null = null

export function getStore(): Store {
  if (!store) store = new Store()
  return store
}

/**
 * 밀린 상태 변경을 즉시 디스크에 내린다(앱 종료 등). 스토어가 아직 만들어지지 않았으면 no-op.
 * 쓰기가 디바운스되므로, 프로세스가 사라지기 전에 반드시 한 번 불러야 마지막 변경이 남는다.
 */
export function flushStore(): void {
  store?.flush()
}
