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

/* ── 색 — src/renderer/src/index.css 의 토큰. oklch 는 Tailwind v4 팔레트 hex 로 확정. ── */
const C = {
  bg: '#0b0c0e',
  bg2: '#0d0e11',
  surface: '#15171c',
  surface2: '#1c1f25',
  surface3: '#1b1f27',
  border: '#23262d',
  borderStrong: '#384050',
  n100: '#f5f5f5',
  n200: '#e5e5e5',
  n300: '#d4d4d4',
  n400: '#a3a3a3',
  n500: '#737373',
  n600: '#525252',
  info300: '#8ec5ff',
  info400: '#50a2ff',
  info500: '#2b7fff',
  info600: '#155dfc',
  warning400: '#ffb900',
  warning500: '#fe9a00',
  success400: '#00d492',
  accent300: '#c4b4ff',
  accent400: '#a684ff',
  danger300: '#ffa2a2',
  danger500: '#fb2c36',
  purple400: '#c084fc'
}

/* ── lucide 아이콘 패스(24x24) — 앱이 쓰는 것과 동일한 아이콘 ── */
const ICONS = {
  loader: 'M21 12a9 9 0 1 1-6.219-8.56',
  shield:
    'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z|M9.1 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3|M12 17h.01',
  bell: 'M19.4 14.9C20.2 16.4 21 17 21 17H3s3-2 3-9c0-3.3 2.7-6 6-6 .7 0 1.3.1 1.9.3|M10.3 21a1.94 1.94 0 0 0 3.4 0',
  bellplain:
    'M10.268 21a2 2 0 0 0 3.464 0|M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326',
  settings:
    'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z',
  plus: 'M5 12h14|M12 5v14',
  chevron: 'm6 9 6 6 6-6',
  branch: 'M6 3v12|M18 9a9 9 0 0 1-9 9',
  branchplus: 'M6 3v12|M18 9a9 9 0 0 1-9 9|M15 6h6|M18 3v6',
  layers:
    'M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z|m6.08 9.5-3.5 1.6a1 1 0 0 0 0 1.81l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9a1 1 0 0 0 0-1.83l-3.5-1.6|m6.08 14.5-3.5 1.6a1 1 0 0 0 0 1.81l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9a1 1 0 0 0 0-1.83l-3.5-1.6',
  check: 'M20 6 9 17l-5-5',
  extlink: 'M15 3h6v6|M10 14 21 3|M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
  terminal: 'm4 17 6-6-6-6|M12 19h8',
  code: 'm18 16 4-4-4-4|m6 8-4 4 4 4|m14.5 4-5 16',
  folderopen:
    'm6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2',
  folder:
    'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
  panel: 'M15 3v18',
  send: 'M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z|m21.854 2.147-10.94 10.939',
  zap: 'M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z',
  pencil:
    'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z',
  archive: 'M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8|M10 12h4'
}
/** 패스만으로 안 되는 아이콘의 보조 도형(원·사각형). */
const ICON_EXTRA = {
  branch: '<circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>',
  branchplus: '<circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>',
  bell: '<circle cx="18" cy="8" r="3" fill="currentColor" stroke="none"/>',
  settings: '<circle cx="12" cy="12" r="3"/>',
  panel: '<rect x="3" y="3" width="18" height="18" rx="2"/>',
  archive: '<rect x="2" y="3" width="20" height="5" rx="1"/>',
  cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/>'
}

/* ─────────────────────────── 출력 헬퍼 ─────────────────────────── */
const body = []
const css = []
let seq = 0
const uid = (p = 'a') => `${p}${(++seq).toString(36)}`
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const num = (v) => (Math.round(v * 100) / 100).toString()
const push = (s) => body.push(s)

