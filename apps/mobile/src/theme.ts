/**
 * 색 토큰 — 다크와 라이트 두 벌.
 *
 * 값은 **데스크톱 테마에서 그대로 가져온다**(`src/renderer/src/index.css`). 폰이 색을
 * 따로 고르면 두 화면이 조금씩 다른 회색과 다른 보라를 쓰게 되고, 그건 같은 제품으로 읽히지
 * 않는다 — 특히 폰과 랩탑을 나란히 두고 쓰는 도구에서는 바로 눈에 띈다.
 *
 * 데스크톱이 oklch 로 적은 것(강조·상태색)은 같은 값을 sRGB 로 변환해 옮겼다. 색을 새로
 * 고르지 않았다는 뜻이고, 데스크톱 쪽이 바뀌면 여기도 같이 바꿔야 한다.
 *
 * 라이트에서 강조·상태색이 다크와 다른 이유도 데스크톱과 같다 — 200/300/400 은 "어두운 면
 * 위의 밝은 글자"를 전제로 한 값이라 흰 면에서는 대비가 무너진다. 그래서 데스크톱이
 * `html[data-theme='light']` 에서 하는 것과 똑같이 400 → 600 으로 한 단계 어둡게 뒤집는다.
 * 500(accentStrong·infoStrong) 은 뒤집지 않는다 — 솔리드 버튼 배경의 기준값이라 어둡게
 * 만들면 버튼이 깨진다.
 *
 * CSS 변수를 그대로 읽어올 방법이 없어(RN 에는 CSS 가 없다) 복제가 불가피하다. 그래서
 * 이름을 데스크톱 변수와 같게 두어, 어느 값이 어디서 왔는지 대조할 수 있게 한다.
 */

export type ThemeName = 'dark' | 'light'

/** 사용자가 고를 수 있는 값. 데스크톱의 `ThemePreference` 와 같은 세 가지다. */
export type ThemePreference = 'system' | ThemeName

export interface Theme {
  /** --bg / --bg-2 / --bg-3 */
  bg: string
  bg2: string
  bg3: string

  /** --surface … --surface-4 */
  surface: string
  surface2: string
  surface3: string
  surface4: string

  /** --border … --border-strong */
  border: string
  border2: string
  borderStrong: string

  /** --text / --text-muted, 그리고 그보다 더 흐린 보조 텍스트 */
  text: string
  textMuted: string
  textDim: string
  textFaint: string

  /** --accent-400 / --accent-500 (violet) */
  accent: string
  accentStrong: string
  /** --info-400 / --info-500 (blue) */
  info: string
  infoStrong: string
  /** --readonly-400 (cyan) — plan·readOnly 처럼 '멈춤' 계열 강조 */
  readonly: string
  /** --success-400, --warning-400, --danger-400 */
  success: string
  warning: string
  danger: string

  /**
   * 솔리드 배경 위의 글자색. 다크에서는 강조색이 밝아 어두운 글자가 얹히지만 라이트에서는
   * 같은 강조색이 어두워져 흰 글자여야 한다 — 즉 이 값은 테마마다 **뒤집힌다**. 배경색에서
   * 유추하지 말고 이 토큰을 쓴다.
   */
  onAccent: string
  onAccentStrong: string
  onWarning: string

  /**
   * 틴트 박스(경고·오류 배너, 권한 거절 안내). 면·테두리·전경을 한 벌로 둔다 — 셋 중 하나만
   * 테마를 따라가면 라이트에서 흰 글자가 흰 면에 얹히는 식으로 무너진다.
   *
   * `warning`/`danger` 와 `*Fg` 를 갈라 두는 이유는 데스크톱의 `--warning-fg` 와 같다 —
   * 앞의 것은 **면·테두리**(뒤에 깔리는 색)이고 뒤의 것은 **글자·아이콘**(앞에 놓이는 색)이다.
   * 다크에서는 둘이 같은 값이라 구분이 안 보이지만, 라이트에서는 갈린다: amber-600 은 솔리드
   * 버튼 배경으로는 좋아도 밝은 회색 위의 11px 글자로는 2.9:1 밖에 나오지 않는다.
   */
  warningSurface: string
  warningBorder: string
  warningFg: string
  dangerSurface: string
  dangerBorder: string
  dangerFg: string

  /**
   * 화면 배경(카드가 아니라 --bg) 위에 놓인 버튼의 누름 피드백. 카드 위라면 surface2 로
   * 충분하지만 화면 배경 위에서는 그 값이 라이트에서 배경과 같은 색이라, 눌러도 아무 일도
   * 일어나지 않는 것처럼 보인다.
   */
  pressed: string

  /** diff 줄 배경 — 코드 표면 위에 얹히므로 본문 대비를 해치지 않을 만큼만 물들인다. */
  diffAddSurface: string
  diffRemoveSurface: string
}

