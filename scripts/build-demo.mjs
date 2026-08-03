#!/usr/bin/env node
/**
 * 데모 애니메이션 생성기 — docs/demo.svg 를 만든다.
 *
 * 화면 녹화·스크린샷 캡처를 쓰지 않는다. 장면과 타임라인을 아래 데이터로 기술하고
 * 순수 SVG + 인라인 CSS keyframes 로 내보내므로, 결과물은 벡터라 어떤 배율에서도
 * 선명하고 GitHub README 와 랜딩 페이지에서 그대로 재생된다.
 *
 * 색·치수·문구는 실제 앱(src/renderer)에서 가져온 값이다. UI 가 바뀌면 이 파일의
 * 상수만 고치고 `npm run demo` 로 다시 만든다.
 *
 * 좌표는 "Tailwind 클래스를 픽셀로 푼 값"이다. 예: 헤더 h-12 = 48px, px-4 = 16px,
 * text-base = 13px/1.5. 글자 폭(TW)은 실제 폰트로 미리 측정한 값이라, 요소를 이어 붙일 때
 * 앱과 같은 자리에 놓인다.
 *
 *   node scripts/build-demo.mjs
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'demo.svg')

const W = 1280
const H = 800
const APP_H = 740 // 앱 화면 높이. 아래 60px 은 캡션 띠.
const DUR = 16 // 루프 길이(초)

/* ── 색 — src/renderer/src/index.css 의 다크 토큰. oklch 는 Tailwind v4 팔레트 hex 로 확정. ── */
const C = {
  // 배경 / 표면 / 경계선
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
  codeInlineBg: '#262a31',
  codeFg: '#c9d1d9',
  // 중립(Tailwind v4 neutral)
  n100: '#f5f5f5',
  n200: '#e5e5e5',
  n300: '#d4d4d4',
  n400: '#a1a1a1',
  n500: '#737373',
  n600: '#525252',
  // 시맨틱(index.css 의 oklch 와 같은 Tailwind v4 색)
  info200: '#bedbff',
  info300: '#8ec5ff',
  info400: '#51a2ff',
  info500: '#2b7fff',
  info600: '#155dfc',
  warning200: '#fee685',
  warning400: '#ffb900',
  warning500: '#fe9a00',
  success200: '#a4f4cf',
  success400: '#00d492',
  success500: '#00bc7d',
  accent300: '#c4b4ff',
  accent400: '#a684ff',
  danger300: '#ffa2a2',
  danger400: '#ff6467',
  danger500: '#fb2c36',
  purple400: '#c27aff'
}

/* ── 글자 폭 실측값(px). 같은 폰트 스택·크기로 미리 잰 값이라 요소를 이어 붙일 때 쓴다. ── */
const TW = {
  unread: 56.19,
  needs: 81.91,
  stopAll: 39.39,
  count: 6.97,
  wooi: 31.34,
  overview: 53.89,
  searchWs: 112.3,
  cmdK: 17.75,
  acme: 60.67,
  h1: 126.59,
  h2: 81.94,
  hb1: 94.02,
  hb2: 88.91,
  hc1: 97.02,
  hc2: 86.67,
  stack: 30.31,
  stackCount: 41.03,
  pr41: 19.05,
  pr42: 20.69,
  prLabel1: 85.97,
  prLabel2: 84.13,
  slBranch1: 94.02,
  slDir1: 66.33,
  slModel: 106.63,
  slEffort: 24.33,
  slFast: 47.63,
  slPct: 23.94,
  foot1: 95.08,
  toolName: 28.5
}

/* ── lucide 아이콘(24x24) — 앱이 쓰는 것과 같은 버전의 패스 ── */
const ICONS = {
  loader: 'M21 12a9 9 0 1 1-6.219-8.56',
  shield:
    'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z|M9.1 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3|M12 17h.01',
  belldot:
    'M10.268 21a2 2 0 0 0 3.464 0|M11.68 2.009A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673c-.824-.85-1.678-1.731-2.21-3.348',
  bell: 'M10.268 21a2 2 0 0 0 3.464 0|M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326',
  settings:
    'M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915',
  settings2: 'M14 17H5|M19 7h-9',
  plus: 'M5 12h14|M12 5v14',
  chevrondown: 'm6 9 6 6 6-6',
  chevronright: 'm9 18 6-6-6-6',
  branch: 'M15 6a9 9 0 0 0-9 9V3',
  branchplus: 'M6 3v12|M15 6a9 9 0 0 0-9 9|M18 15v6|M21 18h-6',
  foldergit:
    'M18 19a5 5 0 0 1-5-5v8|M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v5',
  dashboard: '',
  search: 'm21 21-4.34-4.34',
  layers:
    'M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z|M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12|M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17',
  check: 'M20 6 9 17l-5-5',
  circlecheck: 'm9 12 2 2 4-4',
  clock: 'M12 6v6l4 2',
  extlink: 'M15 3h6v6|M10 14 21 3|M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
  terminal: 'M12 19h8|m4 17 6-6-6-6',
  code: 'm18 16 4-4-4-4|m6 8-4 4 4 4|m14.5 4-5 16',
  folderopen:
    'm6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2',
  folder:
    'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
  download: 'M12 15V3|M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4|m7 10 5 5 5-5',
  panel: 'M15 3v18',
  refresh:
    'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8|M21 3v5h-5|M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16|M8 16H3v5',
  send: 'M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z|m21.854 2.147-10.94 10.939',
  zap: 'M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z',
  gauge: 'm12 14 4-4|M3.34 19a10 10 0 1 1 17.32 0',
  rabbit:
    'M13 16a3 3 0 0 1 2.24 5|M18 12h.01|M18 21h-8a4 4 0 0 1-4-4 7 7 0 0 1 7-7h.2L9.6 6.4a1 1 0 1 1 2.8-2.8L15.8 7h.2c3.3 0 6 2.7 6 6v1a2 2 0 0 1-2 2h-1a3 3 0 0 0-3 3|M20 8.54V4a2 2 0 1 0-4 0v3|M7.612 12.524a3 3 0 1 0-1.6 4.3',
  cpu: 'M12 20v2|M12 2v2|M17 20v2|M17 2v2|M2 12h2|M2 17h2|M2 7h2|M20 12h2|M20 17h2|M20 7h2|M7 20v2|M7 2v2',
  wrench:
    'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z',
  pencil:
    'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z|m15 5 4 4',
  archive: 'M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8|M10 12h4'
}
/** 패스만으로 안 되는 아이콘의 보조 도형(원·사각형). */
const ICON_EXTRA = {
  branch: '<circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>',
  branchplus: '<circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>',
  belldot: '<circle cx="18" cy="5" r="3" fill="currentColor" stroke="none"/>',
  settings: '<circle cx="12" cy="12" r="3"/>',
  settings2: '<circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  foldergit: '<circle cx="13" cy="12" r="2"/><circle cx="20" cy="19" r="2"/>',
  search: '<circle cx="11" cy="11" r="8"/>',
  clock: '<circle cx="12" cy="12" r="10"/>',
  circlecheck: '<circle cx="12" cy="12" r="10"/>',
  panel: '<rect x="3" y="3" width="18" height="18" rx="2"/>',
  archive: '<rect x="2" y="3" width="20" height="5" rx="1"/>',
  cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="8" y="8" width="8" height="8" rx="1"/>',
  dashboard:
    '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  dots: '<circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/>'
}