function rect(x, y, w, h, o = {}) {
  const a = [`x="${num(x)}"`, `y="${num(y)}"`, `width="${num(w)}"`, `height="${num(h)}"`]
  if (o.r) a.push(`rx="${num(o.r)}"`)
  a.push(`fill="${o.fill || 'none'}"`)
  if (o.stroke) a.push(`stroke="${o.stroke}"`, `stroke-width="${o.sw || 1}"`)
  if (o.id) a.push(`id="${o.id}"`)
  return `<rect ${a.join(' ')}/>`
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
  if (o.id) a.push(`id="${o.id}"`)
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
  const sw = (o.sw || 2) / s / (o.noScaleStroke ? 1 : 1)
  return (
    `<g transform="translate(${num(x)},${num(y)}) scale(${num(s)})" ` +
    `fill="none" stroke="${color}" stroke-width="${num(sw * s)}" ` +
    `stroke-linecap="round" stroke-linejoin="round" color="${color}">${paths}${extra}</g>`
  )
}

/* ─────────────────────────── 타임라인 ─────────────────────────── */
const pct = (t) => num((Math.max(0, Math.min(DUR, t)) / DUR) * 100)

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

/** 어떤 시점에 A→B 로 딱 끊어 바뀌는 두 벌 교차용 스톱. */
const cross = (t) => ({
  out: [
    [0, 1],
    [t - 0.001, 1],
    [t, 0],
    [DUR, 0]
  ],
  in: [
    [0, 0],
    [t - 0.001, 0],
    [t, 1],
    [DUR, 1]
  ]
})

/* ─────────────────────────── 장면 ─────────────────────────── */

// 배경(루프 페이드 밖).
push(rect(0, 0, W, H, { fill: C.bg }))

const stage = []
const S = (s) => stage.push(s)

/* ---------- 타이틀바 (h-11, pl-20) ---------- */
S(rect(0, 0, W, 44, { fill: C.bg }))
S(rect(0, 43.5, W, 1, { fill: C.border }))
// 로고(W 모노그램)
S(
  `<g transform="translate(80,13) scale(0.5625)" fill="none">` +
    `<path d="M4.8 8.3 L10.8 25.3 L16 13.3 L21.2 25.3 L27.2 8.3" stroke="url(#wg)" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<circle cx="4.8" cy="8.3" r="3.3" fill="url(#wg)"/><circle cx="16" cy="13.3" r="3.3" fill="url(#wg)"/><circle cx="27.2" cy="8.3" r="3.3" fill="url(#wg)"/></g>`
)
S(
  rich(106, 27, [
    { t: 'Wooi', weight: 600, fill: C.n200 },
    { t: '  · AI coding agent orchestrator', fill: C.n600 }
  ])
)
S(icon('settings', 1240, 14, 16, C.n400, { sw: 2 }))

