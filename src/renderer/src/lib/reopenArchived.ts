/**
 * ⇧⌘T — 방금 아카이브한 워크스페이스를 다시 여는 스택.
 *
 * 브라우저의 "닫은 탭 다시 열기" 와 같은 자리다. 다만 Wooi 에는 탭을 "닫는" 동작이 없으므로,
 * 되돌리는 대상을 **아카이브 한 가지로 못박는다**:
 *
 * - **아카이브(⇧⌘⌫)만 쌓인다.** 아카이브는 worktree 디렉터리만 지우고 브랜치·PR·대화는
 *   남기므로 unarchive 로 worktree 를 다시 만들면 원래 자리로 돌아온다 — 되돌릴 수 있는
 *   동작이다. (worktree 에만 있던 커밋 안 한 파일은 아카이브 시점에 이미 사라졌고 돌아오지
 *   않는다. 이 스택이 되살리는 것은 워크스페이스이지 그 파일이 아니다.)
 * - **영구 삭제(⌥⌘⌫)는 쌓지 않고, 쌓여 있었으면 빼낸다.** 브랜치와 이력까지 지운 것은
 *   되살릴 수 없다. 되돌릴 수 없는 것을 되돌릴 수 있는 것처럼 보이게 두지 않는다.
 *
 * 사이드바에서 직접 unarchive 한 워크스페이스는 굳이 빼지 않는다 — 꺼낼 때 "지금도
 * 아카이브 상태인가" 를 보고 걸러내므로, 어느 경로로 돌아왔든 결과가 같다.
 */

/**
 * 기억할 아카이브 개수.
 *
 * 브라우저가 최근 닫은 탭을 10개쯤 들고 있는 것과 같은 크기로 잡았다. 이 장치는 "방금 그거
 * 잘못 치웠다" 를 되돌리는 용도이고, 그보다 오래된 것을 찾는 일은 사이드바의 아카이브 목록이
 * 이미 더 잘 한다 — 목록을 키우면 ⇧⌘T 를 여러 번 눌러 과거를 헤매게 될 뿐이다.
 */
export const REOPEN_STACK_LIMIT = 10

/** 아카이브한 워크스페이스를 스택 맨 위에 올린다. 같은 id 는 하나만 남긴다. */
export function pushReopenable(stack: string[], id: string): string[] {
  return [...stack.filter((existing) => existing !== id), id].slice(-REOPEN_STACK_LIMIT)
}

/** 다시 열 수 없게 된 워크스페이스(영구 삭제)를 스택에서 뺀다. */
export function dropReopenable(stack: string[], id: string): string[] {
  return stack.includes(id) ? stack.filter((existing) => existing !== id) : stack
}

/**
 * 다시 열 워크스페이스 하나를 꺼낸다.
 *
 * `reopenable` 은 "지금 존재하고 아카이브 상태인" id 집합이다. 그 사이 영구 삭제됐거나
 * 사이드바에서 이미 되살린 것은 다시 열 것이 아니므로 건너뛰고 더 아래를 본다.
 */
export function nextReopenable(
  stack: string[],
  reopenable: ReadonlySet<string>
): { target: string | null; stack: string[] } {
  const rest = [...stack]
  while (rest.length) {
    const id = rest.pop()
    if (!id || !reopenable.has(id)) continue
    return { target: id, stack: rest }
  }
  return { target: null, stack: [] }
}