/* ─────────────────────────── 출력 헬퍼 ─────────────────────────── */
const body = []
const css = []
let seq = 0
const uid = (p = 'a') => `${p}${(++seq).toString(36)}`
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const num = (v) => (Math.round(v * 100) / 100).toString()
const push = (s) => body.push(s)

/** 폰트 크기 px 인 한 줄의 중심 y 에서 baseline 을 구한다. */
const bl = (cy, px = 13) => cy + px * 0.36

function rect(x, y, w, h, o = {}) {
  const a = [`x="${num(x)}"`, `y="${num(y)}"`, `width="${num(w)}"`, `height="${num(h)}"`]
  if (o.r) a.push(`rx="${num(o.r)}"`)
  a.push(`fill="${o.fill || 'none'}"`)
  if (o.stroke) a.push(`stroke="${o.stroke}"`, `stroke-width="${o.sw || 1}"`)
  return `<rect ${a.join(' ')}/>`
}

/** 좌하단만 덜 둥근 사용자 말풍선(rounded-2xl + rounded-br-md). */
function bubble(x, y, w, h, fill) {
  const R = 16
  const r2 = 6
  const d =
    `M${num(x + R)},${num(y)} H${num(x + w - R)} A${R},${R} 0 0 1 ${num(x + w)},${num(y + R)} ` +
    `V${num(y + h - r2)} A${r2},${r2} 0 0 1 ${num(x + w - r2)},${num(y + h)} ` +
    `H${num(x + R)} A${R},${R} 0 0 1 ${num(x)},${num(y + h - R)} ` +
    `V${num(y + R)} A${R},${R} 0 0 1 ${num(x + R)},${num(y)} Z`
  return `<path d="${d}" fill="${fill}"/>`
}

/**
 * y 는 baseline. segs: [{t, px, mono, fill, w, weight}]
 * w(실측 폭)를 주면 x·textLength 를 박아 플랫폼과 무관하게 같은 폭으로 렌더한다.
 * w 가 없으면 첫 조각에만 x 를 주고 나머지는 자연스럽게 이어 흐르게 둔다.
 */
function rich(x, y, segs, o = {}) {
  let cx = x
  const parts = segs.map((s, i) => {
    const at = []
    if (s.w != null) {
      at.push(`x="${num(cx)}"`, `textLength="${num(s.w)}"`, 'lengthAdjust="spacingAndGlyphs"')
      cx += s.w
    } else if (i === 0) {
      at.push(`x="${num(x)}"`)
    }
    if (s.mono) at.push('class="m"')
    if (s.px) at.push(`font-size="${s.px}"`)
    if (s.fill) at.push(`fill="${s.fill}"`)
    if (s.weight) at.push(`font-weight="${s.weight}"`)
    return `<tspan ${at.join(' ')}>${esc(s.t)}</tspan>`
  })
  const a = [`y="${num(y)}"`, `font-size="${o.px || 13}"`, `fill="${o.fill || C.n300}"`]
  if (o.weight) a.push(`font-weight="${o.weight}"`)
  if (o.anchor) a.push(`text-anchor="${o.anchor}"`)
  if (o.mono) a.push('class="m"')
  if (o.ls) a.push(`letter-spacing="${o.ls}"`)
  return `<text ${a.join(' ')}>${parts.join('')}</text>`
}

/** 단순 텍스트. y 는 baseline. */
function text(x, y, s, o = {}) {
  const a = [
    `x="${num(x)}"`,
    `y="${num(y)}"`,
    `font-size="${o.px || 13}"`,
    `fill="${o.fill || C.n300}"`
  ]
  if (o.weight) a.push(`font-weight="${o.weight}"`)
  if (o.anchor) a.push(`text-anchor="${o.anchor}"`)
  if (o.mono) a.push('class="m"')
  if (o.ls) a.push(`letter-spacing="${o.ls}"`)
  return `<text ${a.join(' ')}>${esc(s)}</text>`
}

/** x,y = 아이콘 좌상단. */
function icon(name, x, y, size, color, o = {}) {
  const d = ICONS[name] || ''
  const paths = d
    ? d
        .split('|')
        .map((p) => `<path d="${p}"/>`)
        .join('')
    : ''
  const extra = ICON_EXTRA[name] || ''
  const s = size / 24
  return (
    `<g transform="translate(${num(x)},${num(y)}) scale(${num(s)})" ` +
    `fill="none" stroke="${color}" stroke-width="${num(o.sw || 2)}" ` +
    `stroke-linecap="round" stroke-linejoin="round" color="${color}">${paths}${extra}</g>`
  )
}

/** h-2 w-2 상태 점(사이드바·스택 팝오버 공통). */
const dot = (cx, cy, fill) => `<circle cx="${num(cx)}" cy="${num(cy)}" r="4" fill="${fill}"/>`

/* ─────────────────────────── 타임라인 ─────────────────────────── */
// 계단형 스톱이 1ms 간격이라 소수 4자리까지 살려야 두 프레임이 겹치지 않는다.
const pct = (t) => (Math.round((Math.max(0, Math.min(DUR, t)) / DUR) * 1e6) / 1e4).toString()

/** prop 별 keyframes 를 만들고 애니메이션 이름을 돌려준다. */
function keyframes(prop, stops) {
  const name = uid('k')
  const seen = new Set()
  const frames = stops
    .slice()
    .sort((a, b) => a[0] - b[0])
    .filter(([t]) => {
      const p = pct(t)
      if (seen.has(p)) return false
      seen.add(p)
      return true
    })
    .map(([t, v]) => `${pct(t)}%{${prop}:${v}}`)
    .join('')
  css.push(`@keyframes ${name}{${frames}}`)
  return name
}

/**
 * 자식들을 <g> 로 감싸고 CSS 애니메이션을 건다.
 * tracks: { opacity: [[t,v],…], transform: [[t,'translate(1px,2px)'],…] }
 */
function animated(children, tracks, o = {}) {
  const id = uid('g')
  const names = Object.entries(tracks).map(([prop, stops]) => keyframes(prop, stops))
  const rules = [`animation:${names.map((n) => `${n} ${DUR}s linear infinite`).join(',')}`]
  if (o.origin) rules.push(`transform-origin:${o.origin}`)
  if (o.extra) rules.push(o.extra)
  css.push(`#${id}{${rules.join(';')}}`)
  return `<g id="${id}">${children}</g>`
}

/** 0 → 1 → 0. t2/t3 를 생략하면 끝까지 보인다. */
function fade(t0, t1, t2, t3) {
  const s = [[0, 0]]
  if (t0 > 0.001) s.push([t0, 0])
  s.push([t1, 1])
  if (t2 != null) {
    s.push([t2, 1], [t3, 0], [DUR, 0])
  } else {
    s.push([DUR, 1])
  }
  return s
}

