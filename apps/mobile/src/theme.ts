/**
 * 색 토큰.
 *
 * 값은 **데스크톱의 다크 테마에서 그대로 가져온다**(`src/renderer/src/index.css`). 폰이 색을
 * 따로 고르면 두 화면이 조금씩 다른 회색과 다른 보라를 쓰게 되고, 그건 같은 제품으로 읽히지
 * 않는다 — 특히 폰과 랩탑을 나란히 두고 쓰는 도구에서는 바로 눈에 띈다.
 *
 * 데스크톱이 oklch 로 적은 것(강조·상태색)은 같은 값을 sRGB 로 변환해 옮겼다. 색을 새로
 * 고르지 않았다는 뜻이고, 데스크톱 쪽이 바뀌면 여기도 같이 바꿔야 한다.
 *
 * CSS 변수를 그대로 읽어올 방법이 없어(RN 에는 CSS 가 없다) 복제가 불가피하다. 그래서
 * 이름을 데스크톱 변수와 같게 두어, 어느 값이 어디서 왔는지 대조할 수 있게 한다.
 */
export const theme = {
  /** --bg / --bg-2 / --bg-3 */
  bg: '#14161a',
  bg2: '#171a1e',
  bg3: '#1a1d22',

  /** --surface … --surface-4 */
  surface: '#1e2127',
  surface2: '#262a31',
  surface3: '#252932',
  surface4: '#2a313c',

  /** --border … --border-strong */
  border: '#2f333b',
  border2: '#383d46',
  borderStrong: '#4e5768',

  /** --text / --text-muted, 그리고 그보다 더 흐린 보조 텍스트 */
  text: '#e6e7ea',
  textMuted: '#a7aeb9',
  textDim: '#77808d',
  textFaint: '#5f6773',

  /** --accent-400 / --accent-500 (violet) */
  accent: '#a684ff',
  accentStrong: '#8e51ff',
  /** --info-400 / --info-500 (blue) */
  info: '#51a2ff',
  infoStrong: '#2b7fff',
  /** --readonly-400 (cyan) — plan·readOnly 처럼 '멈춤' 계열 강조 */
  readonly: '#00d3f2',
  /** --success-400, --warning-400, --danger-400 */
  success: '#00d492',
  warning: '#ffb900',
  danger: '#ff6467'
} as const
