import type { PermissionMode } from '@shared/types'
import { normalizePermissionMode } from '@shared/types'
import { CODEX_META } from '../agent/backend'

/**
 * Wooi 권한 모드 → Codex 의 실행 정책.
 *
 * Claude 는 모드가 곧 하나의 설정값이지만, Codex 는 **샌드박스 정책 × 승인 정책 × 협업 모드**의
 * 조합이다. 그 조합을 한 곳에 모아 둔다 — 흩어지면 "Read only 인데 파일이 써졌다" 같은 사고가
 * 어디서 났는지 추적할 수 없다.
 *
 * 중요한 차이: Claude 는 도구 호출을 프롬프트로 막지만 **Codex 는 OS 샌드박스로 강제**한다.
 * 그래서 승인 정책만 바꾸고 샌드박스를 그대로 두면 실제로는 막히지 않는다 — 둘을 항상 같이 정한다.
 */

/** app-server 의 sandboxPolicy 파라미터. */
export type SandboxPolicy =
  | { type: 'readOnly' }
  | { type: 'workspaceWrite'; writableRoots: string[]; networkAccess: boolean }
  | { type: 'dangerFullAccess' }

/** app-server 의 approvalPolicy(AskForApproval) 파라미터. */
export type ApprovalPolicy = 'never' | 'untrusted' | 'on-failure' | 'on-request'

/**
 * `thread/start` 가 받는 단순 샌드박스 모드.
 *
 * 턴은 상세한 `sandboxPolicy` 객체를 받지만 **스레드 생성은 이 문자열만 받는다** — 스레드에
 * sandboxPolicy 를 보내면 서버가 모르는 필드로 조용히 무시하고 설정 기본값으로 스레드를 연다.
 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export interface CodexTurnPolicy {
  sandboxPolicy: SandboxPolicy
  /** thread/start 용. 같은 의도를 문자열 모드로 표현한 것. */
  sandboxMode: SandboxMode
  approvalPolicy: ApprovalPolicy
  /**
   * 협업 모드 이름. 'plan' 은 Codex 의 Plan 프리셋(읽기 전용 + 계획 수립 지침)을 켠다.
   * undefined 면 기본 모드.
   */
  collaborationMode?: 'plan'
}

/**
 * 워크스페이스의 권한 모드를 이번 턴의 실행 정책으로 옮긴다.
 *
 * @param mode  워크스페이스에 저장된 모드. Codex 가 모르는 값(다른 백엔드에서 넘어온 기본값)은
 *              Codex 기본 모드로 보정된다.
 * @param worktreePath 쓰기를 허용할 루트. 워크스페이스 격리의 핵심이라 항상 worktree 로 좁힌다.
 */
export function turnPolicyFor(
  mode: PermissionMode | null | undefined,
  worktreePath: string
): CodexTurnPolicy {
  switch (normalizePermissionMode(CODEX_META, mode)) {
    // 읽기만 허용. 쓰기·실행은 매번 승인을 받는다.
    case 'readOnly':
      return {
        sandboxPolicy: { type: 'readOnly' },
        sandboxMode: 'read-only',
        approvalPolicy: 'on-request'
      }

    // Plan 모드 — 읽기 전용은 같고, 협업 모드가 "실행하지 말고 계획하라"는 지침을 얹는다.
    case 'plan':
      return {
        sandboxPolicy: { type: 'readOnly' },
        sandboxMode: 'read-only',
        approvalPolicy: 'on-request',
        collaborationMode: 'plan'
      }

    // 승인·샌드박스 모두 해제. 네트워크까지 열린다.
    case 'fullAccess':
      return {
        sandboxPolicy: { type: 'dangerFullAccess' },
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never'
      }

    // 기본(Auto): worktree 안에서는 자유롭게, 벗어나거나 네트워크가 필요하면 승인.
    // networkAccess 를 false 로 두는 것이 중요하다 — 켜면 샌드박스 안이라도 외부로 나갈 수 있다.
    case 'default':
    default:
      return {
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [worktreePath],
          networkAccess: false
        },
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request'
      }
  }
}

/**
 * 이 모드가 승인 프롬프트를 띄울 수 있는가.
 *
 * fullAccess 는 approvalPolicy='never' 라 서버가 승인 요청을 보내지 않는다. UI 가 "승인 대기"
 * 상태를 기대하지 않도록 알려 주는 용도.
 */
export function asksForApproval(mode: PermissionMode | null | undefined): boolean {
  return turnPolicyFor(mode, '/').approvalPolicy !== 'never'
}
