import type { RemoteState } from '@shared/remote'

/**
 * 앱 아이콘 배지 = **지금 내 주의가 필요한 워크스페이스 수.**
 *
 * 데스크톱 Dock 배지와 같은 규칙이다(`src/renderer/src/store.ts` 의 refreshBadge):
 * 미확인 완료 + 권한 대기를, 워크스페이스 단위로 중복 없이 센다. 둘이 겹쳐도 1 이다 —
 * 배지가 답하는 질문은 "몇 건인가"가 아니라 "몇 군데를 봐야 하는가"다.
 *
 * 에러는 따로 세지 않는다. 에러로 끝난 턴도 랩탑에서 미확인으로 잡히므로 이미 포함돼 있고,
 * 따로 세면 읽은 뒤에도 숫자가 남는다(에러 상태는 읽는다고 사라지지 않는다).
 *
 * 음소거·아카이브는 뺀다. 데스크톱이 같은 것을 빼며, 음소거는 "이건 알려 주지 마라"는
 * 사용자의 명시적인 말이라 화면을 갈라 놓으면 안 된다.
 */
export function attentionCount(state: RemoteState | null): number {
  if (state === null) return 0
  const needsAttention = new Set<string>()
  for (const workspace of state.workspaces) {
    if (workspace.archived || workspace.muted) continue
    // `unread` 는 구형 랩탑이 보내지 않는다(undefined) — 모르는 것을 세지 않는다.
    if (workspace.unread === true || workspace.attention === 'permission') {
      needsAttention.add(workspace.id)
    }
  }
  return needsAttention.size
}
