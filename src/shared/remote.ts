/**
 * 원격 컴패니언(모바일)과 주고받는 와이어 프로토콜.
 *
 * 이 모듈은 **import 를 하나도 갖지 않는다** — React Native(Metro)가 경로 별칭만으로 그대로
 * 소비하기 때문이다. Electron·Node 전용 API 를 참조하는 순간 모바일 번들이 깨진다.
 * (types.ts 도 같은 제약을 만족하며, 두 파일 모두 shared/remote.test.ts 가 지킨다.)
 */

// ── 버전 ─────────────────────────────────────────────────────────────────

/**
 * 프로토콜 버전. 랩탑과 폰이 이 값을 교환해 서로 이해할 수 있는지 판단한다.
 * 와이어 모양(암호 헤더·봉투·명령 인자)이 호환 불가능하게 바뀌면 올린다.
 */
export const REMOTE_PROTOCOL_VERSION = 1

// ── 도메인 투영 ───────────────────────────────────────────────────────────
// 원본 Workspace/AppState 를 그대로 보내지 않는다. 원본에는 절대 worktree 경로, setup/dev/archive
// 스크립트, carry 경로, 수십 KB 짜리 리포 아바타 data URL 이 들어 있는데 모바일에는 하나도 필요
// 없고, 릴레이를 지나가는 바이트는 적을수록 좋다(암호화되어 있어도 크기는 메타데이터다).

/** 지금 사용자의 주의가 필요한 이유. main 이 파생해서 내려 준다. */
export type RemoteAttention = 'permission' | 'error' | null

/** 모바일이 보는 워크스페이스 1개. */
export interface RemoteWorkspace {
  id: string
  repoId: string
  /** worktree 이름(표시 이름의 최종 폴백). */
  name: string
  /** 사용자가 지정한 표시 이름. 없으면 null — 표시 규칙은 types.ts 의 workspaceDisplayName 과 같다. */
  displayName: string | null
  branch: string
  /** 'idle' | 'running' | 'error' (types.ts 의 WorkspaceStatus 와 같은 값). */
  status: string
  /** 'default' | 'acceptEdits' | 'plan' | 'auto' (types.ts 의 PermissionMode 와 같은 값). */
  permissionMode: string
  model: string | null
  effort: string | null
  archived: boolean
  muted: boolean
  prNumber: number | null
  lastActiveAt: number
  attention: RemoteAttention
  /**
   * 이 워크스페이스의 에이전트가 **묻지 않고 실행**하는가.
   *
   * 폰은 이 값으로 프롬프트 전송에 기기 인증을 걸지 말지 정한다. 묻는 모드라면 위험한
   * 일은 전부 권한 프롬프트에 걸리고 그건 이미 인증으로 막혀 있으므로, 전송까지 막으면
   * 아무것도 더 얻지 못하면서 마찰만 늘어난다.
   *
   * 판단을 랩탑이 하는 이유는 **모드 이름이 백엔드마다 다른 뜻이기 때문**이다 — Codex 의
   * 'default' 는 워크스페이스 안에서 묻지 않고 실행하지만, Claude 의 'default' 는 매번
   * 묻는다. 폰은 백엔드를 모르므로 이름만으로는 옳게 판단할 수 없다.
   */
  actsWithoutAsking: boolean
}

/** 모바일이 보는 리포 1개(이름만 — 경로·스크립트·아바타는 보내지 않는다). */
export interface RemoteRepo {
  id: string
  name: string
}

/** 페어링된 기기의 플랫폼. Supabase `devices.platform` 의 check 제약과 같은 값 집합이다. */
export type RemoteDevicePlatform = 'ios' | 'android'

/** 랩탑 자신에 대한 최소 정보. */
export interface RemoteMachine {
  id: string
  name: string
  appVersion: string
}

/** 모바일이 보는 전체 상태 스냅샷. machine_state 행과 Broadcast 양쪽에 같은 모양으로 실린다. */
export interface RemoteState {
  /** 단조 증가. 늦게 도착한 오래된 스냅샷을 폰이 버릴 수 있게 한다. */
  rev: number
  machine: RemoteMachine
  repos: RemoteRepo[]
  workspaces: RemoteWorkspace[]
  /** 지금 응답을 기다리는 권한 요청들(types.ts 의 PermissionRequest 모양). */
  pendingPermissions: unknown[]
}

// ── 브리지 자체 명령 ──────────────────────────────────────────────────────
// 데스크톱 IPC 채널에는 대응물이 없고 원격에만 존재하는 명령들. 이름 충돌을 피하려고
// `remote:` 접두사를 쓴다(IPC 상수와 같은 네임스페이스에 절대 넣지 않는다).

export const REMOTE_IPC = {
  /** 트랜스크립트 tail 페이지 조회. `[workspaceId, { beforeTs?, limit }]` */
  transcript: 'remote:transcript',
  /** 라이브 뷰 구독. `[workspaceId | null]` — 이 리스가 있어야 delta 가 전송된다. */
  watch: 'remote:watch',
  /** 생존 확인. `[]` */
  ping: 'remote:ping'
} as const

