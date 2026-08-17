import { describe, expect, it } from 'vitest'
import type { PrState } from '@shared/types'
import { darkTheme, lightTheme, prColors, type Theme, type ThemeName } from './theme'

/**
 * 데스크톱이 정의한 PR 상태 전부. 유니언은 런타임에 없으므로 손으로 적되, 배열이 아니라
 * `Record<PrState, true>` 의 키로 적는다 — 상류에 상태가 하나 늘면 **여기서 타입 오류가 난다**
 * (배열로 두면 하나 빠져도 조용히 통과한다).
 */
const PR_STATES = Object.keys({
  draft: true,
  review_required: true,
  changes_requested: true,
  ci_pending: true,
  ci_failed: true,
  approved: true,
  conflict: true,
  open: true,
  merged: true,
  closed: true
} satisfies Record<PrState, true>) as PrState[]

/**
 * 라이트 테마가 깨지는 방식은 대체로 하나다 — "어두운 면 위의 밝은 글자"를 전제로 고른 값을
 * 흰 면에 그대로 옮겨서, 대비가 무너지거나 아예 같은 색 두 개가 겹치는 것. 눈으로는 두 테마를
 * 모든 화면에서 다시 보기 어려우므로 값 자체를 검사한다.
 *
 * TypeScript 가 `Theme` 인터페이스로 **토큰이 빠지는 것**은 이미 막아 준다. 여기서 막는 것은
 * 토큰이 있긴 한데 **쓸 수 없는 값**인 경우다.
 */

/** WCAG 2.1 상대 휘도. */
function luminance(hex: string): number {
  const channels = [1, 3, 5]
    .map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * [앞색, 뒷색, 최소 대비]. 기준은 용도에 맞춘다 — 본문은 AA(4.5), 큰 글자·굵은 버튼 라벨은
 * 큰 글자 AA(3.0), 아이콘과 상태 점은 비문자 대비(3.0).
 */
const PAIRS: [keyof Theme, keyof Theme, number][] = [
  ['text', 'bg', 7],
  ['text', 'surface', 7],
  ['textMuted', 'bg', 4.5],
  ['textDim', 'bg', 4],
  // 타임스탬프·보조 라벨 전용. 본문 기준을 요구하지 않지만 배경에 묻히지는 않아야 한다.
  ['textFaint', 'bg', 2.5],

  // 솔리드 배경 위의 글자 — 테마마다 뒤집히는 값이라 양쪽 다 확인해야 의미가 있다.
  ['onAccent', 'accent', 4.5],
  ['onAccentStrong', 'accentStrong', 4],
  ['onWarning', 'warning', 4.5],

  // 틴트 박스: 면·글자가 한 벌로 뒤집히는지.
  ['warningFg', 'warningSurface', 4.5],
  ['dangerFg', 'dangerSurface', 4.5],

  // 배경 위의 경고·오류 표식은 면 색(warning/danger)이 아니라 전경색을 쓴다.
  ['warningFg', 'bg', 4.5],
  ['dangerFg', 'bg', 4.5],
  // 카드 위의 파괴적 동작 라벨("Unpair this phone").
  ['danger', 'surface', 4.5],

  // 아이콘·상태 점. `warning` 은 여기 없다 — 솔리드 채움과 테두리로만 쓰이고, 배경 위에
  // 직접 놓이는 자리는 전부 warningFg 로 간다.
  ['accent', 'bg', 3],
  ['info', 'bg', 3],
  ['success', 'bg', 3],
  ['danger', 'bg', 3],
  ['readonly', 'bg', 3]
]

/**
 * 같은 색이면 안 되는 짝. 라이트에서 실제로 겹쳤던 조합들이다 — 예를 들어 surface2 는 다크에서
 * 배경보다 밝지만 라이트에서는 `bg` 와 값이 같아서, 그대로 두면 눌러도 아무 반응이 없어 보였다.
 */
const DISTINCT: [keyof Theme, keyof Theme][] = [
  ['bg', 'surface'],
  ['bg', 'border'],
  ['bg', 'pressed'],
  ['surface', 'border'],
  ['text', 'bg'],
  ['diffAddSurface', 'diffRemoveSurface']
]

describe.each([
  ['dark', darkTheme],
  ['light', lightTheme]
] as [ThemeName, Theme][])('%s theme', (name, theme) => {
  it.each(PAIRS)('%s on %s is legible', (foreground, background, minimum) => {
    expect(contrast(theme[foreground], theme[background])).toBeGreaterThanOrEqual(minimum)
  })

  it.each(DISTINCT)('%s and %s are different colors', (one, other) => {
    expect(theme[one]).not.toBe(theme[other])
  })

  it('uses six-digit hex for every token — RN 은 알파 없는 불투명 색을 전제한다', () => {
    for (const [token, value] of Object.entries(theme)) {
      expect(value, token).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  /**
   * PR 색은 9px 점이자 11.5px 글자다(`styles.pr`). 글자 쪽이 더 빡빡한 기준이라 그쪽을 건다 —
   * 라이트에서 400 단계를 그대로 쓰면 draft 가 2.5:1 로 배경에 녹는다.
   */
  it.each(Object.keys(prColors[name]))('pr color %s is legible on the list', (state) => {
    expect(contrast(prColors[name][state], theme.bg)).toBeGreaterThanOrEqual(4)
  })

  /**
   * 빠진 상태는 타입으로 잡히지 않는다(`Record<string, string>` 이고, 색은 런타임 조회다) —
   * 조회에 실패하면 조용히 흐린 회색이 되어 **폰에서만** 그 PR 이 잠잠해 보인다. 실제로
   * ci_pending·ci_failed 가 그렇게 빠져 있었으므로, 값 집합 자체를 대조한다.
   */
  it('PrState 를 하나도 빠뜨리지 않는다', () => {
    for (const state of PR_STATES) {
      expect(prColors[name][state], state).toBeDefined()
    }
  })
})
