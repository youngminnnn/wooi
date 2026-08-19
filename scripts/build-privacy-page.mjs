#!/usr/bin/env node
/**
 * `PRIVACY.md` 에서 `docs/privacy.html` 을 만든다.
 *
 *   node scripts/build-privacy-page.mjs           # 생성
 *   node scripts/build-privacy-page.mjs --check   # 최신인지 검사만 (CI 용)
 *
 * 왜 손으로 안 쓰나: Play Console 은 **공개된 URL** 을 요구하고, GitHub blob 링크도 통과하긴
 * 하지만 스토어에서 눌렀을 때 코드 뷰어가 열리는 건 좋지 않다. 그렇다고 HTML 을 따로 쓰면
 * `PRIVACY.md` 와 갈라진다 — 개인정보처리방침이 두 벌 존재하는 건 그 자체로 사고다.
 * 그래서 마크다운을 단일 소스로 두고 페이지는 파생물로 만든다.
 *
 * 변환기는 `PRIVACY.md` 가 실제로 쓰는 문법만 다룬다 — 제목·문단·목록·링크·굵게·인라인 코드.
 * 표나 코드 블록을 새로 쓰기 시작하면 여기도 같이 늘려야 한다(`--check` 가 잡아 준다).
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(root, 'PRIVACY.md')
const OUTPUT = join(root, 'docs', 'privacy.html')

/** 코드 스팬을 잠시 치워 둘 때 쓰는 표식. 마크다운 본문에는 나오지 않는 문자다. */
const MARK = '\uFFFC'

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * 인라인 문법. 코드부터 집어내야 코드 안의 별표가 굵게로 먹지 않는다.
 *
 * 자리표시자로 U+FFFC(OBJECT REPLACEMENT CHARACTER)를 쓴다 — 본문에 나올 일이 없고,
 * NUL 같은 제어문자와 달리 정규식 리터럴에 넣어도 `no-control-regex` 에 걸리지 않는다.
 */
function inline(text) {
  const code = []
  let out = text.replace(/`([^`]+)`/g, (_, body) => {
    code.push(body)
    return `${MARK}${code.length - 1}${MARK}`
  })
  out = escapeHtml(out)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    // 레포 안의 마크다운을 가리키는 링크는 GitHub 으로 보낸다 — 사이트에는 그 파일이 없다.
    const url = /^https?:/.test(href)
      ? href
      : `https://github.com/youngminnnn/wooi/blob/main/${href.replace(/^\.\//, '')}`
    return `<a href="${url}">${label}</a>`
  })
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  return out.replace(
    new RegExp(`${MARK}(\\d+)${MARK}`, 'g'),
    (_, i) => `<code>${escapeHtml(code[Number(i)])}</code>`
  )
}

