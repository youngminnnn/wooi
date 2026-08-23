import type { Workspace } from '@shared/types'
import { describeWorkspaceActivity, type StackedChildState } from './agent/tools/workspaceState'

/**
 * 대기가 보는 사유. 상태 어휘는 [[agent/tools/workspaceState]] 의 것을 그대로 쓰고, 저쪽에 없는
 * 둘만 더한다 — 아카이브(활동이 아니라 수명의 끝이라 저쪽이 다루지 않는다)와 `resuming`.
 */
export type StackedProgressReason = StackedChildState | 'archived' | 'resuming'

export interface StackedProgress {
  canProgress: boolean
  reason: StackedProgressReason
}

/**
 * 이 자식이 **아직 스스로 진행할 수 있는가**. `await_stacked_work` 가 "남은 자식이 전부 멈췄으니
 * 더 기다릴 이유가 없다" 를 판정하는 근거다([[stackedWait]]).
 *
 * 판정을 여기서 새로 만들지 않고 `describeWorkspaceActivity` 에서 **파생**한다. 한때 같은 신호를
 * 각자 읽었는데, 그때 순서가 어긋나 실제로 틀렸다 — 이쪽이 `running` 을 승인 대기보다 먼저 봤고,
 * 승인 카드에 걸린 워크스페이스는 `status` 가 `running` 이라 "진행 가능" 으로 읽혔다. 정지의 가장
 * 흔한 이유가 바로 승인 대기인데 그 길이 영영 열리지 않았던 것이다.
 *
 * 그래서 **우선순위 자체가 계약이다.** 사이드바 StatusDot 이 그 순서를 정해 두었고
 * (승인 대기 → running → 레이트리밋 → error → 백그라운드 → idle), 파생 판정은 그것을 다시
 * 발명하지 않는다. 여기서 얹는 해석은 단 하나 — 자동 이어가기가 예약된 레이트리밋은 사람 손 없이
 * 스스로 풀리므로 "진행 가능" 이다.
 *
 * 승인 대기 여부를 인자로 받지 않는 것도 그래서다. `describeWorkspaceActivity` 가 `pendingPermissions`
 * 를 직접 읽으므로, 부르는 쪽이 그 조회를 따로 들고 다니면 두 목록이 갈릴 수 있다.
 */
export function stackedChildProgress(child: Workspace, now = Date.now()): StackedProgress {
  // 아카이브는 활동 상태가 아니라 수명의 끝이라 저쪽이 답하지 않는다. 되돌아올 수 없으므로 먼저 본다.
  if (child.archived) return { canProgress: false, reason: 'archived' }

  const { state } = describeWorkspaceActivity(child, now)
  // 예약이 있으면 시각이 되는 대로 Wooi 가 이어 보낸다([[rateLimitResume]]) — 기다릴 값이 있다.
  if (state === 'rate-limited' && child.pendingRateLimitResume) {
    return { canProgress: true, reason: 'resuming' }
  }
  // 나머지는 전부 "지금 턴이 도는가" 하나로 갈린다. 백그라운드 셸이 남아 있어도 에이전트 자신은
  // 유휴라 보고가 오지 않으므로 진행으로 세지 않는다.
  return { canProgress: state === 'running', reason: state }
}