/** [t0,t1) 구간에만 보이는 계단형 스톱(전환 없이 딱 끊는다). */
function only(t0, t1) {
  const s = [[0, t0 <= 0 ? 1 : 0]]
  if (t0 > 0) s.push([t0 - 0.001, 0], [t0, 1])
  if (t1 != null && t1 < DUR) s.push([t1 - 0.001, 1], [t1, 0])
  s.push([DUR, t1 == null || t1 >= DUR ? 1 : 0])
  return s
}

/* ─────────────────────────── 화면 상수 ─────────────────────────── */
const TITLE_H = 44 // h-11
const SIDE_W = 288 // w-72
const CONTENT_X = SIDE_W + 1 // 콘텐츠 영역은 border-l 1px 뒤에서 시작한다.
const HEADER_BOT = TITLE_H + 48 // h-12

// 메시지 열: max-w-3xl(768) 가운데 정렬 + px-5.
const COL_X = CONTENT_X + (W - CONTENT_X - 768) / 2 // 400.5
const MSG_L = COL_X + 20 // 420.5
const MSG_R = COL_X + 768 - 20 // 1148.5
// 컴포저: 같은 열이지만 px-4 안쪽에서 max-w-3xl 이라 px-5 만큼의 안쪽 여백이 없다.
const CMP_L = CONTENT_X + 16 + (W - CONTENT_X - 32 - 768) / 2 // 400.5
const CMP_R = CMP_L + 768

// 스택(2개 이상)이 만들어지는 시점 — 헤더의 Stack 버튼은 이때부터 나타난다.
const T_STACK = 8.15

/* ─────────────────────────── 장면 ─────────────────────────── */

// 배경(루프 페이드 밖).
push(rect(0, 0, W, H, { fill: C.bg }))

const stage = []
const S = (s) => stage.push(s)

/** 제자리에서 도는 스피너. */
const spinAt = (x, y, size, color) =>
  `<g transform="translate(${num(x)},${num(y)})">` +
  animated(
    icon('loader', 0, 0, size, color),
    {
      transform: [
        [0, 'rotate(0deg)'],
        [DUR, `rotate(${DUR * 360}deg)`]
      ]
    },
    { origin: `${size / 2}px ${size / 2}px` }
  ) +
  `</g>`

/* ---------- 타이틀바 (h-11, pl-20 pr-3, bg) ---------- */
S(rect(0, 0, W, TITLE_H, { fill: C.bg }))
S(rect(0, TITLE_H - 1, W, 1, { fill: C.border }))
// 로고(W 모노그램) — Logo size={18}
S(
  `<g transform="translate(80,13) scale(0.5625)" fill="none">` +
    `<path d="M4.8 8.3 L10.8 25.3 L16 13.3 L21.2 25.3 L27.2 8.3" stroke="url(#wg)" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<circle cx="4.8" cy="8.3" r="3.3" fill="url(#wg)"/><circle cx="16" cy="13.3" r="3.3" fill="url(#wg)"/><circle cx="27.2" cy="8.3" r="3.3" fill="url(#wg)"/></g>`
)
S(
  rich(106, bl(22, 13), [
    { t: 'Wooi', weight: 600, fill: C.n200, w: TW.wooi },
    { t: ' · AI coding agent orchestrator', fill: C.n600 }
  ])
)
// 설정 버튼 h-7 w-7, 우측 pr-3
S(icon('settings', 1246, 14, 16, C.n400))

/* 타이틀바 우측 attention 클러스터 — 우측(gear − gap-2 − mr-1)에서 왼쪽으로 쌓는다. */
{
  const right = 1240 - 8 - 4 // 1228
  const y = (TITLE_H - 28) / 2 // h-7
  const cy = TITLE_H / 2

  // Unread (1) — bg info-600/90, 흰 글자
  const uw = 10 + 13 + 6 + TW.unread + 10
  const ux = right - uw
  const unread =
    rect(ux, y, uw, 28, { r: 6, fill: C.info600 }) +
    icon('belldot', ux + 10, cy - 6.5, 13, '#fff') +
    text(ux + 29, bl(cy, 11), 'Unread (1)', { px: 11, fill: '#fff', weight: 500 })

  // Needs input (1) — bg warning-500/90, 검은 글자
  const nw = 10 + 13 + 6 + TW.needs + 10
  const nx = ux - 6 - nw
  const needs =
    rect(nx, y, nw, 28, { r: 6, fill: C.warning500 }) +
    icon('shield', nx + 10, cy - 6.5, 13, '#000') +
    text(nx + 29, bl(cy, 11), 'Needs input (1)', { px: 11, fill: '#000', weight: 500 })

  // Stop all
  const sw2 = 8 + 11 + 4 + TW.stopAll + 8
  const sx = nx - 6 - sw2
  const stopAll =
    rect(sx, y, sw2, 28, { r: 6, fill: '#fb2c361a', stroke: '#fb2c3633' }) +
    rect(sx + 9.38, cy - 4.13, 8.25, 8.25, { r: 0.92, fill: C.danger300 }) +
    text(sx + 23, bl(cy, 11), 'Stop all', { px: 11, fill: C.danger300 })

  // 실행 중 개수
  const rw = 8 + 12 + 4 + TW.count + 8
  const rx = sx - 6 - rw
  const running =
    rect(rx, y, rw, 28, { r: 6, fill: '#2b7fff1a', stroke: '#2b7fff33' }) +
    spinAt(rx + 8, cy - 6, 12, C.info300) +
    animated(text(rx + 24, bl(cy, 11), '3', { px: 11, fill: C.info300 }), {
      opacity: only(0, 3.1)
    }) +
    animated(text(rx + 24, bl(cy, 11), '2', { px: 11, fill: C.info300 }), {
      opacity: [
        [0, 0],
        [3.099, 0],
        [3.1, 1],
        [4.999, 1],
        [5.0, 0],
        [8.149, 0],
        [8.15, 1],
        [9.899, 1],
        [9.9, 0],
        [DUR, 0]
      ]
    }) +
    animated(text(rx + 24, bl(cy, 11), '1', { px: 11, fill: C.info300 }), {
      opacity: [
        [0, 0],
        [4.999, 0],
        [5.0, 1],
        [8.149, 1],
        [8.15, 0],
        [9.899, 0],
        [9.9, 1],
        [DUR, 1]
      ]
    })

  // Needs/Unread 가 붙기 전에는 실행 중/Stop all 이 오른쪽 끝에 붙어 있다.
  const shift = nw + 6 + uw + 6
  S(
    animated(running + stopAll, {
      transform: [
        [0, `translate(${num(shift)}px,0)`],
        [3.199, `translate(${num(shift)}px,0)`],
        [3.2, 'translate(0px,0px)'],
        [DUR, 'translate(0px,0px)']
      ]
    })
  )
  S(animated(needs + unread, { opacity: fade(3.2, 3.5) }))
}

/* ---------- 사이드바 (w-72, bg-2) ---------- */
S(rect(0, TITLE_H, SIDE_W, APP_H - TITLE_H, { fill: C.bg2 }))
S(rect(SIDE_W, TITLE_H, 1, APP_H - TITLE_H, { fill: C.border })) // 콘텐츠 영역의 border-l

