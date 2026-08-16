import { prColors } from '../theme'
import { useThemeName } from './theme'

/**
 * 지금 테마의 PR 상태 색. 값과 그 근거는 `theme.ts` 의 `prColors` 에 있다 — 색은 전부 한
 * 파일에 모아 두어야 두 테마를 나란히 놓고 고칠 수 있다.
 */
export function usePrColors(): Record<string, string> {
  return prColors[useThemeName()]
}