/* 타이틀바 우측 attention 클러스터 — 우측에서 왼쪽으로 쌓는다. */
{
  const gear = 1232
  // Unread (1)
  const uw = 96
  const ux = gear - uw
  S(
    animated(
      rect(ux, 8, uw, 28, { r: 6, fill: C.info600 }) +
        icon('bell', ux + 9, 15, 13, '#fff') +
        text(ux + 27, 26, 'Unread (1)', { px: 11, fill: '#fff', weight: 500 }),
      { opacity: fade(3.3, 3.6, 6.9, 7.2) }
    )
  )
  // Needs input (1)
  const nw = 116
  const nx = ux - 6 - nw
  S(
    animated(
      rect(nx, 8, nw, 28, { r: 6, fill: C.warning500 }) +
        icon('shield', nx + 9, 15, 13, '#000') +
        text(nx + 27, 26, 'Needs input (1)', { px: 11, fill: '#000', weight: 500 }),
      { opacity: fade(2.9, 3.2, 6.9, 7.2) }
    )
  )
  // Stop all
  const sw2 = 74
  const sx = nx - 6 - sw2
  S(
    animated(
      rect(sx, 8, sw2, 28, { r: 6, fill: '#fb2c361a', stroke: '#fb2c3633' }) +
        rect(sx + 9, 18, 9, 9, { r: 1.5, fill: C.danger300 }) +
        text(sx + 24, 26, 'Stop all', { px: 11, fill: C.danger300 }),
      { opacity: fade(1.7, 2.0, 13.5, 13.8) }
    )
  )
  // running count
  const rw = 48
  const rx = sx - 6 - rw
  const spinner =
    `<g transform="translate(${rx + 9},14)">` +
    animated(
      icon('loader', 0, 0, 12, C.info300),
      {
        transform: [
          [0, 'rotate(0deg)'],
          [DUR, `rotate(${DUR * 360}deg)`]
        ]
      },
      { origin: '6px 6px' }
    ) +
    `</g>`
  S(
    animated(
      rect(rx, 8, rw, 28, { r: 6, fill: '#2b7fff1a', stroke: '#2b7fff33' }) +
        spinner +
        animated(text(rx + 27, 26, '3', { px: 11, fill: C.info300 }), {
          opacity: fade(0, 0.01, 2.69, 2.7)
        }) +
        animated(text(rx + 27, 26, '1', { px: 11, fill: C.info300 }), {
          opacity: [
            [0, 0],
            [2.699, 0],
            [2.7, 1],
            [8.14, 1],
            [8.15, 0],
            [10.99, 0],
            [11.0, 1],
            [DUR, 1]
          ]
        }) +
        animated(text(rx + 27, 26, '2', { px: 11, fill: C.info300 }), {
          opacity: [
            [0, 0],
            [8.149, 0],
            [8.15, 1],
            [10.99, 1],
            [11.0, 0],
            [DUR, 0]
          ]
        }),
      { opacity: fade(1.5, 1.8, 13.5, 13.8) }
    )
  )
}

/* ---------- 사이드바 (w-72) ---------- */
S(rect(0, 44, 288, APP_H - 44, { fill: C.bg2 }))
S(rect(287.5, 44, 1, APP_H - 44, { fill: C.border }))
S(text(12, 68, 'REPOSITORIES', { px: 11, fill: C.n500, weight: 600, ls: '0.55' }))
S(icon('plus', 258, 56, 15, C.n500))
S(icon('chevron', 12, 91, 12, C.n400))
S(text(28, 101, 'acme-web', { px: 12, fill: C.n400, weight: 500 }))

/* 워크스페이스 행 */
const ROWS = [
  {
    id: 'r1',
    pad: 12,
    name: 'Extract auth service',
    branch: 'wooi/auth-service',
    meta: ' ·12',
    time: ' · 2m 04s',
    key: '⌘1',
    at: 0.55
  },
  {
    id: 'r2',
    pad: 12,
    name: 'Dark mode toggle',
    branch: 'wooi/dark-mode',
    meta: ' ·4',
    time: ' · 1m 12s',
    key: '⌘2',
    at: 0.85
  },
  {
    id: 'r3',
    pad: 12,
    name: 'Fix flaky signup test',
    branch: 'wooi/flaky-signup',
    meta: ' ·3',
    time: ' · ↑2',
    key: '⌘3',
    at: 1.15
  },
  {
    id: 'r4',
    pad: 26,
    name: 'JWT rotation',
    branch: 'wooi/jwt-rotation',
    meta: '',
    time: ' · ↑7',
    key: '⌘4',
    at: 8.15
  },
  {
    id: 'r5',
    pad: 40,
    name: 'Revoke endpoint',
    branch: 'wooi/jwt-revoke',
    meta: '',
    time: ' · ↑3',
    key: '⌘5',
    at: 8.85
  }
]

const ROW_TOP = 112
const ROW_H = 34
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