// Overview / Search workspaces (px-2 pt-2, py-1.5 rounded-md, text-sm)
{
  const b1 = 52
  const b2 = 83.4
  const bh = 29.4
  S(icon('dashboard', 16, b1 + (bh - 15) / 2, 15, C.n400))
  S(text(39, bl(b1 + bh / 2, 12), 'Overview', { px: 12, fill: C.n400, weight: 500 }))
  S(icon('search', 16, b2 + (bh - 15) / 2, 15, C.n400))
  S(text(39, bl(b2 + bh / 2, 12), 'Search workspaces', { px: 12, fill: C.n400, weight: 500 }))
  S(text(272, bl(b2 + bh / 2, 11), '⌘K', { px: 11, fill: C.n600, weight: 500, anchor: 'end' }))
}

// Repositories 헤더 (px-3 h-10, uppercase tracking-wider)
S(text(12, bl(132.8, 11), 'REPOSITORIES', { px: 11, fill: C.n500, weight: 600, ls: '0.55' }))
S(icon('plus', 256.5, 125.3, 15, C.n400))

// 리포 행 (px-2 py-1.5 안, 스크롤러 px-2)
{
  const cy = 167.5
  S(icon('foldergit', 16, cy - 7, 14, C.n500))
  S(text(36, bl(cy, 12), 'acme-web', { px: 12, fill: C.n300, weight: 500 }))
  // 이 리포에서 실행 중인 세션 수
  S(spinAt(199, cy - 5, 10, '#51a2ffcc'))
  S(animated(text(213, bl(cy, 11), '3', { px: 11, fill: '#51a2ffcc' }), { opacity: only(0, 3.1) }))
  S(
    animated(text(213, bl(cy, 11), '2', { px: 11, fill: '#51a2ffcc' }), {
      opacity: [
        [0, 0],
        [3.099, 0],
        [3.1, 1],
        [4.999, 1],
        [5.0, 0],
        [8.149, 0],
        [8.15, 1],
        [9.899, 1],
        [9.9, 0],
        [DUR, 0]
      ]
    })
  )
  S(
    animated(text(213, bl(cy, 11), '1', { px: 11, fill: '#51a2ffcc' }), {
      opacity: [
        [0, 0],
        [4.999, 0],
        [5.0, 1],
        [8.149, 1],
        [8.15, 0],
        [9.899, 0],
        [9.9, 1],
        [DUR, 1]
      ]
    })
  )
  S(icon('settings2', 229, cy - 7, 14, C.n400))
  S(icon('plus', 255, cy - 7, 14, C.n400))
}

/* 워크스페이스 행 — orderByStack 순서(부모 바로 아래에 자식) */
const ROW_TOP = 184.2
const ROW_H = 45.35 // py-1.5 + text-sm + text-xs
const PITCH = ROW_H + 2 // space-y-0.5

const ROWS = [
  {
    id: 'r1',
    depth: 0,
    slot: 0,
    shifts: [],
    keys: [['⌘1', null, null]],
    name: 'Extract auth service',
    meta: [
      { t: 'wooi/auth-service', w: 94.02, fill: C.n500 },
      { t: ' ', w: 4 },
      { t: '·12', w: 15.2, fill: '#fe9a00cc' },
      { t: ' ', w: 4 },
      { t: '↑12', w: 20.53, fill: C.n500 }
    ],
    time: { t: '· 2m 04s', w: 45.95, fill: '#51a2ffcc' },
    timeUntil: 5.0,
    appear: 0.55,
    selected: [0, T_STACK]
  },
  {
    id: 'r4',
    depth: 1,
    slot: 1,
    shifts: [],
    keys: [['⌘2', null, null]],
    name: 'JWT rotation',
    meta: [
      { t: 'wooi/jwt-rotation', w: 88.91, fill: C.n500 },
      { t: ' ', w: 4 },
      { t: '↑7', w: 15, fill: C.n500 }
    ],
    time: { t: '· 0m 21s', w: 45.95, fill: '#51a2ffcc' },
    timeFrom: T_STACK,
    timeUntil: 9.9,
    appear: T_STACK,
    selected: [T_STACK, null]
  },
  {
    id: 'r5',
    depth: 2,
    slot: 2,
    shifts: [],
    keys: [['⌘3', null, null]],
    name: 'Revoke endpoint',
    meta: [
      { t: 'wooi/jwt-revoke', w: 82.98, fill: C.n500 },
      { t: ' ', w: 4 },
      { t: '↑3', w: 15.63, fill: C.n500 }
    ],
    appear: 8.85
  },
  {
    id: 'r2',
    depth: 0,
    slot: 1,
    shifts: [
      [T_STACK, 1],
      [8.85, 2]
    ],
    keys: [
      ['⌘2', null, T_STACK],
      ['⌘3', T_STACK, 8.85],
      ['⌘4', 8.85, null]
    ],
    name: 'Dark mode toggle',
    meta: [
      { t: 'wooi/dark-mode', w: 85.08, fill: C.n500 },
      { t: ' ', w: 4 },
      { t: '·4', w: 10.48, fill: '#fe9a00cc' }
    ],
    time: { t: '· 1m 12s', w: 42.16, fill: '#51a2ffcc' },
    timeUntil: 2.7,
    appear: 0.85
  },
  {
    id: 'r3',
    depth: 0,
    slot: 2,
    shifts: [
      [T_STACK, 1],
      [8.85, 2]
    ],
    keys: [
      ['⌘3', null, T_STACK],
      ['⌘4', T_STACK, 8.85],
      ['⌘5', 8.85, null]
    ],
    name: 'Fix flaky signup test',
    meta: [
      { t: 'wooi/flaky-signup', w: 93.06, fill: C.n500 },
      { t: ' ', w: 4 },
      { t: '·3', w: 10.3, fill: '#fe9a00cc' },
      { t: ' ', w: 4 },
      { t: '↑2', w: 15.38, fill: C.n500 }
    ],
    time: { t: '· 0m 52s', w: 45.95, fill: '#51a2ffcc' },
    timeUntil: 3.1,
    appear: 1.15
  }
]

/** 행별 상태 아이콘(스피너 → 점) 타임라인. */
const ROW_STATUS = {
  // 실행 중 → PR review_required → merged
  r1: [
    { kind: 'spin', from: 0, to: 5.0 },
    { kind: 'dot', color: C.warning400, from: 5.0, to: 13.6 },
    { kind: 'dot', color: C.purple400, from: 13.6, to: null }
  ],
  // 실행 중 → 권한 대기
  r2: [
    { kind: 'spin', from: 0, to: 2.7 },
    { kind: 'shield', from: 2.7, to: null }
  ],
  // 실행 중 → PR approved
  r3: [
    { kind: 'spin', from: 0, to: 3.1 },
    { kind: 'dot', color: C.success400, from: 3.1, to: null }
  ],
  r4: [
    { kind: 'spin', from: T_STACK, to: 9.9 },
    { kind: 'dot', color: C.success400, from: 9.9, to: null }
  ],
  // PR draft
  r5: [{ kind: 'dot', color: C.n400, from: 0, to: null }]
}

