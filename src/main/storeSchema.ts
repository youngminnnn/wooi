import { CLAUDE_DEFAULT_MODEL } from './agent/backend'
import { randomUUID } from 'node:crypto'
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
export const CURRENT_SCHEMA_VERSION = 25

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
  toolLogStyle: 'wooi',
  defaultAgentBackend: DEFAULT_AGENT_BACKEND,
  agents: {
    // Claude 는 검증된 기본 모델을 지정한다(1M 윈도를 잡는 `[1m]` 접미사 포함).
    claude: {
      model: DEFAULT_MODEL,
      effort: null,
      permissionMode: 'default',
      fastMode: false,
      fallbackModels: []
    },
    // Codex 는 카탈로그 기본 모델·기본 effort 를 그대로 따른다(null = 백엔드 기본).
    // 모델과 effort는 Codex 카탈로그 기본값을 따르고 fast tier는 기본적으로 끈다.
    codex: { model: null, effort: null, permissionMode: null, fastMode: false, fallbackModels: [] }
  },
  // 기본은 OS 를 따른다. 이미 쓰던 사람은 영향이 없다 — load 의 병합은 저장된 값이 이기고
  // (`{...DEFAULT_SETTINGS, ...saved}`), 테마 기능이 나간 뒤로는 이 키가 항상 파일에 있다.
  // 즉 이 값이 실제로 쓰이는 것은 새 설치와, 테마 키가 없던 시절의 파일뿐이다.
  theme: 'system',
  soundOnComplete: true,
  notifications: DEFAULT_NOTIFICATION_SETTINGS,
  // 우측 작업 패널은 기본 펼침. 기존 사용자도 load 의 기본값 병합으로 펼침을 유지한다.
  defaultRightPanelOpen: true,
  // 실행 중인 서브에이전트 목록은 기본 켜짐 — 병렬로 도는 작업을 보여 주는 것이 이 앱의 본령이라
  // 옵트인으로 숨겨 둘 이유가 없다. 기존 사용자도 load 의 기본값 병합으로 켜진 상태가 되므로
  // schemaVersion 을 올릴 필요가 없다.
  showRunningAgents: true,
  // 최근 활동 stack 자동 승격은 기본 켜짐. 새 필드라 기본값 병합만으로 구버전도 적용된다.
  autoSortWorkspacesByActivity: true,
  // 점진적 힌트는 기본 켜짐 — 예전 일괄 투어가 하던 소개를 대신하는 것이라, 이 필드가 없던
  // 버전에서 올라온 사용자에게도 똑같이 보여야 한다. schemaVersion 을 올려 마이그레이션에서도
  // 명시적으로 채운다(showRunningAgents 와 달리 — plan 이 명시적인 회귀 가드를 요구했다).
  showHints: true,
  // CLI 와 동일하게 자동 압축을 기본 켜둔다(autoCompactEnabled). 압축을 트리거하는 임계치는
  // Claude Code 가 모델별로 알려주는 값을 그대로 쓴다(session.ts 의 overAutoCompactThreshold).
  autoCompact: true,
  // 자동 실행은 명시적인 opt-in 이어야 한다. 출시 공지와 설정에서 사용자가 직접 켠다.
  autoResumeAfterRateLimit: false,
  // 사용자가 이미 시작한 턴을 종료 뒤 잇는 것이므로, 새 작업을 여는 레이트리밋 자동 재개와 달리
  // 기본으로 켠다. 옛 파일도 기본값 병합으로 이 값을 받으므로 schemaVersion 은 올리지 않는다.
  resumeUnfinishedTurnsOnLaunch: true,
  // 충돌 해결 턴은 토큰을 쓰므로 기본은 꺼짐 — 기존 사용자도 load 의 기본값 병합으로 false 가
  // 되므로 schemaVersion 을 올릴 필요가 없다.
  autoResolveConflicts: false,
  // 수면 방지는 기본 켜짐 — 걸어두고 자리를 뜬 턴이 맥이 잠들어 멈추는 것이 이 앱에서 가장
  // 흔한 손실이고, 화면을 켜 두지 않으므로 비용이 작다. 기존 사용자도 load 의 기본값 병합으로
  // true 가 되므로 schemaVersion 을 올릴 필요가 없다.
  keepAwakeWhileRunning: true,
  // 백그라운드 계속하기도 기본 켜짐 — ⌘Q 한 번에 도는 턴이 사라지는 것이 수면과 같은 종류의
  // 손실이다. 실제 종료 여부는 확인 다이얼로그에서 사용자가 고르고, 기존 사용자도 load 의
  // 기본값 병합으로 true 가 되므로 schemaVersion 을 올릴 필요가 없다.
  keepWorkingInBackground: true,
  // 아무 확인도 꺼져 있지 않은 상태로 시작한다. 기존 사용자도 load 의 기본값 병합으로 빈
  // 객체가 되므로 schemaVersion 을 올릴 필요가 없다.
  confirmSkips: {},
  manualWorkspaceSetup: false,
  onboarded: false,
  // 아직 기본값을 고르지 않음 — 기존 사용자도 load 의 기본값 병합으로 false 가 되어,
  // 이 필드가 없던 버전(v1.0.3 이하)에서 올라오면 다음 실행에 한 번 질문을 받는다.
  pickedDefaults: false,
  // 미동의(null) 로 시작 — 기존 사용자도 load 의 기본값 병합으로 null 이 되어 (재)동의를 요구한다.
  acceptedTermsVersion: null,
  // 원격 접근은 옵트인이다. 꺼져 있으면 릴레이에 아무것도 보내지 않는다.
  remoteEnabled: false,
  // 동의는 원격을 켜는 순간에 받는다. 기본값은 '아직 안 함'이다.
  remoteConsentVersion: null,
  // 모르는 상태에서는 닫아 둔다 — 열려 있다고 확인된 뒤에만 보인다.
  remoteAccessAvailable: false,
  // 푸시는 제3자 전달망을 지나므로 원격 접근과 별도로 명시적으로 켜야 한다.
  remotePushEnabled: false,
  // 데스크톱을 쓰는 동안은 폰을 깨우지 않는 편이 기본이다. 항상 받고 싶으면 설정에서 켠다.
  remotePushWhileActive: false,
  // 보고 있는 워크스페이스의 알림은 누른다 — 예전 동작("창이 앞에 있으면 무조건 억제")에서
  // 워크스페이스 단위로 좁힌 것이다. 기존 사용자도 load 의 기본값 병합으로 true 가 되므로
  // schemaVersion 을 올릴 필요가 없다([[shared/types]] suppressWhenFocused).
  suppressWhenFocused: true
}

