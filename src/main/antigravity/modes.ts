import type { PermissionMode } from '@shared/types'
import { normalizePermissionMode } from '@shared/types'
import { ANTIGRAVITY_META } from '../agent/backend'

export function turnArgsFor(mode: PermissionMode | null | undefined): string[] {
  switch (normalizePermissionMode(ANTIGRAVITY_META, mode)) {
    case 'plan':
      return ['--mode', 'plan']
    case 'fullAccess':
      return ['--dangerously-skip-permissions']
    case 'default':
    default:
      // headless 에서는 default·accept-edits 모두 워크스페이스 편집만 통과시키지만,
      // accept-edits 는 편집이 막히지 않음을 명시적으로 보장한다. --mode 가 headless 에 실제
      // 적용된 버전은 1.1.12부터라 MIN_ANTIGRAVITY_VERSION도 정확히 그 버전이다.
      return ['--mode', 'accept-edits']
  }
}

export function asksForApproval(_mode: PermissionMode | null | undefined): boolean {
  // headless -p에는 승인 응답 채널 자체가 없어 확인이 필요한 도구를 soft-deny 한다
  // (CHANGELOG 1.1.3, upstream #794). 따라서 어떤 모드도 승인 카드를 만들 수 없다.
  return false
}
