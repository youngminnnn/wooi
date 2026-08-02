import { CLAUDE_DEFAULT_MODEL } from './agent/backend'
import { BASE_DEV_PORT, DEFAULT_AGENT_BACKEND, DEFAULT_NOTIFICATION_SETTINGS } from '@shared/types'
import type {
  AppState,
  AppSettings,
  EffortSetting,
  PermissionMode,
  Repo,
  ReviewSession,
  Workspace
} from '@shared/types'

/**
 * 영속 스키마의 버전과 버전 간 마이그레이션.
 *
 * store.ts 에서 분리해 둔 이유는 **테스트 가능성**이다 — store.ts 는 electron `app` 을 import 해
 * 유닛 테스트에서 로드할 수 없는데, 마이그레이션은 순수 함수라 그 자체로 검증할 수 있어야 한다.
 * (사용자 데이터를 실제로 변환하는 코드라, 회귀가 나면 설정이 통째로 날아간다.)
 */

// 기본 모델은 백엔드 메타(agent/backend.ts)와 같은 출처를 본다 — 모델 ID 가 한 곳에만 박혀 있도록.
const DEFAULT_MODEL = CLAUDE_DEFAULT_MODEL

/**
 * 디스크 영속 형식의 현재 스키마 버전. 영속 데이터 모양이 바뀔 때마다 1 올리고,
 * MIGRATIONS 에 직전 버전 → 새 버전 변환 함수를 추가한다.
 */
export const CURRENT_SCHEMA_VERSION = 15

/**
 * v12 이하의 settings 모양. 그 시절엔 에이전트가 Claude 하나뿐이라 모델·effort·fast mode·
 * 권한 모드가 전역 단일 값이었다(v13 에서 백엔드별 `agents` 레코드로 쪼갰다). 마이그레이션 함수들은
 * **그 시점의 형식**을 읽어야 하므로 현재 AppSettings 가 아니라 이 타입을 본다.
 */
type LegacySettingsV12 = Partial<AppSettings> & {
  defaultPermissionMode?: PermissionMode
  model?: string | null
  effort?: EffortSetting | null
  fastMode?: boolean
}

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