export const EMPTY_STATE: AppState = {
  repos: [],
  workspaces: [],
  unreadWorkspaceIds: [],
  fanoutGroups: [],
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
    const list = (raw.workspaces as Array<Partial<Workspace> & { devPort?: number | null }>) ?? []
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
  //
  // 이미 agents 를 가진 파일은 그대로 둔다 — 예전에는 마이그레이션 뒤에도 파일의 schemaVersion 이
  // 그대로 남아(store.ts 참고) 이 변환이 매 부팅마다 다시 돌았고, 옛 필드가 없으니 agents 를
  // 기본값으로 새로 만들어 사용자의 권한 모드·모델 선택을 지웠다. 버전 기록은 고쳤지만, 이미
  // 낮은 버전으로 굳은 파일이 마지막으로 한 번 더 지워지지 않도록 여기서도 막는다.
  (raw) => {
    const legacy = (raw.settings as LegacySettingsV12) ?? {}
    if (legacy.agents) return raw
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
    // 이 시점의 리뷰는 PR 하나짜리 평면 레코드였다(v21 에서 layers 로 접힌다).
    const reviews = ((raw.reviews as Array<Record<string, unknown>>) ?? []).map((r) => ({
      ...r,
      agentBackend: r.agentBackend ?? DEFAULT_AGENT_BACKEND,
      prAuthor: r.prAuthor ?? '',
      viewerIsAuthor: r.viewerIsAuthor ?? false
    }))
    return { ...raw, reviews }
  },

  // v15 → v16: 판정 두 필드(lastVerdict·lastVerdictAt)를 lastSubmission 하나로 합친다.
  // 그때의 중복 차단은 본문·head sha 비교로 돌아갔는데 옛 레코드에는 그 둘이 없어 null 로 뒀다
  // (v17 에서 비교 자체가 사라졌으므로 지금은 판정 칩이 한 번 비는 것 말고는 영향이 없다).
  (raw) => {
    const reviews = ((raw.reviews as Record<string, unknown>[]) ?? []).map((r) => {
      const { lastVerdict: _v, lastVerdictAt: _at, ...rest } = r
      return { ...rest, lastSubmission: rest.lastSubmission ?? null }
    })
    return { ...raw, reviews }
  },

  // v16 → v17: 제출 기록에서 본문과 head sha 를 뺀다. 같은 리뷰를 또 내는 것은 이제 본문 비교가
  // 아니라 "제출하면 총평을 비운다" 로 막으므로, 이 둘은 아무도 읽지 않는 사본일 뿐이다.
  (raw) => {
    const reviews = ((raw.reviews as Record<string, unknown>[]) ?? []).map((r) => {
      const last = r.lastSubmission as Record<string, unknown> | null | undefined
      if (!last) return r
      const { body: _body, headSha: _sha, ...rest } = last
      return { ...r, lastSubmission: rest }
    })
    return { ...raw, reviews }
  },

  // v17 → v18: 리뷰가 자기 모델·추론 강도를 들고 다닌다(시작할 때 고른 값으로 후속 턴까지 돈다).
  // 옛 리뷰는 무엇으로 돌았는지 알 길이 없으므로 비워 두고, 후속 턴은 지금까지처럼 전역
  // 기본값으로 떨어진다.
  (raw) => {
    const reviews = ((raw.reviews as Partial<ReviewSession>[]) ?? []).map((r) => ({
      ...r,
      model: r.model ?? null,
      effort: r.effort ?? null
    }))
    return { ...raw, reviews }
  },

  // v18 → v19: 워크스페이스가 자기를 만든 주체를 기억한다. 에이전트가 만든 워크스페이스만 그
  // 에이전트가 아카이브할 수 있게 하려면([[agent/tools/target]]) 생성자를 알아야 하는데, 지금까지는
  // 아무도 기록하지 않았다.
  //
  // 기존 워크스페이스는 전부 null 로 둔다. 부모가 있다고 해서 그 부모의 에이전트가 만들었다고
  // 단정할 수 없고(사람이 UI 에서 만든 스택이 그렇다), 여기서 잘못 추측하면 에이전트가 사람의
  // 워크스페이스를 지울 권한을 소급해 얻는다. 모를 때는 아무 권한도 주지 않는 쪽이 맞다.
  (raw) => {
    const workspaces = ((raw.workspaces as Partial<Workspace>[]) ?? []).map((w) => ({
      ...w,
      createdByWorkspaceId: w.createdByWorkspaceId ?? null
    }))
    return { ...raw, workspaces }
  },

  // v19 → v20: 단일 dev 명령과 포트를 리포별 run script 목록과 script-id별 포트로 옮긴다.
  (raw) => {
    const ids = new Map<string, string>()
    const repos = ((raw.repos as Array<Record<string, unknown>>) ?? []).map((repo) => {
      const { devScript, ...rest } = repo
      const command = typeof devScript === 'string' ? devScript.trim() : ''
      const id = command ? randomUUID() : null
      if (id && typeof repo.id === 'string') ids.set(repo.id, id)
      return {
        ...rest,
        runScripts: id ? [{ id, name: 'Dev', command: devScript as string, autoStart: false }] : []
      }
    })
    const workspaces = ((raw.workspaces as Array<Record<string, unknown>>) ?? []).map(
      (workspace) => {
        const { devPort, ...rest } = workspace
        const id = typeof workspace.repoId === 'string' ? ids.get(workspace.repoId) : undefined
        return {
          ...rest,
          ports: id && typeof devPort === 'number' ? { [id]: devPort } : {}
        }
      }
    )
    return { ...raw, repos, workspaces }
  },

  // v20 → v21: fan-out 그룹(같은 프롬프트로 동시에 만든 후보 묶음) 도입. 기존 워크스페이스는
  // 어떤 묶음에도 속하지 않는다 — 과거에 나란히 만든 것을 지금 와서 한 그룹으로 추측하면
  // 사용자가 만든 적 없는 "채택" 대상이 생기고, 채택은 형제를 아카이브하는 동작이다.
  (raw) => ({ ...raw, fanoutGroups: [] }),

  // v21 → v22: 리뷰가 PR 하나가 아니라 **레이어 목록**을 본다(스택 리뷰).
  // PR 단위였던 필드(번호·제목·head sha·워터마크·판정)를 원소가 하나인 layers 로 접는다 —
  // 옛 리뷰는 그 자체로 "레이어가 하나인 스택" 이므로 정보를 잃지 않는다.
  (raw) => {
    const reviews = ((raw.reviews as Array<Record<string, unknown>>) ?? []).map((r) =>
      foldReviewIntoLayer(r)
    )
    return { ...raw, reviews }
  },

  // v22 → v23: ChatGPT 로그인 Codex 에서 2026-08-31 폐기되는 gpt-5.4 계열 저장값을 비운다.
  // null 은 특정 후속 모델을 박는 값이 아니라 Codex 카탈로그 기본값을 따르라는 뜻이다 —
  // gpt-5.6-terra/luna 중 하나를 여기서 추측하지 않고, 당시 카탈로그가 고른 기본값에 맡긴다.
  (raw) => {
    const workspaces = ((raw.workspaces as Partial<Workspace>[]) ?? []).map((workspace) => ({
      ...workspace,
      model:
        workspace.agentBackend === 'codex' && workspace.model?.startsWith('gpt-5.4')
          ? null
          : workspace.model
    }))
    return { ...raw, workspaces }
  },
  // v23 → v24: 완료 응답의 미확인 배지를 앱 재시작 뒤에도 복원한다. 과거에는 렌더러 메모리에만
  // 살아 기존 파일에서 옮겨 올 값이 없으므로 빈 목록으로 시작한다.
  (raw) => ({ ...raw, unreadWorkspaceIds: [] }),

  // v24 → v25: 점진적 온보딩 힌트를 끄는 전역 스위치(showHints) 도입. 기존 사용자도 기본
  // 켜짐으로 시작한다 — 이 필드가 없던 버전에서 올라온 사람에게도 예전 일괄 투어를 대신하는
  // 안내이니 똑같이 보여야 한다. settings 외에는 아무것도 건드리지 않는다(v5→v6 이 onboarded
  // 를 실수로 초기화했던 사고를 storeSchema.test.ts 가 회귀로 걸어 둔 것과 같은 이유).
  (raw) => {
    const settings = { ...((raw.settings as Partial<AppSettings>) ?? {}) }
    settings.showHints = true
    return { ...raw, settings }
  }
]