for (const r of ROWS) {
  const y0 = ROW_TOP + r.slot * PITCH
  const px = 8 + 12 + r.depth * 14 // 스크롤러 px-2 + paddingLeft
  const tx = px + 21 // 상태 아이콘(13) + gap-2
  const cy = y0 + ROW_H / 2
  const inner = []

  // 선택 배경 + 좌측 액센트 바
  if (r.selected) {
    const [from, to] = r.selected
    inner.push(
      animated(
        rect(8, y0, SIDE_W - 16, ROW_H, { r: 6, fill: C.surface3 }) +
          rect(8, y0 + 6, 2, ROW_H - 12, { r: 1, fill: C.info500 }),
        { opacity: only(from, to) }
      )
    )
  }

  // 이름 — 선택된 동안 더 밝다.
  const nameY = bl(y0 + 6 + 17.4 / 2, 12)
  if (r.selected) {
    const [from, to] = r.selected
    const dim = text(tx, nameY, r.name, { px: 12, fill: C.n300 })
    inner.push(
      animated(text(tx, nameY, r.name, { px: 12, fill: C.n100 }), { opacity: only(from, to) })
    )
    if (from > r.appear + 0.01) inner.push(animated(dim, { opacity: only(0, from) }))
    if (to != null) inner.push(animated(dim, { opacity: only(to, null) }))
  } else {
    inner.push(text(tx, nameY, r.name, { px: 12, fill: C.n300 }))
  }

  // 메타 줄 — GitBranch(10) + gap-1 + 브랜치·변경수·ahead(·경과시간)
  const metaCy = y0 + 23.4 + 15.95 / 2
  inner.push(icon('branch', tx, metaCy - 5, 10, C.n500))
  const metaSegs = r.meta
  const line = (withTime) =>
    rich(tx + 14, bl(metaCy, 11), withTime ? [...metaSegs, { t: ' ', w: 4 }, r.time] : metaSegs, {
      px: 11,
      fill: C.n500
    })
  if (r.time) {
    inner.push(
      animated(line(true), { opacity: only(r.timeFrom ?? 0, r.timeUntil) }),
      animated(line(false), { opacity: only(r.timeUntil, null) })
    )
  } else {
    inner.push(line(false))
  }

  // 상태 아이콘
  for (const st of ROW_STATUS[r.id]) {
    const vis = { opacity: only(st.from, st.to) }
    if (st.kind === 'spin') inner.push(animated(spinAt(px, cy - 6.5, 13, C.info400), vis))
    else if (st.kind === 'shield')
      inner.push(animated(icon('shield', px, cy - 6.5, 13, C.warning400), vis))
    else inner.push(animated(dot(px + 4, cy, st.color), vis))
  }

  // 우측: ⌘n → 미확인 점 순서(gap-1.5, pr-1.5)
  const hasUnread = r.id === 'r3'
  const kbdRight = hasUnread ? 274 - 8 - 6 : 274
  for (const [label, from, to] of r.keys) {
    const t = text(kbdRight, bl(cy, 11), label, {
      px: 11,
      fill: C.n600,
      weight: 500,
      anchor: 'end'
    })
    inner.push(from == null && to == null ? t : animated(t, { opacity: only(from ?? 0, to) }))
  }
  if (hasUnread) inner.push(animated(dot(270, cy, C.info500), { opacity: fade(3.4, 3.7) }))

  // 마우스를 올린 행에는 ⋯ 버튼이 뜬다(아래 RowActionsMenu 를 여는 자리).
  if (r.id === 'r1') {
    inner.push(
      animated(
        rect(248, cy - 12, 26, 24, { fill: C.surface3 }) +
          rect(250, cy - 12, 24, 24, { r: 6, fill: C.surface2 }) +
          icon('dots', 255, cy - 7, 14, C.n300),
        { opacity: fade(6.4, 6.62, 8.05, 8.25) }
      )
    )
  }

  // 행이 늦게 생기면 위 행들이 아래로 밀린다(orderByStack).
  let g = animated(inner.join(''), { opacity: fade(r.appear, r.appear + 0.45) })
  if (r.shifts.length) {
    const stops = [[0, 'translate(0px,0px)']]
    for (const [t, n] of r.shifts) {
      stops.push([t - 0.001, stops[stops.length - 1][1]], [t, `translate(0px,${num(n * PITCH)}px)`])
    }
    stops.push([DUR, stops[stops.length - 1][1]])
    g = animated(g, { transform: stops })
  }
  S(g)
}

/* ---------- 워크스페이스 헤더 (h-12, px-4) ---------- */
S(rect(CONTENT_X, HEADER_BOT - 1, W - CONTENT_X, 1, { fill: C.border }))
{
  const hx = CONTENT_X + 16 // 305
  const titleY = bl(TITLE_H + 6.3 + 19.5 / 2, 13)
  const metaCy = TITLE_H + 6.3 + 19.5 + 15.95 / 2
  const scene = (title, tw, branch, bw, changed, cw, stops) =>
    S(
      animated(
        text(hx, titleY, title, { px: 13, weight: 600, fill: C.n100 }) +
          icon('branch', hx, metaCy - 5.5, 11, C.n500) +
          text(hx + 17, bl(metaCy, 11), branch, { px: 11, fill: C.n500 }) +
          text(hx + 17 + bw + 6, bl(metaCy, 11), changed, { px: 11, fill: C.n500 }) +
          icon('refresh', hx + 17 + bw + 6 + cw + 6, metaCy - 5, 10, C.n600),
        { opacity: stops }
      )
    )
  scene(
    'Extract auth service',
    TW.h1,
    'wooi/auth-service',
    TW.hb1,
    '· 12 changed · ↑12',
    TW.hc1,
    only(0, T_STACK)
  )
  scene(
    'JWT rotation',
    TW.h2,
    'wooi/jwt-rotation',
    TW.hb2,
    '· 6 changed · ↑7',
    TW.hc2,
    only(T_STACK, null)
  )

  /* 우측 버튼들 — 오른쪽에서 왼쪽으로 배치한다. */
  // PR 액션 메뉴(h-6 w-6) → PR 배지 → 구분선 → Stack 버튼 → 구분선 → 아이콘 버튼 6개
  const prMenuX = 1264 - 24
  const badgeRight = prMenuX - 6

  const prBadge = (numTxt, numW, label, labelW, ic, icColor, fg, bg, bd, stops) => {
    const bw2 = 8 + 12 + 6 + numW + 6 + labelW + 6 + 10 + 8
    const bx = badgeRight - bw2
    S(
      animated(
        rect(bx - 8, 56, 1, 24, { fill: C.border }) +
          rect(bx, 56, bw2, 24, { r: 6, fill: bg, stroke: bd }) +
          icon(ic, bx + 8, 62, 12, icColor) +
          text(bx + 26, bl(68, 11), numTxt, { px: 11, fill: fg + '99' }) +
          text(bx + 26 + numW + 6, bl(68, 11), label, { px: 11, fill: fg, weight: 500 }) +
          icon('extlink', bx + bw2 - 18, 63, 10, fg) +
          rect(prMenuX, 56, 24, 24, { r: 6, fill: C.surface, stroke: C.border }) +
          icon('chevrondown', prMenuX + 6, 62, 12, C.n300),
        { opacity: stops }
      )
    )
  }
  prBadge(
    '#41',
    TW.pr41,
    'Review required',
    TW.prLabel1,
    'clock',
    C.warning400,
    C.warning200,
    '#fe9a001a',
    '#fe9a004d',
    only(0, T_STACK)
  )
  prBadge(
    '#42',
    TW.pr42,
    'Ready to merge',
    TW.prLabel2,
    'circlecheck',
    C.success400,
    C.success200,
    '#00bc7d1a',
    '#00bc7d4d',
    only(T_STACK, null)
  )

  // Stack 버튼 — 스택이 2개 이상일 때만 나타난다.
  const prLeft = badgeRight - (8 + 12 + 6 + TW.pr41 + 6 + TW.prLabel1 + 6 + 10 + 8) - 8
  const stackRight = prLeft - 2 - 12
  const stackW = 8 + 12 + 6 + TW.stack + 6 + TW.stackCount + 8
  const stackX = stackRight - stackW
  S(
    animated(
      rect(stackX - 8, 56, 1, 24, { fill: C.border }) +
        rect(stackX, 56, stackW, 24, { r: 6, fill: C.surface, stroke: C.border }) +
        icon('layers', stackX + 8, 62, 12, C.accent400) +
        text(stackX + 26, bl(68, 11), 'Stack', { px: 11, fill: C.n300, weight: 500 }) +
        text(stackX + 26 + TW.stack + 6, bl(68, 11), '3 · 3 PR', { px: 11, fill: '#d4d4d499' }),
      { opacity: fade(T_STACK + 0.7, T_STACK + 1.0) }
    )
  )

  // 아이콘 버튼 6개(h-7 w-7, gap-3)
  const btnRight = stackX - 8 - 2 - 12
  ;['terminal', 'code', 'folderopen', 'download', 'archive', 'panel'].forEach((n, i, a) => {
    const bx = btnRight - 28 - (a.length - 1 - i) * 40
    S(icon(n, bx + 6.5, 60.5, 15, C.n400))
  })
}