/** `remote:transcript` 가 한 번에 돌려주는 최대 아이템 수. */
export const REMOTE_TRANSCRIPT_MAX_LIMIT = 200

/** `remote:transcript` 인자. */
export interface RemoteTranscriptQuery {
  /** 이 시각(epoch ms)보다 **이전** 아이템만. 없으면 최신 페이지. */
  beforeTs?: number
  limit: number
}

// ── 전송 한도 ─────────────────────────────────────────────────────────────

/**
 * 릴레이로 내보내는 이벤트 봉투 1개의 평문 상한(바이트).
 *
 * 초과하면 본문만 잘라 내고 `id`/`type`/`ts` 는 보존한다 — 폰이 그 id 를 보고
 * `remote:transcript` 로 원본을 다시 당겨올 수 있어야 하기 때문이다.
 * (main 의 clamp.ts 상한 512KiB/1MiB 는 Electron IPC 기준이라 릴레이에는 두 자릿수 배 크다.)
 */
export const REMOTE_MAX_EVENT_BYTES = 32 * 1024

/** 원격 `chat:send` 텍스트 상한(바이트). */
export const REMOTE_MAX_PROMPT_BYTES = 32 * 1024

/** 잘린 본문을 대체하는 표식. 폰이 이걸 보면 "원본 당겨오기" 어포던스를 띄운다. */
export const REMOTE_TRUNCATED_MARK = '…[truncated — fetch on phone or open on desktop]'

// ── 명령 봉투 ─────────────────────────────────────────────────────────────

/** 폰 → 랩탑 명령의 평문. 암호화되어 commands.payload_ct 에 들어간다. */
export interface RemoteCommandPayload {
  channel: string
  args: unknown[]
  /**
   * 기기별 단조 증가 시퀀스. 랩탑은 `seq <= devices.last_seq` 를 거부한다 —
   * 캡처된 commands 행을 다시 삽입해 Allow 를 재발동시키는 것을 막는다.
   */
  seq: number
  /** 생성 시각(epoch ms). 랩탑은 5분을 넘게 벗어난 것을 거부한다. */
  ts: number
}

/** 랩탑 → 폰 명령 결과의 평문. */
export type RemoteCommandResult = { ok: true; value: unknown } | { ok: false; error: string }

// ── 데스크톱 설정 패널과의 계약 ───────────────────────────────────────────
// main 이 `evt:remote` 로 내려보내는 상태. **비밀은 하나도 들어 있지 않다.**
// (main 이 아니라 여기 사는 이유: shared 가 main 을 import 하면 렌더러의 타입 그래프가
//  electron 에 의존하게 된다. 계약은 양쪽이 공유하는 곳에 있어야 한다.)

export type RemoteConnectionStatus =
  /** 설정이 없거나 OS 암호화 저장소를 쓸 수 없다 — 기능 자체가 불가능하다. */
  | 'unavailable'
  /** 쓸 수는 있으나 지금 붙어 있지 않다(꺼짐, 또는 재연결 대기). */
  | 'offline'
  | 'connecting'
  | 'online'

export interface RemoteConnectionState {
  status: RemoteConnectionStatus
  /** 사용자에게 보여 줄 마지막 실패 사유. 성공하면 지워진다. */
  lastError: string | null
  /** 익명 로그인이 CAPTCHA 를 요구했다 — UI 가 위젯을 띄워야 진행할 수 있다. */
  needsCaptcha: boolean
  machineId: string | null
}

export type RemotePairingPhase =
  | 'idle'
  /** QR 이 화면에 떠 있고 폰의 claim 을 기다린다. */
  | 'waiting'
  /** 폰이 claim 했다. 사용자가 SAS 를 확인해 주기를 기다린다. */
  | 'confirming'
  /** 확인을 받아 세션키를 전달하는 중. */
  | 'completing'
  | 'done'
  | 'error'

export interface RemotePairingState {
  phase: RemotePairingPhase
  /** QR 에 인코딩할 문자열. `waiting` 동안에만 존재한다. */
  qr: string | null
  /** 양쪽 화면에 띄울 6자리. `confirming` 부터 존재한다. */
  sas: string | null
  /** claim 한 기기가 스스로 밝힌 이름. 신뢰할 수 없는 값이므로 표시 전용이다. */
  deviceName: string | null
  devicePlatform: RemoteDevicePlatform | null
  expiresAt: number | null
  error: string | null
}

export interface RemoteDeviceSummary {
  deviceId: string
  name: string
  platform: RemoteDevicePlatform
  createdAt: number
}

/** 설정 패널이 보는 전부. */
export interface RemoteStatus {
  /** 릴레이 설정이 존재하는가(빌드에 구워졌거나 환경변수로 주어졌는가). */
  configured: boolean
  /** OS 암호화 저장소를 쓸 수 있는가. false 면 기능 전체가 불가능하다. */
  storageAvailable: boolean
  enabled: boolean
  connection: RemoteConnectionState
  pairing: RemotePairingState
  devices: RemoteDeviceSummary[]
  /** 사용자에게 보여 줄 마지막 치명적 오류(키스토어 복호화 실패 등). */
  fault: string | null
}
