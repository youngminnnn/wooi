/**
 * PR 상태별 색. 값과 의미는 데스크톱 사이드바의 `PR_DOT` 과 같다 — 두 화면이 같은 색으로
 * 같은 것을 말해야 한눈에 읽힌다. 데스크톱은 oklch 테마 변수를 쓰므로 그 값을 그대로 변환해
 * 옮겼다(색을 새로 고르지 않았다).
 */
export const PR_COLORS: Record<string, string> = {
  draft: '#9a9aa3',
  review_required: '#ffb900',
  changes_requested: '#ff8904',
  approved: '#00d492',
  conflict: '#ff6467',
  open: '#a684ff',
  merged: '#c27aff',
  closed: '#77767f'
}