/* ---------- 대화 (하단 정렬, max-w-3xl + px-5) ---------- */
{
  // 장면 1 — 사용자 메시지 → 도구 호출 → 도구 결과 → 응답
  const u1w = 374.36 + 28
  S(
    animated(
      bubble(MSG_R - u1w, 463.65, u1w, 35.5, C.surface4) +
        text(
          MSG_R - u1w + 14,
          bl(463.65 + 8 + 19.5 / 2, 13),
          'Extract everything under src/auth into its own service module.',
          { px: 13, fill: C.n100 }
        ),
      { opacity: fade(1.9, 2.3, 7.7, 8.05) }
    )
  )
  S(
    animated(
      icon('wrench', MSG_L, 519.85 - 6, 12, '#fe9a00cc') +
        text(MSG_L + 18, bl(519.85, 12), 'Bash', { px: 12, fill: C.n300, weight: 500 }) +
        text(MSG_L + 18 + TW.toolName + 6, bl(519.85, 12), 'npm test', { px: 12, fill: C.n500 }) +
        icon('chevronright', MSG_R - 12, 513.85, 12, C.n400),
      { opacity: fade(2.8, 3.1, 7.7, 8.05) }
    )
  )
  S(
    animated(
      rect(MSG_L + 16, 540.55, 768 - 40 - 16, 31.95, { r: 6, fill: C.bg3, stroke: C.border }) +
        text(MSG_L + 24, bl(540.55 + 8 + 7.98, 11), '214 passing (3.4s)', {
          px: 11,
          fill: C.n500,
          mono: true
        }),
      { opacity: fade(3.4, 3.7, 7.7, 8.05) }
    )
  )
  // 어시스턴트 응답 — 마크다운이라 `코드`는 인라인 코드 칩으로 그려진다.
  {
    const y = bl(584.5 + 19.5 / 2, 13)
    const cw = 4.55 + 79.22 + 4.55
    S(
      animated(
        rect(MSG_L + 153.3, 587.5, cw, 15, { r: 4, fill: C.codeInlineBg }) +
          rich(
            MSG_L,
            y,
            [
              { t: 'Moved 12 files behind an ', w: 153.3, fill: C.n200 },
              { t: ' ', w: 4.55 },
              { t: 'AuthService', w: 79.22, px: 11.96, mono: true, fill: C.codeFg },
              { t: ' ', w: 4.55 },
              {
                t: ' boundary and updated 31 call sites. Tests pass.',
                w: 290.06,
                fill: C.n200
              }
            ],
            { px: 13 }
          ),
        { opacity: fade(4.2, 4.6, 7.7, 8.05) }
      )
    )
  }

  // 장면 2
  const u2w = 224.52 + 28
  S(
    animated(
      bubble(MSG_R - u2w, 537, u2w, 35.5, C.surface4) +
        text(MSG_R - u2w + 14, bl(537 + 8 + 19.5 / 2, 13), 'Now add JWT rotation on top of that.', {
          px: 13,
          fill: C.n100
        }),
      { opacity: fade(8.5, 8.9) }
    )
  )
  {
    const y = bl(584.5 + 19.5 / 2, 13)
    const P = 4.55 // 인라인 코드 칩의 좌우 패딩(.35em @ 13px)
    const c1 = P + 122.42 + P
    const c2 = P + 28.81 + P
    S(
      animated(
        rect(MSG_L + 71.36, 587.5, c1, 15, { r: 4, fill: C.codeInlineBg }) +
          rect(MSG_L + 71.36 + c1 + 211.16, 587.5, c2, 15, { r: 4, fill: C.codeInlineBg }) +
          rich(
            MSG_L,
            y,
            [
              { t: 'Stacked on ', w: 71.36, fill: C.n200 },
              { t: ' ', w: P },
              { t: 'wooi/auth-service', w: 122.42, px: 11.96, mono: true, fill: C.codeFg },
              { t: ' ', w: P },
              { t: ' — this PR targets that branch, not ', w: 211.16, fill: C.n200 },
              { t: ' ', w: P },
              { t: 'main', w: 28.81, px: 11.96, mono: true, fill: C.codeFg },
              { t: ' ', w: P },
              { t: '.', w: 3.8, fill: C.n200 }
            ],
            { px: 13 }
          ),
        { opacity: fade(9.3, 9.7) }
      )
    )
  }
}

