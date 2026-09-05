import { ARTIFACT_HOST, ARTIFACT_ID_RE, ARTIFACT_SCHEME } from './types'

/**
 * 아티팩트 URL 의 문법과 그 역파싱.
 *
 * main 의 protocol 핸들러와 렌더러의 `loadURL` 이 **같은 함수**를 쓴다. 양쪽에서 문자열을
 * 따로 조립하면 언젠가 한쪽만 고쳐지고, 그 순간 화면은 조용히 404 가 된다. electron 을
 * import 하지 않는 이유도 같다 — 렌더러가 쓸 수 있어야 하고([[host-import-boundary]]),
 * 순수 함수라야 테스트가 문다.
 *
 * 문법은 두 갈래다:
 *
 * ```
 * wooi-artifact://a/v/<file>                                   벤더 라이브러리(원본 공유)
 * wooi-artifact://a/w/<workspaceId>/<artifactId>/<version>/<file>   아티팩트 본문
 * ```
 *
 * `v`/`w` 접두사가 둘을 가른다. 벤더를 아티팩트 경로 **아래** 두지 않는 이유는 공유다 —
 * react 한 벌을 모든 아티팩트가 같은 URL 로 받아야 브라우저 캐시와 모듈 인스턴스가 하나로
 * 모인다(recharts 가 우리 react 와 다른 react 를 잡으면 훅이 죽는다).
 */

/** 아티팩트 디렉터리 안에서 서빙되는 파일 이름. 이 셋 말고는 핸들러가 404 를 낸다. */
export type ArtifactFile = 'index.html' | 'module.js' | 'style.css'

export const ARTIFACT_FILES: readonly ArtifactFile[] = ['index.html', 'module.js', 'style.css']

/**
 * 벤더 파일 이름 규칙 — 번들이 뱉는 `[name].js` 와 `chunk-[hash].js` 만.
 * 해시에 대문자가 섞이므로 대소문자를 다 받는다. `/` 는 없다(한 층짜리 디렉터리다).
 */
const VENDOR_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.js$/

/** 아티팩트 문서의 origin. 이동 가드가 "여기 말고는 못 간다" 의 기준으로 쓴다. */
export const ARTIFACT_ORIGIN = `${ARTIFACT_SCHEME}://${ARTIFACT_HOST}`

const ORIGIN = ARTIFACT_ORIGIN

/** 벤더 라이브러리 URL. import 지정자 재작성이 이 경로를 심는다. */
export function vendorUrl(file: string): string {
  return `${ORIGIN}/v/${file}`
}

/**
 * 아티팩트 한 버전의 파일 URL.
 *
 * 문서는 `index.html` 을 **명시**한다 — 디렉터리 인덱스로 두면 핸들러가 "끝에 `/` 가 있나"
 * 로 갈라져야 하고, 그 분기는 경로 검증을 한 겹 더 만든다.
 */
export function artifactUrl(
  workspaceId: string,
  artifactId: string,
  version: number,
  file: ArtifactFile = 'index.html'
): string {
  return `${ORIGIN}/w/${workspaceId}/${artifactId}/${version}/${file}`
}

export type ArtifactRoute =
  | { kind: 'vendor'; file: string }
  | {
      kind: 'artifact'
      workspaceId: string
      artifactId: string
      version: number
      file: ArtifactFile
    }

/**
 * 아티팩트 URL 을 역파싱한다. 문법에 안 맞으면 `null` — 호출자는 404 를 낸다.
 *
 * **여기서 통과했다고 파일을 열어도 되는 것은 아니다.** id 문자셋만 본다. 실제 경로가
 * 저장소 루트 안에 있는지는 `path.resolve` 뒤에 다시 확인한다([[main/artifacts]]) — 정규식
 * 하나에 파일시스템 안전을 걸지 않는다.
 */
export function parseArtifactUrl(rawUrl: string): ArtifactRoute | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }

  if (url.protocol !== `${ARTIFACT_SCHEME}:`) return null
  if (url.hostname !== ARTIFACT_HOST) return null

  // 쿼리·프래그먼트는 문법에 없다. 붙어 있으면 우리가 만든 URL 이 아니다.
  if (url.search || url.hash) return null

  // `%2e%2e` 같은 인코딩은 Chromium 이 여기까지 남겨 보낼 수 있다. 디코드해서 본다 —
  // 디코드가 실패하는 입력(고아 `%`)도 우리 것이 아니므로 거절.
  let path: string
  try {
    path = decodeURIComponent(url.pathname)
  } catch {
    return null
  }

  const parts = path.split('/')
  // 선행 '/' 때문에 첫 조각은 항상 빈 문자열이다.
  if (parts.shift() !== '') return null
  // 빈 조각('//')·'.'·'..' 는 문법에 없다. 여기서 전부 떨군다.
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null

  if (parts[0] === 'v') {
    if (parts.length !== 2) return null
    if (!VENDOR_FILE_RE.test(parts[1])) return null
    return { kind: 'vendor', file: parts[1] }
  }

  if (parts[0] === 'w') {
    if (parts.length !== 5) return null
    const [, workspaceId, artifactId, rawVersion, file] = parts
    if (!ARTIFACT_ID_RE.test(workspaceId)) return null
    if (!ARTIFACT_ID_RE.test(artifactId)) return null
    if (!/^[1-9][0-9]{0,4}$/.test(rawVersion)) return null
    if (!ARTIFACT_FILES.includes(file as ArtifactFile)) return null
    return {
      kind: 'artifact',
      workspaceId,
      artifactId,
      version: Number(rawVersion),
      file: file as ArtifactFile
    }
  }

  return null
}
