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

/** 뒤/앞 두 방향의 방문 스택. 둘 다 현재 선택은 담지 않는다. */
export interface WorkspaceNavStacks {
  /** 뒤로 갈 곳. 오래된 것이 앞이다. */
  back: string[]
  /** 앞으로 갈 곳. 뒤로가기로 떠난 워크스페이스가 쌓인다. */
  forward: string[]
}

export interface WorkspaceNavStep extends WorkspaceNavStacks {
  /** 옮겨 갈 워크스페이스. 되짚을 곳이 없으면 null 이다. */
  target: string | null
}

/**
 * 뒤 또는 앞으로 한 걸음 옮긴 결과를 낸다.
 *
 * 브라우저와 같은 두 스택 모형이다 — 한쪽에서 꺼낸 만큼 반대쪽에 지금 있던 곳을 쌓는다.
 * 그래서 ⌘[ 로 물러난 만큼 ⌘] 로 정확히 되짚어 올 수 있다.
 *
 * 되짚을 곳이 없으면 target 은 null 이고, 그 방향 스택만 비워진다(죽은 id 청소).
 * 반대쪽은 손대지 않는다 — 갈 곳이 없었다는 사실이 반대 방향까지 지울 이유는 아니다.
 */
export function navigateWorkspaceHistory(
  stacks: WorkspaceNavStacks,
  current: string | null,
  alive: ReadonlySet<string>,
  direction: 'back' | 'forward'
): WorkspaceNavStep {
  const goingBack = direction === 'back'
  const from = goingBack ? stacks.back : stacks.forward
  const { target, history: rest } = popWorkspaceHistory(from, current, alive)
  if (!target) {
    return goingBack
      ? { target: null, back: rest, forward: stacks.forward }
      : { target: null, back: stacks.back, forward: rest }
  }
  const to = pushWorkspaceHistory(goingBack ? stacks.forward : stacks.back, current, target)
  return goingBack ? { target, back: rest, forward: to } : { target, back: to, forward: rest }
}

/**
 * 새 선택을 한 뒤 남길 앞쪽 이력.
 *
 * 뒤로 간 뒤 **새 워크스페이스로 이동하면 앞쪽 가지를 버린다** — 브라우저 관례다. 되짚어 온
 * 길에서 옆으로 새면 그 앞은 더 이상 "왔던 길" 이 아니다.
 *
 * 이미 비어 있으면 받은 배열을 그대로 돌려준다. 매번 새 `[]` 를 만들면 스토어 값의 참조가
 * 계속 바뀌어, 이 값을 보는 셀렉터가 끝없이 다시 그린다.
 */
export function forwardAfterSelect(forward: string[], fromHistory: boolean): string[] {
  if (fromHistory || forward.length === 0) return forward
  return []
}