/**
 * PR 단위 필드를 원소 하나짜리 `layers` 로 접는다. 이미 `layers` 가 있으면 그대로 둔다.
 *
 * 마이그레이션과 normalizeShape 이 함께 쓴다 — 구버전 빌드가 최신 버전 파일에 이어서 쓰면
 * 버전은 최신인데 레코드는 옛 모양이라 마이그레이션이 돌지 않는다(#267 과 같은 구멍).
 * `layers` 가 비면 화면이 통째로 빈 리뷰를 그리므로 여기서 반드시 메워야 한다.
 */
function foldReviewIntoLayer(r: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(r.layers) && r.layers.length > 0) {
    return typeof r.truncatedFiles === 'number' ? r : { ...r, truncatedFiles: 0 }
  }
  const {
    prNumber,
    prUrl,
    prTitle,
    prAuthor,
    viewerIsAuthor,
    headSha,
    baseRefName,
    lastSeenAt,
    lastSeenHeadSha,
    lastSubmission,
    ...rest
  } = r
  // 번호조차 없는 레코드는 접을 것이 없다 — 빈 레이어 목록으로 두면 화면이 "레코드 없음" 으로
  // 그리므로, 오히려 알아볼 수 있는 상태다.
  if (typeof prNumber !== 'number') return { ...rest, layers: [], truncatedFiles: 0 }
  return {
    ...rest,
    truncatedFiles: typeof r.truncatedFiles === 'number' ? r.truncatedFiles : 0,
    layers: [
      {
        prNumber,
        prUrl: typeof prUrl === 'string' ? prUrl : '',
        prTitle: typeof prTitle === 'string' ? prTitle : '',
        prAuthor: typeof prAuthor === 'string' ? prAuthor : '',
        viewerIsAuthor: viewerIsAuthor === true,
        headSha: typeof headSha === 'string' ? headSha : '',
        // 옛 레코드는 head 브랜치 이름을 남기지 않았다. 프롬프트의 표시용일 뿐이라 비워 둔다.
        headRefName: '',
        baseRefName: typeof baseRefName === 'string' ? baseRefName : '',
        merged: false,
        lastSeenAt: typeof lastSeenAt === 'string' ? lastSeenAt : null,
        lastSeenHeadSha: typeof lastSeenHeadSha === 'string' ? lastSeenHeadSha : '',
        // 옛 레코드의 총평은 세션에 있고 그것이 곧 이 유일한 레이어의 총평이다. 복사하지 않고
        // 비워 둔다 — 두 곳에 같은 문장이 있으면 제출 모달이 그것을 두 번 싣는다.
        summary: '',
        lastSubmission: (lastSubmission as Record<string, unknown> | null) ?? null
      }
    ]
  }
}

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

