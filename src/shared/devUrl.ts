/**
 * Run 스크립트 출력에서 로컬 dev 서버 주소를 알아내고, 주소창 입력을 정규화한다.
 *
 * 포트 스캔은 하지 않는다 — 스크립트가 스스로 찍는 줄("Local: http://localhost:5173/")이
 * 이미 정답이고, 스캔은 이 워크스페이스와 무관한 남의 서버까지 주워 온다. 순수 함수로 떼어 둔
 * 이유는 이게 유일하게 틀리기 쉬운 부분이라서다(ANSI 색·재시작·꼬리 잘림).
 */

/** 색 입힌 로그의 escape 시퀀스. vite 는 URL **안쪽**(포트 강조)에도 넣으므로 먼저 걷어낸다. */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g

/**
 * 로컬 루프백 주소. 포트를 **필수**로 두는 것이 요점이다 — 포트 없는 `http://localhost` 는
 * 문서·주석에서 흔해서, 허용하면 dev 서버가 뜨지도 않았는데 배너가 뜬다.
 * `0.0.0.0` 은 `--host` 로 띄운 서버가 자주 찍는 값인데 그대로는 접속 주소가 아니라 127.0.0.1 로 옮긴다.
 */
const LOCAL_URL =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{1,5})(\/[^\s'"`<>)\]]*)?/gi

/** 주소 끝에 묻어 오는 문장부호(`Ready on http://localhost:3000.` 같은 줄). */
const TRAILING_PUNCT = /[.,;:!?]+$/

/** 로컬 루프백 호스트인지. 기본 정책("localhost 만")과 주소창 경고가 같은 판단을 쓴다. */
export function isLocalUrl(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url)
    if (protocol !== 'http:' && protocol !== 'https:') return false
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname === '[::1]' ||
      hostname === '::1' ||
      hostname.endsWith('.localhost')
    )
  } catch {
    return false
  }
}

/**
 * 스크립트 출력에서 dev 서버 주소를 찾는다. 없으면 null.
 *
 * **마지막** 매치를 고르는 이유: 꼬리 버퍼에는 여러 번의 재시작이 함께 남아 있을 수 있고,
 * 그때 유효한 것은 가장 최근에 찍힌 주소다(앞의 것은 이미 죽은 서버일 수 있다).
 */
export function detectDevUrl(output: string): string | null {
  if (!output) return null
  const plain = output.replace(ANSI, '')
  let last: string | null = null
  for (const m of plain.matchAll(LOCAL_URL)) last = m[0]
  if (!last) return null
  return normalizeDevUrl(last.replace(TRAILING_PUNCT, ''))
}

/** `0.0.0.0` 을 실제로 접속 가능한 루프백으로 옮긴다(그 밖에는 그대로). */
function normalizeDevUrl(url: string): string {
  return url.replace(/^(https?:\/\/)0\.0\.0\.0(?=[:/]|$)/i, '$1127.0.0.1')
}

/**
 * 주소창에 친 것을 실제 URL 로 만든다. 못 만들면 null.
 *
 * 스킴 없이 `localhost:3000` 이나 포트만(`5173`) 치는 쪽이 자연스러운 화면이라, 그 두 형태를
 * 받아 준다. 나머지는 스킴만 붙여 URL 파서에 맡긴다 — 여기서 화이트리스트를 더 좁히지는 않는다
 * (외부 주소 입력 자체를 막지는 않는 것이 M1 의 방침이다).
 */
export function normalizeInputUrl(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  if (/^\d{1,5}$/.test(raw)) return `http://localhost:${raw}`
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return normalizeDevUrl(url.toString())
  } catch {
    return null
  }
}

/** 첨부 파일 이름에 쓸 짧은 라벨(`localhost-5173`). URL 을 못 읽으면 'preview'. */
export function previewLabel(url: string): string {
  try {
    const { hostname, port } = new URL(url)
    const base = `${hostname}${port ? `-${port}` : ''}`
    return base.replace(/[^a-z0-9.-]+/gi, '-') || 'preview'
  } catch {
    return 'preview'
  }
}