ROWS.forEach((r, i) => {
  const y = ROW_TOP + i * ROW_H
  const inner = []
  const tx = r.pad + 21

  // 선택 배경 (r1: 0–8.15s, r4: 8.15s–)
  if (r.id === 'r1') {
    inner.push(
      animated(rect(4, y, 280, 32, { r: 6, fill: C.surface3 }), {
        opacity: [
          [0, 1],
          [8.149, 1],
          [8.15, 0],
          [DUR, 0]
        ]
      })
    )
  } else if (r.id === 'r4') {
    inner.push(
      animated(rect(4, y, 280, 32, { r: 6, fill: C.surface3 }), {
        opacity: [
          [0, 0],
          [8.149, 0],
          [8.15, 1],
          [DUR, 1]
        ]
      })
    )
  }

  // 이름 — 선택 시 더 밝게(두 벌 교차)
  const nmY = y + 14
  if (r.id === 'r1') {
    inner.push(
      animated(text(tx, nmY, r.name, { px: 12, fill: C.n100 }), {
        opacity: [
          [0, 1],
          [8.149, 1],
          [8.15, 0],
          [DUR, 0]
        ]
      }),
      animated(text(tx, nmY, r.name, { px: 12, fill: C.n300 }), {
        opacity: [
          [0, 0],
          [8.149, 0],
          [8.15, 1],
          [DUR, 1]
        ]
      })
    )
  } else if (r.id === 'r4') {
    inner.push(
      animated(text(tx, nmY, r.name, { px: 12, fill: C.n300 }), {
        opacity: [
          [0, 1],
          [8.149, 1],
          [8.15, 0],
          [DUR, 0]
        ]
      }),
      animated(text(tx, nmY, r.name, { px: 12, fill: C.n100 }), {
        opacity: [
          [0, 0],
          [8.149, 0],
          [8.15, 1],
          [DUR, 1]
        ]
      })
    )
  } else {
    inner.push(text(tx, nmY, r.name, { px: 12, fill: C.n300 }))
  }

  // 브랜치 줄 — 한 <text> 안에서 tspan 이 자연스럽게 이어 흐른다(폭 계산 불필요).
  const brY = y + 27
  inner.push(icon('branch', tx, brY - 9, 10, C.n500, { sw: 2 }))
  const timeFill = r.time.includes('↑') ? C.n500 : C.info400
  const line = (withTime) => {
    const segs = [{ t: r.branch, fill: C.n500 }]
    if (r.meta) segs.push({ t: r.meta, fill: C.warning500 })
    if (withTime) segs.push({ t: r.time, fill: timeFill })
    return rich(tx + 14, brY, segs, { px: 11, fill: C.n500 })
  }
  // 상태가 바뀌는 행은 줄 전체를 두 벌로 만들어 교차시킨다.
  const at = r.id === 'r1' ? 13.6 : r.id === 'r2' ? 2.7 : null
  if (at) {
    const x = cross(at)
    inner.push(animated(line(true), { opacity: x.out }), animated(line(false), { opacity: x.in }))
  } else {
    inner.push(line(true))
  }

  // 상태 아이콘
  const ix = r.pad
  const iy = y + 9.5
  if (r.id === 'r1') {
    inner.push(
      animated(spinAt(ix, iy, 13, C.info400), {
        opacity: [
          [0, 1],
          [13.599, 1],
          [13.6, 0],
          [DUR, 0]
        ]
      }),
      animated(`<circle cx="${ix + 6.5}" cy="${iy + 6.5}" r="4" fill="${C.purple400}"/>`, {
        opacity: [
          [0, 0],
          [13.599, 0],
          [13.6, 1],
          [DUR, 1]
        ]
      })
    )
  } else if (r.id === 'r2') {
    inner.push(
      animated(spinAt(ix, iy, 13, C.info400), {
        opacity: [
          [0, 1],
          [2.699, 1],
          [2.7, 0],
          [DUR, 0]
        ]
      }),
      animated(icon('shield', ix, iy, 13, C.warning400), {
        opacity: [
          [0, 0],
          [2.699, 0],
          [2.7, 1],
          [DUR, 1]
        ]
      })
    )
  } else if (r.id === 'r3') {
    inner.push(
      animated(spinAt(ix, iy, 13, C.info400), {
        opacity: [
          [0, 1],
          [3.099, 1],
          [3.1, 0],
          [DUR, 0]
        ]
      }),
      animated(`<circle cx="${ix + 6.5}" cy="${iy + 6.5}" r="4" fill="${C.success400}"/>`, {
        opacity: [
          [0, 0],
          [3.099, 0],
          [3.1, 1],
          [DUR, 1]
        ]
      }),
      animated(`<circle cx="248" cy="${y + 16}" r="4" fill="${C.info500}"/>`, {
        opacity: fade(3.1, 3.4, 6.9, 7.2)
      })
    )
  } else if (r.id === 'r4') {
    inner.push(
      animated(spinAt(ix, iy, 13, C.info400), {
        opacity: [
          [0, 1],
          [10.999, 1],
          [11.0, 0],
          [DUR, 0]
        ]
      }),
      animated(`<circle cx="${ix + 6.5}" cy="${iy + 6.5}" r="4" fill="${C.success400}"/>`, {
        opacity: [
          [0, 0],
          [10.999, 0],
          [11.0, 1],
          [DUR, 1]
        ]
      })
    )
  } else {
    inner.push(`<circle cx="${ix + 6.5}" cy="${iy + 6.5}" r="4" fill="${C.n400}"/>`)
  }

  inner.push(text(276, y + 20, r.key, { px: 11, fill: C.n600, weight: 500, anchor: 'end' }))

  S(animated(inner.join(''), { opacity: fade(r.at, r.at + 0.45) }))
})