/* ---------- 컴포저 (px-4 py-3, max-w-3xl) ---------- */
S(rect(CONTENT_X, 623.6, W - CONTENT_X, 1, { fill: C.border }))
{
  const sx = CMP_L + 1 // px-1
  const scy = 636.1 + 15.95 / 2
  const sy = bl(scy, 11)
  const iy = scy - 5.5

  S(icon('branch', sx, iy, 11, C.n600))
  S(
    animated(text(sx + 15, sy, 'wooi/auth-service', { px: 11, fill: C.n500 }), {
      opacity: only(0, T_STACK)
    })
  )
  S(
    animated(text(sx + 15, sy, 'wooi/jwt-rotation', { px: 11, fill: C.n500 }), {
      opacity: only(T_STACK, null)
    })
  )
  const x2 = sx + 15 + TW.slBranch1 + 12
  S(icon('folder', x2, iy, 11, C.n600))
  S(
    animated(text(x2 + 15, sy, 'auth-service', { px: 11, fill: C.n500 }), {
      opacity: only(0, T_STACK)
    })
  )
  S(
    animated(text(x2 + 15, sy, 'jwt-rotation', { px: 11, fill: C.n500 }), {
      opacity: only(T_STACK, null)
    })
  )
  const x3 = x2 + 15 + TW.slDir1 + 12
  S(icon('cpu', x3, iy, 11, C.n600))
  // backend.ts 의 MODEL_OPTIONS 라벨과 문자 그대로 같아야 한다.
  S(text(x3 + 15, sy, 'Opus 5 (1M context)', { px: 11, fill: C.n500 }))
  const x4 = x3 + 15 + TW.slModel + 12
  S(icon('zap', x4, iy, 11, C.n600))
  S(text(x4 + 15, sy, 'High', { px: 11, fill: C.n500 }))
  const x5 = x4 + 15 + TW.slEffort + 12
  S(icon('rabbit', x5, iy, 11, C.n600))
  S(text(x5 + 15, sy, 'Standard', { px: 11, fill: C.n500 }))

  // 컨텍스트 사용량 (ml-auto)
  const cRight = CMP_R - 1
  S(text(cRight, sy, '24%', { px: 11, fill: C.n500, anchor: 'end' }))
  const barX = cRight - TW.slPct - 6 - 64
  S(rect(barX, scy - 2, 64, 4, { r: 2, fill: C.surface3 }))
  S(rect(barX, scy - 2, 15.36, 4, { r: 2, fill: C.n500 }))
  S(icon('gauge', barX - 6 - 11, iy, 11, C.n500))

  // 입력창 (rounded-xl px-3 py-2)
  S(rect(CMP_L, 658.05, 768, 48, { r: 12, fill: C.surface, stroke: C.border }))
  // Composer.tsx 의 placeholder 와 문자 그대로 같아야 한다.
  const ph = (s, stops) =>
    S(animated(text(CMP_L + 12, 687.4, s, { px: 13, fill: C.n600 }), { opacity: stops }))
  // 선택된 워크스페이스가 도는 동안에는 문구가 "대기열에 넣기"로 바뀐다.
  const idleWindows = [
    [0, 0],
    [4.999, 0],
    [5.0, 1],
    [8.149, 1],
    [8.15, 0],
    [9.899, 0],
    [9.9, 1],
    [DUR, 1]
  ]
  const runWindows = [
    [0, 1],
    [4.999, 1],
    [5.0, 0],
    [8.149, 0],
    [8.15, 1],
    [9.899, 1],
    [9.9, 0],
    [DUR, 0]
  ]
  ph(
    'Message your agent…  (Enter to send · @ for files · / for commands · ! for terminal)',
    idleWindows
  )
  ph('Queue a follow-up…  (Enter to send · it runs after the current turn)', runWindows)

  // 실행 중에는 정지 버튼이 붙고 전송 버튼이 그만큼 왼쪽으로 밀린다.
  const sendX = CMP_R - 12 - 32
  const sendAt = (x) =>
    rect(x, 666.05, 32, 32, { r: 8, fill: C.info600 }) + icon('send', x + 8.5, 674.55, 15, '#fff')
  const stopX = sendX - 8 - 32
  S(animated(sendAt(sendX), { opacity: idleWindows }))
  S(
    animated(
      rect(stopX, 666.05, 32, 32, { r: 8, fill: '#fb2c3626' }) +
        rect(stopX + 10.38, 676.43, 11.25, 11.25, { r: 1.25, fill: C.danger400 }) +
        sendAt(sendX),
      { opacity: runWindows }
    )
  )

  // 권한 모드 푸터 (mt-1.5 px-1)
  S(
    rich(
      sx,
      723.9,
      [
        { t: '⏵⏵ accept edits on', w: TW.foot1, fill: C.warning400 },
        { t: ' ', w: 3.1 },
        { t: '(shift+tab to cycle)', fill: C.n600 }
      ],
      { px: 11 }
    )
  )
}

/* ---------- 행 액션 메뉴 (w-52, RowActionsMenu) ---------- */
{
  const mw = 208
  const mx = 274 - mw
  const my = ROW_TOP + ROW_H + 4
  const items = [
    ['pencil', 'Rename…', false, false],
    ['branchplus', 'Stack a new workspace', true, false],
    [null, null, null, null],
    ['bell', 'Mute notifications', false, false],
    [null, null, null, null],
    ['archive', 'Archive workspace', false, true]
  ]
  const IH = 27.95
  const mh = 4 + 4 * IH + 2 * 9 + 4
  const inner = [rect(mx, my, mw, mh, { r: 8, fill: C.surface, stroke: C.borderStrong })]
  let iy = my + 4
  for (const [ic, label, hi, danger] of items) {
    if (!ic) {
      inner.push(rect(mx, iy + 4, mw, 1, { fill: C.border }))
      iy += 9
      continue
    }
    if (hi) inner.push(rect(mx + 1, iy, mw - 2, IH, { fill: C.surface2 }))
    inner.push(icon(ic, mx + 12.5, iy + IH / 2 - 6.5, 13, C.n400))
    inner.push(
      text(mx + 34, bl(iy + IH / 2, 11), label, {
        px: 11,
        fill: danger ? C.danger400 : C.n200
      })
    )
    iy += IH
  }
  S(
    animated(inner.join(''), {
      opacity: fade(7.0, 7.22, 7.98, 8.2),
      transform: [
        [0, 'translate(0px,-6px)'],
        [7.0, 'translate(0px,-6px)'],
        [7.25, 'translate(0px,0px)'],
        [DUR, 'translate(0px,0px)']
      ]
    })
  )
}

