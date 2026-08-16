import Svg, { Circle, Defs, LinearGradient, Path, Stop } from 'react-native-svg'
import { WOOI_MARK } from '@shared/brandMarks'

/**
 * Wooi 로고. 데스크톱 사이드바·타이틀바와 **같은 모양**을 그린다(`@shared/brandMarks`).
 *
 * 앱 아이콘(홈 화면에 보이는 한글 "우이")을 화면 안에 그대로 쓰지 않는 이유: 아이콘은 큰 자리
 * 하나를 위한 워드마크라 헤더의 36pt 에서는 두 글자가 뭉개지고, 무엇보다 랩탑 화면과 폰 화면이
 * 서로 다른 마크를 내보이면 같은 제품으로 읽히지 않는다.
 *
 * 그라데이션 id 는 화면에 여러 번 그려도 겹치지 않도록 고정 문자열을 쓴다 — 정의가 동일해서
 * 어느 쪽이 이겨도 같은 그림이 나온다.
 */
export function WooiLogo({ size = 18 }: { size?: number }): React.JSX.Element {
  const { gradient } = WOOI_MARK
  return (
    <Svg width={size} height={size} viewBox={WOOI_MARK.viewBox} fill="none">
      <Defs>
        <LinearGradient
          id="wooiLogoGrad"
          gradientUnits="userSpaceOnUse"
          x1={gradient.x1}
          y1={gradient.y1}
          x2={gradient.x2}
          y2={gradient.y2}
        >
          <Stop offset="0" stopColor={gradient.from} />
          <Stop offset="1" stopColor={gradient.to} />
        </LinearGradient>
      </Defs>
      <Path
        d={WOOI_MARK.path}
        fill="none"
        stroke="url(#wooiLogoGrad)"
        strokeWidth={WOOI_MARK.strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {WOOI_MARK.nodes.map((node) => (
        <Circle
          key={`${node.cx},${node.cy}`}
          cx={node.cx}
          cy={node.cy}
          r={node.r}
          fill="url(#wooiLogoGrad)"
        />
      ))}
    </Svg>
  )
}