/**
 * 마이그레이션이 손대지 못한 레코드를 현재 모양으로 메운다.
 *
 * 마이그레이션만으로는 부족한 경우가 실제로 있다. `schemaVersion` 이 이미 최신인 파일에
 * **구버전 빌드가 이어서 쓰면** 그 빌드가 만든 레코드는 옛 모양인데, 버전은 최신이라 다음
 * 부팅에서 마이그레이션이 돌지 않는다. Wooi 개발 중에는 흔한 조합이다 — `npm run dev` 는
 * 브랜치가 달라도 같은 `Wooi (dev)` 를 쓰므로, 신·구 브랜치를 오가면 바로 이 상태가 된다.
 *
 * 실제로 v20 이전 빌드가 만든 워크스페이스에는 `ports` 가 없어, 새 워크스페이스를 만들 때
 * `Object.values(w.ports)` 가 "Cannot convert undefined or null to object" 로 터졌다.
 * 그래서 버전과 무관하게, **읽을 때마다** 컬렉션 필드가 비어 있지 않음을 보장한다.
 *
 * 값이 있는 필드는 절대 건드리지 않는다 — 미래 버전 파일을 구버전이 읽는 상황(다운그레이드)에서
 * 여기서 값을 덮으면 데이터가 손상된다. 없는 것을 채우기만 한다.
 */
