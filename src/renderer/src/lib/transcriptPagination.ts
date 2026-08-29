/**
 * 대화 기록을 뒤에서부터 한 페이지씩 읽어 오기 위한 셈.
 *
 * 예전에는 워크스페이스를 고를 때마다 트랜스크립트를 통째로 받아 MessageList 가 전부 그렸다.
 * 며칠 이어 쓴 워크스페이스로 전환하면 첫 페인트가 그 전체를 이고 갔고, 그 뒤의 검색·스크롤도
 * 계속 같은 DOM 을 끌고 다녔다. 그래서 최근 몇 턴만 먼저 읽고, 위로 올라가면 더 읽는다.
 *
 * IO 도 React 도 없이 순수하게 둔다 — 늘어나는 limit 과 "더 있나" 판정만 여기 있다.
 */

/** 첫 페인트에 읽을 개수. 대부분의 대화는 여기서 끝나 지금까지와 똑같이 보인다. */
export const TRANSCRIPT_INITIAL_LIMIT = 300
/** 위로 올라갔을 때 한 번에 더 읽는 개수. */
export const TRANSCRIPT_PAGE = 200
/** 이만큼 위에 닿으면 다음 페이지를 부른다. 버튼을 누르기 전에 이어지는 것이 기본 흐름이다. */
export const TRANSCRIPT_TOP_THRESHOLD_PX = 80

/** 다음 페이지까지 포함한 limit. 매번 꼬리부터 다시 읽으므로 창을 넓히는 방식이다. */
export function nextTranscriptLimit(currentLimit: number): number {
  return currentLimit + TRANSCRIPT_PAGE
}

/**
 * 더 오래된 것이 남아 있을 수 있는가.
 *
 * 요청한 만큼 꽉 채워 왔다면 그 뒤에 더 있을지도 모른다. 요청보다 적게 왔다면 대화의 머리에
 * 닿은 것이므로 더 부를 것이 없다 — 이때 버튼을 감춘다.
 */
export function hasMoreTranscriptHistory(returnedCount: number, requestedLimit: number): boolean {
  return returnedCount >= requestedLimit
}

/**
 * 위쪽에 내용을 덧붙였을 때 사용자가 보던 지점을 그대로 두는 스크롤 위치.
 *
 * 앞에 항목이 끼어들면 콘텐츠가 위로 자라므로, 자란 만큼 scrollTop 을 밀어 줘야 화면이 튀지
 * 않는다. 브라우저는 이걸 대신 해 주지 않는다.
 */
export function restoredScrollTop(
  anchor: { scrollHeight: number; scrollTop: number },
  nextScrollHeight: number
): number {
  return Math.max(0, anchor.scrollTop + (nextScrollHeight - anchor.scrollHeight))
}