function render(markdown) {
  const lines = markdown.split('\n')
  const html = []
  let list = null // 열려 있는 <ul> 안의 항목들
  let para = []

  const flushPara = () => {
    if (para.length) html.push(`<p>${inline(para.join(' '))}</p>`)
    para = []
  }
  const flushList = () => {
    if (list) html.push(`<ul>\n${list.map((i) => `  <li>${inline(i)}</li>`).join('\n')}\n</ul>`)
    list = null
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    const heading = /^(#{1,6}) (.*)$/.exec(line)
    const bullet = /^\s*[-*] (.*)$/.exec(line)

    if (heading) {
      flushPara()
      flushList()
      const level = heading[1].length
      const id = heading[2]
        .toLowerCase()
        .replace(/[^\w\s가-힣-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
      html.push(`<h${level} id="${id}">${inline(heading[2])}</h${level}>`)
    } else if (bullet) {
      flushPara()
      ;(list ??= []).push(bullet[1])
    } else if (!line.trim()) {
      flushPara()
      flushList()
    } else if (list) {
      // 목록 항목이 다음 줄로 이어진 경우
      list[list.length - 1] += ` ${line.trim()}`
    } else {
      para.push(line.trim())
    }
  }
  flushPara()
  flushList()
  return html.join('\n')
}

const markdown = readFileSync(SOURCE, 'utf8')
const title = /^#\s+(.*)$/m.exec(markdown)?.[1] ?? 'Privacy'
// 첫 제목은 페이지 헤더가 대신하므로 본문에서 뺀다.
const body = render(markdown.replace(/^#\s+.*$/m, ''))

const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)} | Wooi</title>
    <meta
      name="description"
      content="What data Wooi handles, where it goes, and what the relay between your computer and your phone can and cannot see."
    />
    <link rel="canonical" href="https://youngminnnn.github.io/wooi/privacy.html" />
    <meta property="og:type" content="article" />
    <meta property="og:title" content="${escapeHtml(title)} | Wooi" />
    <meta property="og:url" content="https://youngminnnn.github.io/wooi/privacy.html" />
    <meta property="og:image" content="https://youngminnnn.github.io/wooi/og.png" />
    <meta name="theme-color" content="#0a0b0d" />
    <link rel="icon" type="image/svg+xml" href="./favicon.svg" />
    <link rel="apple-touch-icon" href="./apple-touch-icon.png" />
    <style>
      :root {
        --bg: #0a0b0d;
        --bg-soft: #13161c;
        --border: #262c37;
        --text: #e8ecf3;
        --text-dim: #a3adbe;
        --blue: #74acff;
        --purple: #b08bfa;
        --sans:
          -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Pretendard', 'Apple SD Gothic Neo',
          Roboto, 'Helvetica Neue', Arial, sans-serif;
        --mono: ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font-family: var(--sans);
        font-size: 17px;
        line-height: 1.75;
        -webkit-font-smoothing: antialiased;
      }
      .wrap { max-width: 760px; margin: 0 auto; padding: 56px 24px 96px; }
      header { border-bottom: 1px solid var(--border); padding-bottom: 28px; margin-bottom: 40px; }
      .home { color: var(--text-dim); text-decoration: none; font-size: 15px; }
      .home:hover { color: var(--text); }
      h1 {
        font-size: 40px;
        line-height: 1.2;
        margin: 20px 0 0;
        background: linear-gradient(120deg, #74acff 0%, #b08bfa 100%);
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
      }
      h2 { font-size: 26px; margin: 48px 0 12px; line-height: 1.3; }
      h3 { font-size: 20px; margin: 32px 0 8px; color: var(--text); }
      p { color: var(--text-dim); margin: 14px 0; }
      ul { color: var(--text-dim); padding-left: 22px; }
      li { margin: 8px 0; }
      strong { color: var(--text); font-weight: 650; }
      a { color: var(--blue); text-decoration: none; border-bottom: 1px solid rgba(116, 172, 255, 0.3); }
      a:hover { border-bottom-color: var(--blue); }
      code {
        font-family: var(--mono);
        font-size: 0.88em;
        background: var(--bg-soft);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 1px 6px;
        color: var(--purple);
      }
      footer { margin-top: 72px; padding-top: 24px; border-top: 1px solid var(--border); color: var(--text-dim); font-size: 14px; }
      @media (max-width: 560px) { .wrap { padding: 36px 18px 64px; } h1 { font-size: 32px; } }
    </style>
  </head>
  <body>
    <div class="wrap">
      <header>
        <a class="home" href="./">&larr; Wooi</a>
        <h1>${escapeHtml(title)}</h1>
      </header>
${body
  .split('\n')
  .map((l) => (l ? `      ${l}` : l))
  .join('\n')}
      <footer>
        This page is generated from
        <a href="https://github.com/youngminnnn/wooi/blob/main/PRIVACY.md">PRIVACY.md</a>
        in the Wooi repository. That file is the source of truth.
      </footer>
    </div>
  </body>
</html>
`

if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = readFileSync(OUTPUT, 'utf8')
  } catch {
    console.error(
      'docs/privacy.html 이 없습니다. `node scripts/build-privacy-page.mjs` 를 실행하세요.'
    )
    process.exit(1)
  }
  if (current !== page) {
    console.error('docs/privacy.html 이 PRIVACY.md 와 어긋납니다.')
    console.error('`node scripts/build-privacy-page.mjs` 를 실행해 다시 만들고 커밋하세요.')
    process.exit(1)
  }
  console.log('docs/privacy.html 최신입니다.')
} else {
  writeFileSync(OUTPUT, page)
  console.log(`docs/privacy.html 을 만들었습니다 (${page.length.toLocaleString()} bytes).`)
}