/* ---------- 헤더 (h-12) ---------- */
S(rect(288, 91.5, W - 288, 1, { fill: C.border }))
// 제목/브랜치 (두 벌 교차)
S(
  animated(
    text(304, 68, 'Extract auth service', { px: 15, weight: 600, fill: C.n100 }) +
      icon('branch', 304, 74, 11, C.n500) +
      text(319, 83, 'wooi/auth-service · 12 changed · ↑12', { px: 11, fill: C.n500 }),
    {
      opacity: [
        [0, 1],
        [8.149, 1],
        [8.15, 0],
        [DUR, 0]
      ]
    }
  )
)
S(
  animated(
    text(304, 68, 'JWT rotation', { px: 15, weight: 600, fill: C.n100 }) +
      icon('branch', 304, 74, 11, C.n500) +
      text(319, 83, 'wooi/jwt-rotation · 6 changed · ↑7', { px: 11, fill: C.n500 }),
    {
      opacity: [
        [0, 0],
        [8.149, 0],
        [8.15, 1],
        [DUR, 1]
      ]
    }
  )
)
// 우측 아이콘 버튼 — Stack 버튼 자리를 남기고 왼쪽으로 배치
;[
  ['terminal', 1017],
  ['code', 1049],
  ['folderopen', 1081],
  ['panel', 1113]
].forEach(([n, x]) => S(icon(n, x, 60, 15, C.n400)))

/* Stack 버튼 — 오른쪽 끝(1264)에 맞춰 정렬 */
{
  const bw = 116
  const bx = 1264 - bw
  const cnt = (s, stops) =>
    animated(rich(bx + 67, 72, [{ t: s, fill: C.n500 }], { px: 11 }), { opacity: stops })
  S(
    animated(
      rect(bx - 12, 54, 1, 28, { fill: C.border }) +
        rect(bx, 55, bw, 26, { r: 6, fill: C.surface, stroke: C.border }) +
        icon('layers', bx + 9, 62, 12, C.accent400) +
        text(bx + 27, 72, 'Stack', { px: 11, fill: C.n300, weight: 500 }) +
        cnt('3 · 3 PR', [
          [0, 1],
          [13.599, 1],
          [13.6, 0],
          [DUR, 0]
        ]) +
        cnt('3 · 2 PR', [
          [0, 0],
          [13.599, 0],
          [13.6, 1],
          [DUR, 1]
        ]),
      { opacity: fade(9.4, 9.8) }
    )
  )
}

