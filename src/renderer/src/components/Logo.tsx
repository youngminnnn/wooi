import { WOOI_MARK } from '@shared/brandMarks'

/**
 * Wooi 로고 — 머리글자 W 를 커밋 그래프로 그린 모노그램.
 *
 * 모양은 `@shared/brandMarks` 의 `WOOI_MARK` 한 곳에서 온다. 폰(`apps/mobile`)의 화면들도
 * 같은 값을 그리므로, 로고를 손볼 일이 생기면 여기가 아니라 그 상수를 고친다.
 */
export default function Logo({ size = 18 }: { size?: number }): React.JSX.Element {
  const { gradient } = WOOI_MARK
  return (
    <svg
      width={size}
      height={size}
      viewBox={WOOI_MARK.viewBox}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Wooi"
    >
      <defs>
        <linearGradient
          id="wooi-logo-grad"
          gradientUnits="userSpaceOnUse"
          x1={gradient.x1}
          y1={gradient.y1}
          x2={gradient.x2}
          y2={gradient.y2}
        >
          <stop offset="0" stopColor={gradient.from} />
          <stop offset="1" stopColor={gradient.to} />
        </linearGradient>
      </defs>
      {/* 브랜치 선 */}
      <path
        d={WOOI_MARK.path}
        fill="none"
        stroke="url(#wooi-logo-grad)"
        strokeWidth={WOOI_MARK.strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* 커밋 노드 */}
      {WOOI_MARK.nodes.map((node) => (
        <circle
          key={`${node.cx},${node.cy}`}
          cx={node.cx}
          cy={node.cy}
          r={node.r}
          fill="url(#wooi-logo-grad)"
        />
      ))}
    </svg>
  )
}
