/**
 * `data-tour="<key>"` 요소를 찾아 그 옆에 카드를 띄우는 배치 계산. `FeatureTour`(전체 투어)와
 * `Hint`(점진적 힌트)가 함께 쓴다 — 뷰포트 클램핑을 포함한 배치 로직이 두 군데로 갈라지면
 * 여백·잘림 버그가 각자 따로 난다. 원래 `FeatureTour.tsx` 안에만 있던 로직을 그대로 옮긴 것이다.
 */

export type Placement = 'right' | 'left' | 'bottom' | 'top'

export interface AnchorBox {
  top: number
  left: number
  width: number
  height: number
}

/** `data-tour="key"` 요소를 찾아 뷰포트 기준 박스를 돌려준다. DOM 에 없으면 null. */
export function measureAnchor(key: string): AnchorBox | null {
  const el = document.querySelector(`[data-tour="${key}"]`)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { top: r.top, left: r.left, width: r.width, height: r.height }
}

/**
 * 앵커 박스 기준으로 카드의 고정 위치를 계산한다. 뷰포트 밖으로 넘어가지 않게 대략적으로
 * 보정한다(카드 높이는 `maxCardHeight` 로 넉넉히 잡아 계산한다 — 실측하지 않는다).
 */
export function anchorStyle(
  rect: AnchorBox,
  placement: Placement,
  cardWidth: number,
  maxCardHeight = 300
): React.CSSProperties {
  const gap = 16
  const vw = window.innerWidth
  const vh = window.innerHeight
  let top: number
  let left: number
  if (placement === 'left') {
    left = rect.left - gap - cardWidth
    top = rect.top
  } else if (placement === 'bottom') {
    left = rect.left
    top = rect.top + rect.height + gap
  } else if (placement === 'top') {
    // 앵커가 화면 아래쪽(예: 컴포저 하단 안내줄)에 있을 때 카드가 뷰포트 밖으로 밀려나지
    // 않도록, 앵커 위에 띄운다. 실제 카드 높이를 재지 않고 maxCardHeight 로 근사한다 — 아래
    // 클램핑과 같은 방식(FeatureTour 시절부터의 관례).
    left = rect.left
    top = rect.top - gap - maxCardHeight
  } else {
    // right (default)
    left = rect.left + rect.width + gap
    top = rect.top
  }
  left = Math.max(12, Math.min(left, vw - cardWidth - 12))
  top = Math.max(12, Math.min(top, vh - maxCardHeight))
  return { position: 'fixed', top, left, width: cardWidth }
}