/* ---------- 채팅 (하단 정렬) ---------- */
const CX_R = 1168 // 오른쪽 정렬 기준
const M = {
  m1: { total: 380.41, segs: [152.81, 55.39, 172.21] },
  m4: { total: 224.51, segs: [224.51] },
  m2: { total: 519.49, segs: [153.28, 76.16, 290.05] },
  m5: { total: 431.67, segs: [71.35, 117.7, 211.15, 27.69, 3.78] }
}

// 장면 1 메시지
{
  const bw = M.m1.total + 26
  const bx = CX_R - bw
  S(
    animated(
      rect(bx, 500, bw, 34, { r: 12, fill: C.surface2, stroke: C.border }) +
        rich(
          bx + 13,
          522,
          [
            { t: 'Extract everything under ', w: M.m1.segs[0], fill: C.n200 },
            { t: 'src/auth', w: M.m1.segs[1], px: 11.5, mono: true, fill: C.n300 },
            { t: ' into its own service module.', w: M.m1.segs[2], fill: C.n200 }
          ],
          { px: 13 }
        ),
      { opacity: fade(1.9, 2.3, 7.7, 8.05) }
    )
  )
  S(
    animated(
      rich(
        400,
        566,
        [
          { t: 'Moved 12 files behind an ', w: M.m2.segs[0], fill: '#aab0ba' },
          { t: 'AuthService', w: M.m2.segs[1], px: 11.5, mono: true, fill: C.n300 },
          {
            t: ' boundary and updated 31 call sites. Tests pass.',
            w: M.m2.segs[2],
            fill: '#aab0ba'
          }
        ],
        { px: 13 }
      ),
      { opacity: fade(3.6, 4.0, 7.7, 8.05) }
    )
  )
  S(
    animated(
      icon('check', 400, 587, 12, C.success400) +
        text(418, 597, 'npm test — 214 passed', { px: 11, fill: C.n500, mono: true }),
      { opacity: fade(4.6, 5.0, 7.7, 8.05) }
    )
  )
}

// 장면 2 메시지
{
  const bw = M.m4.total + 26
  const bx = CX_R - bw
  S(
    animated(
      rect(bx, 520, bw, 34, { r: 12, fill: C.surface2, stroke: C.border }) +
        rich(
          bx + 13,
          542,
          [{ t: 'Now add JWT rotation on top of that.', w: M.m4.segs[0], fill: C.n200 }],
          {
            px: 13
          }
        ),
      { opacity: fade(8.5, 8.9) }
    )
  )
  S(
    animated(
      rich(
        400,
        586,
        [
          { t: 'Stacked on ', w: M.m5.segs[0], fill: '#aab0ba' },
          { t: 'wooi/auth-service', w: M.m5.segs[1], px: 11.5, mono: true, fill: C.n300 },
          { t: ' — this PR targets that branch, not ', w: M.m5.segs[2], fill: '#aab0ba' },
          { t: 'main', w: M.m5.segs[3], px: 11.5, mono: true, fill: C.n300 },
          { t: '.', w: M.m5.segs[4], fill: '#aab0ba' }
        ],
        { px: 13 }
      ),
      { opacity: fade(9.3, 9.7) }
    )
  )
}

