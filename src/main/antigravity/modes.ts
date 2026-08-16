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
      // `--mode` 가 받는 값은 **accept-edits 와 plan 둘뿐**이다. 1.1.13 실측:
      //   agy --help          → "--mode  Set the agent execution mode (accept-edits, plan)"
      //   agy --mode default  → warning: unrecognized --mode value "default"
      // 즉 Wooi 의 `default` 모드에 대응하는 CLI 값은 accept-edits 하나이고, 그래서 이 백엔드는
      // "편집은 통과 / 셸 명령은 거부" 와 "전부 허용" 사이에 중간이 없다.
      // `--mode` 가 headless 에 실제로 적용되는 것은 1.1.12부터라 MIN_ANTIGRAVITY_VERSION 도
      // 정확히 그 버전이다.
      return ['--mode', 'accept-edits']
  }
}

export function asksForApproval(_mode: PermissionMode | null | undefined): boolean {
  // headless -p에는 승인 응답 채널 자체가 없어 확인이 필요한 도구를 soft-deny 한다
  // (CHANGELOG 1.1.3, upstream #794). 따라서 어떤 모드도 승인 카드를 만들 수 없다.
  return false
}