/* ---------- 스택 팝오버 (w-80, StackPopover) ---------- */
{
  const PW = 320
  const prLeft = 1264 - 24 - 6 - (8 + 12 + 6 + TW.pr41 + 6 + TW.prLabel1 + 6 + 10 + 8) - 8
  const stackRight = prLeft - 2 - 12
  const px0 = stackRight - PW
  const py0 = 84 // 버튼 아래 mt-1
  const RH = 45.95
  const rows = [
    {
      name: 'Extract auth service',
      nw: 104.67,
      branch: 'wooi/auth-service',
      bw: 94.02,
      depth: 0,
      cur: false,
      before: { dot: C.warning400, pr: '· #41 Review required', pw: 112.66, ah: '↑12', aw: 20.53 },
      after: { dot: C.purple400, pr: '· #41 Merged', pw: 68.75, ah: '', aw: 0 }
    },
    {
      name: 'JWT rotation',
      nw: 67.64,
      branch: 'wooi/jwt-rotation',
      bw: 88.91,
      depth: 1,
      cur: true,
      before: { dot: C.success400, pr: '· #42 Ready to merge', pw: 112.81, ah: '↑7', aw: 15 },
      after: { dot: C.success400, pr: '· #42 Ready to merge', pw: 112.81, ah: '↑7', aw: 15 }
    },
    {
      name: 'Revoke endpoint',
      nw: 87.31,
      branch: 'wooi/jwt-revoke',
      bw: 82.98,
      depth: 2,
      cur: false,
      before: { dot: C.n400, pr: '· #43 Draft', pw: 57.14, ah: '↑3', aw: 15.63 },
      after: { dot: C.n400, pr: '· #43 Draft', pw: 57.14, ah: '↑3', aw: 15.63 }
    }
  ]
  const popH = 4 + 27.95 + rows.length * RH + 4
  const inner = [rect(px0, py0, PW, popH, { r: 8, fill: C.surface, stroke: C.borderStrong })]
  inner.push(
    text(px0 + 12, bl(py0 + 4 + 27.95 / 2, 11), 'STACK · 3 WORKSPACES', {
      px: 11,
      fill: C.n500,
      ls: '0.6'
    })
  )

  rows.forEach((r, i) => {
    const ry = py0 + 4 + 27.95 + i * RH
    const rx = px0 + 12 + r.depth * 14
    if (r.cur) inner.push(rect(px0 + 1, ry, PW - 2, RH, { fill: C.surface2 }))
    const l1cy = ry + 6 + 15.95 / 2
    inner.push(
      animated(dot(rx + 4, l1cy, r.before.dot), { opacity: only(0, 13.6) }),
      animated(dot(rx + 4, l1cy, r.after.dot), { opacity: only(13.6, null) })
    )
    inner.push(text(rx + 14, bl(l1cy, 11), r.name, { px: 11, fill: r.cur ? C.n100 : C.n300 }))
    if (r.cur) inner.push(icon('check', rx + 14 + r.nw + 6, l1cy - 5.5, 11, C.accent400))

    const l2cy = ry + 6 + 15.95 + 2 + 8
    inner.push(icon('branch', rx, l2cy - 4.5, 9, C.n500))
    const line2 = (v) =>
      rich(
        rx + 13,
        bl(l2cy, 11),
        [
          { t: r.branch, w: r.bw, fill: C.n500 },
          { t: ' ', w: 4 },
          { t: v.pr, w: v.pw, fill: '#737373cc' },
          ...(v.ah
            ? [
                { t: ' ', w: 4 },
                { t: v.ah, w: v.aw, fill: C.n500 }
              ]
            : [])
        ],
        { px: 11 }
      )
    inner.push(
      animated(line2(r.before), { opacity: only(0, 13.6) }),
      animated(line2(r.after), { opacity: only(13.6, null) })
    )
    inner.push(icon('extlink', px0 + PW - 8 - 24 + 5.5, ry + RH / 2 - 6.5, 13, C.n500))
  })

  S(
    animated(inner.join(''), {
      opacity: fade(10.55, 10.83, 15.5, 15.75),
      transform: [
        [0, 'translate(0px,-8px)'],
        [10.55, 'translate(0px,-8px)'],
        [10.9, 'translate(0px,0px)'],
        [DUR, 'translate(0px,0px)']
      ]
    })
  )
}

/* ---------- 커서 ---------- */
{
  const cursor = `<path d="M5.5 2.2 L18.8 11.4 L12.6 12.4 L15.4 18.8 L12.9 19.9 L10.1 13.5 L5.5 17.4 Z" fill="#fff" stroke="#111" stroke-width="1.1" stroke-linejoin="round"/>`
  const g = `<g transform="scale(0.92)">${cursor}</g>`
  S(
    animated(g, {
      opacity: [
        [0, 0],
        [6.2, 0],
        [6.45, 1],
        [8.15, 1],
        [8.4, 0],
        [9.9, 0],
        [10.15, 1],
        [11.05, 1],
        [11.3, 0],
        [DUR, 0]
      ],
      transform: [
        [0, 'translate(560px,470px)'],
        [6.2, 'translate(560px,470px)'],
        [6.95, 'translate(262px,205px)'],
        [9.9, 'translate(262px,205px)'],
        [10.5, 'translate(990px,62px)'],
        [DUR, 'translate(990px,62px)']
      ]
    })
  )
}

/* ---------- 캡션 ---------- */
{
  const CAPS = [
    [0.5, 4.3, 'Three tasks, three agents — each in its own ', 'isolated worktree', '.'],
    [4.5, 7.3, 'One sidebar tells you ', 'who needs you', ', and who is still working.'],
    [7.5, 10.3, 'Work that builds on work? ', 'Stack it.', ''],
    [10.5, 13.4, 'The whole chain — ', 'every PR state in one place', '.'],
    [13.6, 15.9, 'Parent merges → ', 'Wooi retargets and rebases the rest.', '']
  ]
  for (const [t0, t1, pre, mid, post] of CAPS) {
    // 중앙 정렬: 세 조각을 하나의 <text text-anchor=middle> 로 묶는다.
    const t =
      `<text x="${W / 2}" y="${APP_H + 38}" font-size="19" font-weight="560" text-anchor="middle" fill="#eef1f6" letter-spacing="-0.22">` +
      `${esc(pre)}<tspan fill="url(#cg)" font-weight="640">${esc(mid)}</tspan>${esc(post)}</text>`
    S(animated(t, { opacity: fade(t0, t0 + 0.28, t1 - 0.28, t1) }))
  }
}

/* ─────────────────────────── 조립 ─────────────────────────── */
// 루프가 매끄럽도록 전체를 처음/끝에서 페이드.
const stageAnim = animated(stage.join(''), {
  opacity: [
    [0, 0],
    [0.3, 1],
    [15.65, 1],
    [DUR, 0]
  ]
})

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Wooi — run AI coding agents in parallel and stack them">
<title>Wooi — run AI coding agents in parallel, and stack them when work builds on work</title>
<defs>
<linearGradient id="wg" gradientUnits="userSpaceOnUse" x1="7.5" y1="7.5" x2="25" y2="25"><stop offset="0" stop-color="#74acff"/><stop offset="1" stop-color="#b08bfa"/></linearGradient>
<linearGradient id="cg" gradientUnits="userSpaceOnUse" x1="440" y1="0" x2="840" y2="0"><stop offset="0" stop-color="#74acff"/><stop offset="1" stop-color="#b08bfa"/></linearGradient>
</defs>
<style>
text{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,'Helvetica Neue',Arial,sans-serif;white-space:pre}
.m,tspan.m{font-family:'SF Mono',ui-monospace,'DejaVu Sans Mono',Menlo,Consolas,monospace}
${css.join('\n')}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
</style>
${body.join('\n')}
${stageAnim}
</svg>
`

writeFileSync(OUT, svg)
console.log(`docs/demo.svg — ${(svg.length / 1024).toFixed(1)} KB, ${seq} animations, ${DUR}s loop`)