/* ---------- 컴포저 ---------- */
S(rect(288, 623.5, W - 288, 1, { fill: C.border }))
{
  const x0 = 400
  // 상태줄
  S(icon('branch', x0, 638, 11, C.n500))
  S(
    animated(text(x0 + 15, 647, 'wooi/auth-service', { px: 11, fill: C.n500 }), {
      opacity: [
        [0, 1],
        [8.149, 1],
        [8.15, 0],
        [DUR, 0]
      ]
    })
  )
  S(
    animated(text(x0 + 15, 647, 'wooi/jwt-rotation', { px: 11, fill: C.n500 }), {
      opacity: [
        [0, 0],
        [8.149, 0],
        [8.15, 1],
        [DUR, 1]
      ]
    })
  )
  S(icon('folder', x0 + 120, 638, 11, C.n500))
  S(
    animated(text(x0 + 135, 647, 'auth-service', { px: 11, fill: C.n500 }), {
      opacity: [
        [0, 1],
        [8.149, 1],
        [8.15, 0],
        [DUR, 0]
      ]
    })
  )
  S(
    animated(text(x0 + 135, 647, 'jwt-rotation', { px: 11, fill: C.n500 }), {
      opacity: [
        [0, 0],
        [8.149, 0],
        [8.15, 1],
        [DUR, 1]
      ]
    })
  )
  S(
    `<g transform="translate(${x0 + 220},638)"><rect x="0" y="0" width="11" height="11" rx="1.5" fill="none" stroke="${C.n500}" stroke-width="1.4"/><rect x="3.2" y="3.2" width="4.6" height="4.6" rx="1" fill="none" stroke="${C.n500}" stroke-width="1.4"/></g>`
  )
  // models.ts 의 MODEL_OPTIONS 라벨과 동일해야 한다(opus-4-8 은 접미사 없이도 1M).
  S(text(x0 + 237, 647, 'Opus 4.8 (1M context)', { px: 11, fill: C.n500 }))
  S(icon('zap', x0 + 370, 638, 11, C.n500))
  S(text(x0 + 385, 647, 'High', { px: 11, fill: C.n500 }))
  // context
  S(rect(CX_R - 62, 641, 64, 4, { r: 2, fill: C.surface2 }))
  S(rect(CX_R - 62, 641, 15.4, 4, { r: 2, fill: C.n500 }))
  S(text(CX_R, 647, '24%', { px: 11, fill: C.n500, anchor: 'end' }))
  // 입력창
  S(rect(x0, 658, 768, 48, { r: 12, fill: C.surface, stroke: C.border }))
  S(
    text(
      x0 + 13,
      687,
      // Composer.tsx 의 placeholder 와 문자 그대로 같아야 한다.
      'Message your agent…  (Enter to send · @ for files · / for commands · ! for terminal)',
      { px: 13, fill: C.n600 }
    )
  )
  S(rect(x0 + 724, 666, 32, 32, { r: 8, fill: C.info600 }))
  S(icon('send', x0 + 732.5, 674.5, 15, '#fff'))
  // 권한 모드
  S(text(x0, 723, '⏵⏵ accept edits on', { px: 11, fill: C.warning400 }))
  S(text(x0 + 108, 723, '(shift+tab to cycle)', { px: 11, fill: C.n600 }))
}