export function normalizeShape(raw: Record<string, unknown>): Record<string, unknown> {
  const repos = ((raw.repos as Array<Record<string, unknown>>) ?? []).map((repo) => {
    const withRunScripts = Array.isArray(repo.runScripts) ? repo : { ...repo, runScripts: [] }
    // savedPrompts 는 옵셔널이라 **없으면 없는 채로 둔다** — 빈 배열로 메우면 다운그레이드한
    // 구버전이 그 키를 그대로 다시 쓸 뿐이고, 스키마 버전을 올리지 않으려는 이유도 사라진다.
    // 다만 배열이 아닌 값은 지운다. 목록을 그냥 순회하는 화면들이 그것 하나로 통째로 멈춘다.
    if (!('savedPrompts' in withRunScripts) || Array.isArray(withRunScripts.savedPrompts))
      return withRunScripts
    const { savedPrompts: _malformed, ...rest } = withRunScripts
    return rest
  })
  const workspaces = ((raw.workspaces as Array<Record<string, unknown>>) ?? []).map((workspace) =>
    isRecord(workspace.ports) ? workspace : { ...workspace, ports: {} }
  )
  // fan-out 그룹도 같은 이유로 여기서 메운다. v21 이전 빌드가 최신 버전 파일에 이어서 쓰면
  // 이 배열이 통째로 사라지는데, 사이드바·비교 화면은 그것을 그냥 순회한다.
  const fanoutGroups = Array.isArray(raw.fanoutGroups) ? raw.fanoutGroups : []
  const reviews = ((raw.reviews as Array<Record<string, unknown>>) ?? []).map((review) =>
    foldReviewIntoLayer(review)
  )
  const unreadWorkspaceIds = Array.isArray(raw.unreadWorkspaceIds) ? raw.unreadWorkspaceIds : []
  return { ...raw, repos, workspaces, unreadWorkspaceIds, fanoutGroups, reviews }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