export const darkTheme: Theme = {
  bg: '#14161a',
  bg2: '#171a1e',
  bg3: '#1a1d22',

  surface: '#1e2127',
  surface2: '#262a31',
  surface3: '#252932',
  surface4: '#2a313c',

  border: '#2f333b',
  border2: '#383d46',
  borderStrong: '#4e5768',

  text: '#e6e7ea',
  textMuted: '#a7aeb9',
  textDim: '#77808d',
  textFaint: '#5f6773',

  accent: '#a684ff',
  accentStrong: '#8e51ff',
  info: '#51a2ff',
  infoStrong: '#2b7fff',
  readonly: '#00d3f2',
  success: '#00d492',
  warning: '#ffb900',
  danger: '#ff6467',

  onAccent: '#12101f',
  onAccentStrong: '#ffffff',
  onWarning: '#14161a',

  warningSurface: '#2d2510',
  warningBorder: '#5c4a15',
  warningFg: '#ffb900',   // 다크에서는 warning 과 같은 값 — 어두운 면 위에서는 갈릴 이유가 없다
  dangerSurface: '#2a1719',
  dangerBorder: '#5c3036',
  dangerFg: '#ef8d8d',

  pressed: '#262a31',

  diffAddSurface: '#14251c',
  diffRemoveSurface: '#2b171a'
}

export const lightTheme: Theme = {
  bg: '#f4f4f5',
  bg2: '#ffffff',
  bg3: '#ebebee',

  surface: '#ffffff',
  surface2: '#f4f4f5',
  surface3: '#efeff1',
  surface4: '#eaeaed',

  border: '#e3e3e6',
  border2: '#d8d8dc',
  borderStrong: '#bcbcc4',

  text: '#18181b',
  textMuted: '#52525b',
  // 데스크톱에는 이 두 단계가 없다(--text/--text-muted 뿐). 다크 쪽 textDim/textFaint 가
  // 배경에 대해 갖는 대비(4.5:1 / 3.2:1)를 흰 면에서 그대로 재현하는 zinc 값을 골랐다.
  textDim: '#71717b',
  textFaint: '#8a8a94',

  // 400 → 600 뒤집기. 500 두 개(accentStrong·infoStrong)는 다크와 같은 값이다.
  accent: '#7f22fe',
  accentStrong: '#8e51ff',
  info: '#155dfc',
  infoStrong: '#2b7fff',
  readonly: '#007595',
  success: '#009966',
  warning: '#e17100',
  danger: '#e7000b',

  onAccent: '#ffffff',
  onAccentStrong: '#ffffff',
  onWarning: '#18181b',

  warningSurface: '#fffbeb',
  warningBorder: '#fee685',
  warningFg: '#973c00',   // amber-800: 밝은 면·틴트 위 본문/아이콘용
  dangerSurface: '#fef2f2',
  dangerBorder: '#ffc9c9',
  dangerFg: '#9f0712',

  pressed: '#e4e4e8',

  diffAddSurface: '#ecfdf5',
  diffRemoveSurface: '#fef2f2'
}

export const themes: Record<ThemeName, Theme> = {
  dark: darkTheme,
  light: lightTheme
}

/**
 * PR 상태별 색. 의미와 계열은 데스크톱 사이드바의 `PR_DOT` 과 같다 — 두 화면이 같은 색으로
 * 같은 것을 말해야 한눈에 읽힌다.
 *
 * 라이트 값은 데스크톱보다 한 단계 더 어둡다(400 → 700). 데스크톱은 이 색을 **점**으로만
 * 쓰지만 폰은 같은 색으로 `#123 · Ready to merge` 를 11.5px 글자로도 적기 때문이다 — 점에는
 * 충분한 3:1 이 그 크기의 글자에는 못 미친다. 중립색 둘(draft·closed)도 같은 이유로 내렸다.
 * 다크 값은 데스크톱 그대로다(어두운 면에서는 400 이 이미 6:1 을 넘는다).
 *
 * **PrState 의 값을 하나도 빠뜨리면 안 된다.** 빠진 상태는 색을 못 찾아 흐린 회색으로 떨어지고,
 * 그러면 폰에서만 그 PR 이 아무 일도 없는 것처럼 보인다 — ci_pending·ci_failed 가 실제로
 * 그랬다. 계열은 데스크톱과 같다(둘 다 warning/danger).
 */
export const prColors: Record<ThemeName, Record<string, string>> = {
  dark: {
    draft: '#9a9aa3',
    review_required: '#ffb900',
    changes_requested: '#ff8904',
    ci_pending: '#ffb900',
    ci_failed: '#ff6467',
    approved: '#00d492',
    conflict: '#ff6467',
    open: '#a684ff',
    merged: '#c27aff',
    closed: '#77767f'
  },
  light: {
    draft: '#63636d',
    review_required: '#973c00',
    changes_requested: '#ca3500',
    ci_pending: '#973c00',
    ci_failed: '#c10007',
    approved: '#007a55',
    conflict: '#c10007',
    open: '#7008e7',
    merged: '#8200db',
    closed: '#71717b'
  }
}
