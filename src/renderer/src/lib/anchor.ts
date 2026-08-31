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

function sameBox(a: AnchorBox | null, b: AnchorBox | null): boolean {
  if (!a || !b) return a === b
  return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height
}

/**
 * 앵커가 움직이는 동안 계속 따라간다. 값이 실제로 바뀔 때만 `onChange` 를 부르고, 정리 함수를
 * 돌려준다.
 *
 * `resize` 이벤트만으로는 부족하다 — 창 크기가 그대로여도 앵커는 움직인다. 실제로 그랬다:
 * 워크스페이스를 연 직후 git 조회가 끝나면 헤더 오른쪽에 Rebase 버튼이 붙으면서 작업 패널
 * 토글이 왼쪽으로 밀리는데, 링과 카드는 처음 잰 자리에 남아 **엉뚱한 빈 곳을 가리켰다**.
 * 화면 좌표를 바꿀 수 있는 경로(비동기 데이터·글꼴·스크롤·애니메이션)를 일일이 구독하는 것보다
 * 프레임마다 재는 편이 단순하고 빠짐이 없다. 힌트는 한 번에 하나만, 잠깐만 떠 있으므로
 * 이 루프의 수명도 그만큼 짧다.
 */
export function observeAnchor(key: string, onChange: (box: AnchorBox | null) => void): () => void {
  let raf = 0
  let last: AnchorBox | null | undefined
  const tick = (): void => {
    const next = measureAnchor(key)
    if (last === undefined || !sameBox(last, next)) {
      last = next
      onChange(next)
    }
    raf = requestAnimationFrame(tick)
  }
  tick()
  return () => cancelAnimationFrame(raf)
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
