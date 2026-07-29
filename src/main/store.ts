import { app } from 'electron'
import { readFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './fsutil'
import { log } from './logger'
import { CLAUDE_DEFAULT_MODEL } from './agent/backend'
import { BASE_DEV_PORT, DEFAULT_AGENT_BACKEND, DEFAULT_NOTIFICATION_SETTINGS } from '@shared/types'
import type { AppState, AppSettings, PermissionMode, Repo, Workspace } from '@shared/types'

// 기본 모델은 백엔드 메타(agent/backend.ts)와 같은 출처를 본다 — 모델 ID 가 한 곳에만 박혀 있도록.
const DEFAULT_MODEL = CLAUDE_DEFAULT_MODEL

/**
 * 디스크 영속 형식의 현재 스키마 버전. 영속 데이터 모양이 바뀔 때마다 1 올리고,
 * MIGRATIONS 에 직전 버전 → 새 버전 변환 함수를 추가한다.
 */
const CURRENT_SCHEMA_VERSION = 11

/**
 * v9 → v10 에서 정리하는 모델 ID 치환표(마이그레이션 시점의 스냅샷이므로 여기 고정해 둔다).
 *
 * - `claude-opus-5` → `[1m]`: 목록에서 "Opus 5 (1M context)" 라벨로 노출하던 값인데, Claude Code 는
 *   접미사가 없으면 이 모델의 윈도를 200K 로 잡는다. 사용자가 고른 라벨(1M)대로 동작하도록 승격한다.
 * - opus-4-8/4-7 의 `[1m]`: 접미사 유무가 동작에 영향이 없어 목록에서 중복 항목을 없앴다. 남아 있는
 *   저장값이 드롭다운에서 "선택 없음" 처럼 보이지 않도록 접미사 없는 ID 로 모은다.
 */
const V10_MODEL_RENAMES: Record<string, string> = {
  'claude-opus-5': 'claude-opus-5[1m]',
  'claude-opus-4-8[1m]': 'claude-opus-4-8',
  'claude-opus-4-7[1m]': 'claude-opus-4-7'
}

/** 저장된 모델 ID 를 치환표로 옮긴다. null/미지정과 표에 없는 값은 그대로 둔다. */
function renameModel<T extends string | null | undefined>(model: T): T {
  if (typeof model !== 'string') return model
  return (V10_MODEL_RENAMES[model] ?? model) as T
}

/** 더 이상 노출하지 않는 'bypassPermissions' 등 옛 모드는 acceptEdits 로 환산한다. */
function normalizeMode(mode: unknown): PermissionMode {
  if (mode === 'default' || mode === 'acceptEdits' || mode === 'plan' || mode === 'auto')
    return mode
  return 'acceptEdits'
}

const DEFAULT_SETTINGS: AppSettings = {
  defaultPermissionMode: 'default',
  model: DEFAULT_MODEL,
  // null = effort 를 지정하지 않음(모델 기본 동작). 사용자가 Settings 에서 단계를 고르면 그 값으로.
  effort: null,
  // fast mode 는 CLI 와 동일하게 기본 off — 유료 플랜/크레딧과 지원 모델이 필요한 옵트인 기능이다.
  fastMode: false,
  // 기본 다크 — 기존 사용자도 load 의 기본값 병합으로 다크를 유지한다.
  theme: 'dark',
  soundOnComplete: true,
  notifications: DEFAULT_NOTIFICATION_SETTINGS,
  // 우측 작업 패널은 기본 펼침. 기존 사용자도 load 의 기본값 병합으로 펼침을 유지한다.
  defaultRightPanelOpen: true,
  // CLI 와 동일하게 자동 압축을 기본 켜둔다(autoCompactEnabled). 압축을 트리거하는 임계치는
  // Claude Code 가 모델별로 알려주는 값을 그대로 쓴다(session.ts 의 overAutoCompactThreshold).
  autoCompact: true,
  manualWorkspaceSetup: false,
  onboarded: false,
  // 아직 기본값을 고르지 않음 — 기존 사용자도 load 의 기본값 병합으로 false 가 되어,
  // 이 필드가 없던 버전(v1.0.3 이하)에서 올라오면 다음 실행에 한 번 질문을 받는다.
  pickedDefaults: false,
  // 미동의(null) 로 시작 — 기존 사용자도 load 의 기본값 병합으로 null 이 되어 (재)동의를 요구한다.
  acceptedTermsVersion: null
}

const EMPTY_STATE: AppState = {
  repos: [],
  workspaces: [],
  settings: DEFAULT_SETTINGS
}

/**
 * 디스크에 기록되는 형식 — 런타임 AppState 에 schemaVersion 을 더한 것.
 * schemaVersion 은 파일 형식 전용이라, IPC 로 노출하는 AppState 에는 싣지 않는다.
 */
type PersistedState = AppState & { schemaVersion: number }

/**
 * 버전별 마이그레이션. 인덱스 v 의 함수가 스키마 v → v+1 변환을 담당한다.
 * 입력은 직전 버전 형식의 파싱된 객체, 출력은 다음 버전 형식의 객체다.
 */
const MIGRATIONS: Array<(raw: Record<string, unknown>) => Record<string, unknown>> = [
  // v0(스키마 버전 필드가 없던 레거시) → v1: 누락·구식 필드를 현재 스키마로 정규화한다.
  (raw) => {
    const settings = { ...DEFAULT_SETTINGS, ...((raw.settings as Partial<AppSettings>) ?? {}) }
    settings.defaultPermissionMode = normalizeMode(settings.defaultPermissionMode)
    // model=null('default') 은 더 이상 노출하지 않으므로 기본 모델로 환산.
    settings.model = settings.model ?? DEFAULT_MODEL

    const workspaces = ((raw.workspaces as Partial<Workspace>[]) ?? []).map((w) => ({
      ...w,
      permissionMode: normalizeMode(w.permissionMode),
      // per-workspace 모델 오버라이드가 없으면 전역 설정을 따른다(null).
      model: w.model ?? null,
      lastModel: w.lastModel ?? null,
      archived: w.archived ?? false
    }))
    const repos = ((raw.repos as Partial<Repo>[]) ?? []).map((r) => ({
      ...r,
      archiveScript: r.archiveScript ?? ''
    }))
    return { repos, workspaces, settings }
  },
  // v1 → v2: 사용자 표시 이름 override(displayName) 도입. 기존 workspace 는 override 없음(null)으로,
  // 기본 규칙(worktree 이름 → PR 제목)을 그대로 따른다.
  (raw) => {
    const workspaces = ((raw.workspaces as Partial<Workspace>[]) ?? []).map((w) => ({
      ...w,
      displayName: w.displayName ?? null
    }))
    return { ...raw, workspaces }
  },
  // v2 → v3: workspace 별 dev 서버 포트(devPort) 도입. 병렬 dev 서버 포트 충돌을 막기 위해
  // 기존 workspace 에도 BASE_DEV_PORT 부터 비어 있는 포트를 하나씩 배정한다(이미 값이 있으면 보존).
  (raw) => {
    const list = (raw.workspaces as Partial<Workspace>[]) ?? []
    const used = new Set<number>()
    for (const w of list) if (typeof w.devPort === 'number') used.add(w.devPort)
    const alloc = (): number => {
      let port = BASE_DEV_PORT
      while (used.has(port)) port++
      used.add(port)
      return port
    }
    const workspaces = list.map((w) => ({
      ...w,
      devPort: typeof w.devPort === 'number' ? w.devPort : alloc()
    }))
    return { ...raw, workspaces }
  },
  // v3 → v4: reasoning effort(추론 노력) 도입. 기존 workspace 는 오버라이드 없음(null)으로 두어
  // 전역 설정(settings.effort)을 따른다. settings.effort 자체는 load 의 기본값 병합으로 null 이 된다.
  (raw) => {
    const workspaces = ((raw.workspaces as Partial<Workspace>[]) ?? []).map((w) => ({
      ...w,
      effort: w.effort ?? null
    }))
    return { ...raw, workspaces }
  },
  // v4 → v5: 에이전트 백엔드 식별자(agentBackend) 도입. 기존 workspace 는 모두 Claude 로 동작했으므로
  // 기본 백엔드('claude')로 채운다. 백엔드 추상화 계층이 이 값으로 호출을 라우팅한다.
  (raw) => {
    const workspaces = ((raw.workspaces as Partial<Workspace>[]) ?? []).map((w) => ({
      ...w,
      agentBackend: w.agentBackend ?? DEFAULT_AGENT_BACKEND
    }))
    return { ...raw, workspaces }
  },
  // v5 → v6: 온보딩 재노출. 현재 배포 버전(v0.4.0)까지의 파일은 모두 스키마 v5 이므로,
  // v0.4.0 이하에서 이미 온보딩을 마친(onboarded=true) 기존 사용자도 이 변환을 타면서
  // onboarded 가 false 로 초기화돼 다음 실행 때 온보딩을 다시 보게 된다. 신규 설치는 스키마가
  // 처음부터 v6 이라 이 변환을 타지 않으므로 영향이 없다. (약관 동의는 건드리지 않는다.)
  (raw) => {
    const settings = { ...((raw.settings as Partial<AppSettings>) ?? {}) }
    settings.onboarded = false
    return { ...raw, settings }
  },
  // v6 → v7: setup 스크립트 실행 결과(setupState) 영속화. 기존 workspace 는 이미 생성 시 setup 을
  // 마치고 사용 중이므로 'success' 로 본다 — 재실행 버튼을 새로 노출해 파괴적 재-setup 을 유도하지
  // 않도록. 신규 workspace 는 생성 시 'idle' 로 시작해 setup 종료 시점에 success/failed 로 갱신된다.
  (raw) => {
    const workspaces = ((raw.workspaces as Partial<Workspace>[]) ?? []).map((w) => ({
      ...w,
      setupState: w.setupState ?? 'success'
    }))
    return { ...raw, workspaces }
  },
  // v7 → v8: 세분화 알림 설정(notifications) + 워크스페이스별 음소거(muted) 도입.
  // 기존 soundOnComplete 를 존중해 완료 알림의 소리 채널로 옮기고, 나머지는 기본값을 쓴다.
  (raw) => {
    const settings = { ...((raw.settings as Partial<AppSettings>) ?? {}) }
    const sound = settings.soundOnComplete !== false
    settings.notifications = {
      completed: { osNotification: true, sound, badge: true },
      error: { osNotification: true, sound: false, badge: true },
      needsInput: { osNotification: true, sound: false, badge: true }
    }
    const workspaces = ((raw.workspaces as Partial<Workspace>[]) ?? []).map((w) => ({
      ...w,
      muted: w.muted ?? false
    }))
    return { ...raw, settings, workspaces }
  },
  // v8 → v9: stacked PR 지원. 기존 워크스페이스는 모두 스택 뿌리(parentWorkspaceId=null)로,
  // PR 번호는 미발견(null)으로 초기화한다. 이후 getPrStatus 로 발견되면 prNumber 가 채워진다.
  (raw) => {
    const workspaces = ((raw.workspaces as Partial<Workspace>[]) ?? []).map((w) => ({
      ...w,
      parentWorkspaceId: w.parentWorkspaceId ?? null,
      prNumber: w.prNumber ?? null
    }))
    return { ...raw, workspaces }
  },
  // v9 → v10: 모델 ID 정리. 핵심은 `claude-opus-5` → `claude-opus-5[1m]` 승격이다 — 당시 CLI 는
  // 접미사가 없으면 opus-5 의 윈도를 200K 로 잡아(레지스트리 미등재라 기본값을 썼다) 컨텍스트
  // 예산이 5 배 좁아졌다. (CLI 2.1.220 부터는 opus-5 가 native_1m 으로 등재돼 접미사 없이도 1M 이다.
  // 그래도 접미사는 무해하므로(supports_1m_suffix) 저장값을 되돌리지는 않는다.)
  (raw) => {
    const settings = { ...((raw.settings as Partial<AppSettings>) ?? {}) }
    settings.model = renameModel(settings.model)
    const workspaces = ((raw.workspaces as Partial<Workspace>[]) ?? []).map((w) => ({
      ...w,
      model: renameModel(w.model),
      lastModel: renameModel(w.lastModel)
    }))
    return { ...raw, settings, workspaces }
  },
  // v10 → v11: fast mode(`/fast`) 도입. 기존 workspace 는 오버라이드 없음(null)으로 두어 전역
  // 설정(settings.fastMode)을 따르고, 그 전역 기본값은 load 의 기본값 병합으로 false 가 된다 —
  // 유료 플랜·크레딧을 쓰는 옵트인 기능이라 기존 사용자에게 조용히 켜지지 않도록.
  //
  // 함께: 모델 목록의 Opus 5 를 한 항목(`claude-opus-5[1m]`)으로 합쳤으므로, 접미사 없는 값을 골라
  // 둔 설정이 있으면 그 항목으로 다시 모은다. 두 ID 는 CLI 2.1.220 기준 동작이 같아(둘 다 1M) 실제
  // 변화는 없고, 목록에 없는 값이 남아 설정 드롭다운이 "선택 없음" 처럼 보이는 것만 막는다.
  (raw) => {
    const settings = { ...((raw.settings as Partial<AppSettings>) ?? {}) }
    settings.model = renameModel(settings.model)
    const workspaces = ((raw.workspaces as Partial<Workspace>[]) ?? []).map((w) => ({
      ...w,
      model: renameModel(w.model),
      fastMode: w.fastMode ?? null,
      fastModeState: w.fastModeState ?? null,
      fastModeReason: w.fastModeReason ?? null
    }))
    return { ...raw, settings, workspaces }
  }
]

/**
 * 앱 설정(리포·workspace·세팅)을 userData 아래 단일 JSON 파일로 영속화한다.
 * electron-store 대신 직접 둔 이유: 의존성 최소화 + ESM/CJS 마찰 회피.
 * 트랜스크립트(대화 기록)는 용량이 커서 별도 파일로 관리한다([[transcripts]]).
 *
 * 파일에는 schemaVersion 을 함께 기록하고, 로드 시 현재 버전까지 순차 마이그레이션한다.
 */
class Store {
  private filePath: string
  /** 직전에 정상 영속된 상태의 미러. 주 파일이 손상됐을 때 복구 출처로 쓴다. */
  private backupPath: string
  private state: PersistedState

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
      let version =
        typeof rawVersion === 'number' && Number.isInteger(rawVersion) && rawVersion >= 0
          ? rawVersion
          : 0
      let migrated = raw
      // 현재 버전까지 순차 변환. 파일이 더 높은(미래) 버전이면 루프를 건너뛴다.
      while (version < CURRENT_SCHEMA_VERSION) {
        migrated = MIGRATIONS[version](migrated)
        version++
      }

      // 부팅 시점엔 살아 있는 Claude 세션이 하나도 없다(세션은 첫 메시지 때 lazy 생성).
      // 따라서 직전 종료/크래시 때 'running' 으로 남은 상태는 실제로는 진행되지 않는 유령
      // 상태이므로 idle 로 되돌려, 재시작 후 사이드바가 '진행 중'에 갇히지 않게 한다.
      const workspaces = ((migrated.workspaces as Workspace[]) ?? []).map((w) =>
        w.status === 'running' ? { ...w, status: 'idle' as const } : w
      )

      // 미래 버전 파일(다운그레이드 상황)은 버전을 깎지 않고 보존해, 신버전으로 되돌렸을 때
      // 마이그레이션이 재실행되거나 데이터가 손상되지 않게 한다. 알려진 필드만 읽는다.
      // 마이그레이션 후에도 누락 필드가 없도록 settings 는 기본값과 최종 병합한다.
      return {
        schemaVersion: version,
        repos: (migrated.repos as Repo[]) ?? [],
        workspaces,
        settings: { ...DEFAULT_SETTINGS, ...((migrated.settings as Partial<AppSettings>) ?? {}) }
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
    try {
      copyFileSync(this.filePath, this.backupPath)
    } catch {
      // 백업 갱신 실패는 무시 — 다음 persist 에서 다시 시도된다.
    }
  }

  getState(): AppState {
    // schemaVersion 은 파일 형식 전용이므로 런타임 AppState 에는 싣지 않는다.
    return structuredClone({
      repos: this.state.repos,
      workspaces: this.state.workspaces,
      settings: this.state.settings,
      rateLimits: this.state.rateLimits
    })
  }

  /** mutator 로 state 를 변경하고 즉시 디스크에 기록한다. */
  update(mutate: (state: AppState) => void): void {
    mutate(this.state)
    this.persist()
  }
}

let store: Store | null = null

export function getStore(): Store {
  if (!store) store = new Store()
  return store
}