export const DEFAULT_SETTINGS: AppSettings = {
  defaultAgentBackend: DEFAULT_AGENT_BACKEND,
  agents: {
    // Claude 는 검증된 기본 모델을 지정한다(1M 윈도를 잡는 `[1m]` 접미사 포함).
    claude: { model: DEFAULT_MODEL, effort: null, permissionMode: 'default', fastMode: false },
    // Codex 는 카탈로그 기본 모델·기본 effort 를 그대로 따른다(null = 백엔드 기본).
    // 모델과 effort는 Codex 카탈로그 기본값을 따르고 fast tier는 기본적으로 끈다.
    codex: { model: null, effort: null, permissionMode: null, fastMode: false }
  },
  // 기본 다크 — 기존 사용자도 load 의 기본값 병합으로 다크를 유지한다.
  theme: 'dark',
  soundOnComplete: true,
  notifications: DEFAULT_NOTIFICATION_SETTINGS,
  // 우측 작업 패널은 기본 펼침. 기존 사용자도 load 의 기본값 병합으로 펼침을 유지한다.
  defaultRightPanelOpen: true,
  // 실행 중인 서브에이전트 목록은 기본 켜짐 — 병렬로 도는 작업을 보여 주는 것이 이 앱의 본령이라
  // 옵트인으로 숨겨 둘 이유가 없다. 기존 사용자도 load 의 기본값 병합으로 켜진 상태가 되므로
  // schemaVersion 을 올릴 필요가 없다.
  showRunningAgents: true,
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

export const EMPTY_STATE: AppState = {
  repos: [],
  workspaces: [],
  reviews: [],
  settings: DEFAULT_SETTINGS
}

/**
 * 버전별 마이그레이션. 인덱스 v 의 함수가 스키마 v → v+1 변환을 담당한다.
 * 입력은 직전 버전 형식의 파싱된 객체, 출력은 다음 버전 형식의 객체다.
 */
export const MIGRATIONS: Array<(raw: Record<string, unknown>) => Record<string, unknown>> = [
  // v0(스키마 버전 필드가 없던 레거시) → v1: 누락·구식 필드를 현재 스키마로 정규화한다.
  (raw) => {
    const settings: LegacySettingsV12 = { ...((raw.settings as LegacySettingsV12) ?? {}) }
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
  // v9 → v10: 모델 ID 정리. 핵심은 `claude-opus-5` → `claude-opus-5[1m]` 승격이다 — 접미사가 없으면
  // Claude Code 가 윈도를 200K 로 잡아(다른 Opus 라인과 다르다) 컨텍스트 예산이 5 배 좁아지고,
  // 그만큼 대화가 빨리 자동 압축된다. 목록에서는 "Opus 5 (1M context)" 로 안내하던 값이라 승격이 맞다.
  (raw) => {
    const settings: LegacySettingsV12 = { ...((raw.settings as LegacySettingsV12) ?? {}) }
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
    const settings: LegacySettingsV12 = { ...((raw.settings as LegacySettingsV12) ?? {}) }
    settings.model = renameModel(settings.model)
    const workspaces = ((raw.workspaces as Partial<Workspace>[]) ?? []).map((w) => ({
      ...w,
      model: renameModel(w.model),
      fastMode: w.fastMode ?? null,
      fastModeState: w.fastModeState ?? null,
      fastModeReason: w.fastModeReason ?? null
    }))
    return { ...raw, settings, workspaces }
  },
  // v11 → v12: worktree 전달 목록(carryItems) 도입. 기존 리포는 빈 목록으로 둔다 —
  // 지금까지 수동으로 파일을 복사해 쓰던 워크스페이스가 있을 수 있어, 자동 탐지로 목록을
  // 채워 놓고 다음 워크스페이스 생성 때 예상 밖의 심링크·덮어쓰기가 생기는 편보다
  // 사용자가 설정 모달에서 직접 켜게 하는 쪽이 안전하다(신규 리포는 추가 시 자동 탐지된다).
  (raw) => {
    const repos = ((raw.repos as Partial<Repo>[]) ?? []).map((r) => ({
      ...r,
      carryItems: r.carryItems ?? []
    }))
    return { ...raw, repos }
  },
  // v12 → v13: 에이전트 백엔드가 둘(Claude Code · Codex)이 되면서, 전역 단일 값이던 모델·effort·
  // 권한 모드를 백엔드별로 쪼갠다. 모델 ID 와 권한 모드는 백엔드마다 달라서 하나의 전역 값으로는
  // 백엔드를 오갈 때 항상 어긋나기 때문이다. 기존 값은 전부 Claude 것이었으므로 agents.claude 로
  // 옮기고, Codex 는 "백엔드 기본을 따름"(null)으로 시드한다.
  //
  // 워크스페이스는 건드리지 않는다 — agentBackend·model·effort·permissionMode 모양이 그대로다.
  // onboarded 도 건드리지 않는다: 이미 쓰고 있던 사용자를 백엔드 추가 때문에 다시 온보딩시키지
  // 않는다(Codex 를 나중에 설치하면 피커가 자연히 나타난다).
  (raw) => {
    const legacy = (raw.settings as LegacySettingsV12) ?? {}
    const { defaultPermissionMode, model, effort, fastMode, ...rest } = legacy
    const settings = {
      ...rest,
      defaultAgentBackend: DEFAULT_AGENT_BACKEND,
      agents: {
        claude: {
          model: model ?? DEFAULT_MODEL,
          effort: effort ?? null,
          permissionMode: normalizeMode(defaultPermissionMode),
          // fast mode 는 Claude 전용이지만 성격은 model·effort 와 같은 "에이전트별 기본값"이다.
          fastMode: fastMode ?? false
        },
        // Codex 는 전부 "백엔드 기본을 따름". fast mode 는 대응 개념 자체가 없다.
        codex: { model: null, effort: null, permissionMode: null, fastMode: false }
      }
    }
    return { ...raw, settings }
  },
  // v13 → v14: PR 리뷰 세션을 영속화한다. 그 전까지 리뷰는 메모리에만 있었으므로 기존
  // 파일에는 복원할 세션이 없다 — 빈 목록으로 시작한다.
  (raw) => ({ ...raw, reviews: (raw.reviews as ReviewSession[]) ?? [] }),
  // v14 → v15: 리뷰에 에이전트 선택과 "내 PR 인가" 를 붙인다. v14 시절 리뷰는 전부 Claude 로
  // 돌았으므로 그대로 claude 로 채운다. 작성자는 알 길이 없어 비워 두는데, 그래도 위험하지 않다 —
  // 승인 차단은 모르면 막지 않는 쪽(=지금까지와 동일)으로 떨어지고, 제출 직전에 한 번 더 확인한다.
  (raw) => {
    const reviews = ((raw.reviews as Partial<ReviewSession>[]) ?? []).map((r) => ({
      ...r,
      agentBackend: r.agentBackend ?? DEFAULT_AGENT_BACKEND,
      prAuthor: r.prAuthor ?? '',
      viewerIsAuthor: r.viewerIsAuthor ?? false
    }))
    return { ...raw, reviews }
  }
]

/**
 * 디스크에 기록되는 형식 — 런타임 AppState 에 schemaVersion 을 더한 것.
 * schemaVersion 은 파일 형식 전용이라, IPC 로 노출하는 AppState 에는 싣지 않는다.
 */
export type PersistedState = AppState & { schemaVersion: number }

/** 파싱된 임의 버전의 객체를 현재 스키마까지 순차 변환한다. */
export function migrate(
  raw: Record<string, unknown>,
  fromVersion: number
): Record<string, unknown> {
  let migrated = raw
  let version = fromVersion
  // 파일이 더 높은(미래) 버전이면 루프를 건너뛴다.
  while (version < CURRENT_SCHEMA_VERSION) {
    migrated = MIGRATIONS[version](migrated)
    version++
  }
  return migrated
}
