import Svg, { Path } from 'react-native-svg'
import { CLAUDE_MARK, CODEX_MARK } from '@shared/brandMarks'
import { useTheme } from '../state/theme'

/**
 * 에이전트 백엔드 마크. 데스크톱 사이드바와 **같은 SVG 경로**를 그린다(`@shared/brandMarks`) —
 * 두 화면이 같은 그림을 쓰지 않으면 "무엇으로 돌고 있나"를 읽는 시각 언어가 갈린다.
 *
 * 모르는 백엔드는 그리지 않는다(null). 값은 다른 기기에서 오는 문자열이라 이 앱이 모르는
 * 백엔드가 올 수 있고, 그때 억지로 뭔가를 그리면 틀린 정보가 된다 — 없는 편이 정직하다.
 */
export function BrandMark({
  backend,
  size = 12
}: {
  backend: string | undefined
  size?: number
}): React.JSX.Element | null {
  const theme = useTheme()
  if (backend === 'claude') {
    return (
      <Svg width={size} height={size} viewBox={CLAUDE_MARK.viewBox}>
        <Path d={CLAUDE_MARK.path} fill={CLAUDE_MARK.fill} />
      </Svg>
    )
  }
  if (backend === 'codex') {
    return (
      <Svg width={size} height={size} viewBox={CODEX_MARK.viewBox}>
        <Path d={CODEX_MARK.path} fill={theme.textMuted} />
      </Svg>
    )
  }
  return null
}
