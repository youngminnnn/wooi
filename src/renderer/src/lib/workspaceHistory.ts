/**
 * ⌘[ 뒤로가기가 되짚는 워크스페이스 방문 기록.
 *
 * 브라우저 뒤로가기와 같은 스택이다 — 현재 선택은 담지 않고, 오래된 것이 앞이다.
 * A → B → C 로 옮겼다면 기록은 [A, B] 이고, ⌘[ 두 번이면 B → A 로 거슬러 올라간다.
 * (사이드바 순서를 훑는 ⌘↑ / ⌘↓ 와는 다른 축이다 — 그쪽은 목록 위치, 이쪽은 방문 순서.)
 */

/** 한 세션에서 아무리 많이 오가도 메모리가 늘지 않을 만큼만 남긴다. */
export const WORKSPACE_HISTORY_LIMIT = 50

/**
 * 선택이 바뀔 때 기록에 직전 워크스페이스를 쌓는다.
 *
 * 뒤로가기로 온 선택(`fromHistory`)은 이미 스택을 팝한 것이므로 다시 쌓지 않는다 —
 * 그러지 않으면 ⌘[ 가 두 워크스페이스 사이를 오가기만 하고 더 거슬러 올라가지 못한다.
 */
export function pushWorkspaceHistory(
  history: string[],
  prev: string | null,
  next: string | null,
  fromHistory = false
): string[] {
  if (fromHistory || !prev || prev === next) return history
  return [...history, prev].slice(-WORKSPACE_HISTORY_LIMIT)
}

/**
 * 돌아갈 워크스페이스 하나를 기록에서 꺼낸다.
 *
 * 아카이브·삭제된 워크스페이스(`alive` 에 없는 id)는 돌아갈 곳이 아니므로 그 앞의 기록까지
 * 계속 거슬러 올라간다. 돌아갈 곳이 없으면 target 은 null 이고 기록은 비워진다.
 */
export function popWorkspaceHistory(
  history: string[],
  current: string | null,
  alive: ReadonlySet<string>
): { target: string | null; history: string[] } {
  const rest = [...history]
  while (rest.length) {
    const id = rest.pop()
    if (!id || id === current || !alive.has(id)) continue
    return { target: id, history: rest }
  }
  return { target: null, history: [] }
}