/* ---------- 행 액션 메뉴 ---------- */
{
  const mx = 96
  const my = 176
  const items = [
    ['pencil', 'Rename…', false],
    ['branchplus', 'Stack a new workspace', true],
    [null, null, null],
    ['bellplain', 'Mute notifications', false],
    ['archive', 'Archive workspace', false]
  ]
  const inner = [rect(mx, my, 232, 129, { r: 8, fill: C.surface, stroke: C.borderStrong })]
  let iy = my + 4
  for (const [ic, label, hi] of items) {
    if (!ic) {
      inner.push(rect(mx + 1, iy + 4, 230, 1, { fill: C.border }))
      iy += 9
      continue
    }
    if (hi) inner.push(rect(mx + 1, iy, 230, 28, { fill: C.surface2 }))
    inner.push(icon(ic, mx + 12, iy + 7.5, 13, hi ? C.n100 : C.n300))
    inner.push(text(mx + 33, iy + 18, label, { px: 12, fill: hi ? C.n100 : C.n300 }))
    iy += 28
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

/* ---------- 스택 팝오버 ---------- */
{
  const px0 = 944
  const py0 = 84
  const PW = 320
  const rows = [
    {
      name: 'Extract auth service',
      branch: 'wooi/jwt-rotation'.length ? 'wooi/auth-service' : '',
      depth: 0,
      cur: false,
      before: { dot: C.warning400, pr: '· #41 Review required', ah: '↑12' },
      after: { dot: C.purple400, pr: '· #41 Merged', ah: '' }
    },
    {
      name: 'JWT rotation',
      branch: 'wooi/jwt-rotation',
      depth: 1,
      cur: true,
      before: { dot: C.success400, pr: '· #42 Ready to merge', ah: '↑7' },
      after: { dot: C.success400, pr: '· #42 Ready · base → main', ah: '↑7' }
    },
    {
      name: 'Revoke endpoint',
      branch: 'wooi/jwt-revoke',
      depth: 2,
      cur: false,
      before: { dot: C.n400, pr: '· #43 Draft', ah: '↑3' },
      after: { dot: C.n400, pr: '· #43 Draft · rebased', ah: '↑3' }
    }
  ]
  const RH = 38
  const popH = 4 + 24 + rows.length * RH + 4
  const inner = [rect(px0, py0, PW, popH, { r: 8, fill: C.surface, stroke: C.borderStrong })]
  inner.push(text(px0 + 12, py0 + 20, 'STACK · 3 WORKSPACES', { px: 11, fill: C.n500, ls: '0.6' }))

  rows.forEach((r, i) => {
    const ry = py0 + 28 + i * RH
    const pad = px0 + 12 + r.depth * 14
    if (r.cur) inner.push(rect(px0 + 1, ry, PW - 2, RH - 2, { fill: C.surface2 }))
    // 상태 점 — 머지 전/후 교차
    inner.push(
      animated(`<circle cx="${pad + 4}" cy="${ry + 11}" r="4" fill="${r.before.dot}"/>`, {
        opacity: [
          [0, 1],
          [13.599, 1],
          [13.6, 0],
          [DUR, 0]
        ]
      }),
      animated(`<circle cx="${pad + 4}" cy="${ry + 11}" r="4" fill="${r.after.dot}"/>`, {
        opacity: [
          [0, 0],
          [13.599, 0],
          [13.6, 1],
          [DUR, 1]
        ]
      })
    )
    inner.push(text(pad + 14, ry + 15, r.name, { px: 11, fill: r.cur ? C.n100 : C.n300 }))
    if (r.cur)
      inner.push(icon('check', pad + 14 + r.name.length * 5.9 + 6, ry + 6, 11, C.accent400))
    // 두 번째 줄 — 브랜치·PR·ahead 를 한 <text> 로 흘려 폭 계산을 없앤다.
    inner.push(icon('branch', pad + 14, ry + 20, 9, C.n500, { sw: 2 }))
    const line2 = (v) =>
      rich(
        pad + 27,
        ry + 28,
        [
          { t: r.branch, fill: C.n500 },
          { t: `  ${v.pr}`, fill: C.n500 },
          ...(v.ah ? [{ t: `  ${v.ah}`, fill: C.n500 }] : [])
        ],
        { px: 11 }
      )
    inner.push(
      animated(line2(r.before), {
        opacity: [
          [0, 1],
          [13.599, 1],
          [13.6, 0],
          [DUR, 0]
        ]
      }),
      animated(line2(r.after), {
        opacity: [
          [0, 0],
          [13.599, 0],
          [13.6, 1],
          [DUR, 1]
        ]
      })
    )
    inner.push(icon('extlink', px0 + PW - 26, ry + 5, 13, C.n500))
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
        [0, 'translate(470px,430px)'],
        [6.2, 'translate(470px,430px)'],
        [6.95, 'translate(255px,150px)'],
        [9.9, 'translate(255px,150px)'],
        [10.5, 'translate(1240px,74px)'],
        [DUR, 'translate(1240px,74px)']
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
