import { ARTIFACT_KINDS, ARTIFACT_MAX_BYTES } from '@shared/types'
import type { ArtifactKind, Workspace } from '@shared/types'
import {
  compileCss,
  compileReact,
  extractCandidates,
  injectStylesheet,
  mermaidDocument,
  reactDocument,
  svgDocument
} from '../../artifactBuild'
import { getArtifacts, sourceFileFor } from '../../artifacts'
import { notifyArtifactsChanged, requestArtifactOpen } from '../../artifactProtocol'
import { getStore } from '../../store'
import type { AgentToolHandler } from './registry'

/**
 * 에이전트가 만든 것을 앱 안에서 **실행해** 보여주는 도구.
 *
 * 지금까지 산출물은 전부 텍스트였다 — 모델이 대시보드를 써도 사용자는 코드 블록을 읽을 뿐이고,
 * 실제로 보려면 파일로 저장해 따로 띄워야 했다. 이 도구는 그 왕복을 없앤다.
 *
 * 도구가 **하나**인 것은 의도다. `WOOI_COMMANDS` 는 도구와 1:1 이고 문서 두 벌이 절·표·개수를
 * 강제하므로([[agent-tool-anatomy]]) 도구를 늘리면 그 세금을 매번 다시 낸다. 목록·읽기 도구가
 * 필요 없는 이유는 **id 를 모델이 정하기 때문**이다 — 같은 id 로 다시 부르면 버전이 오르고,
 * `/clear` 로 컨텍스트가 날아가도 모델은 같은 일에 같은 slug 를 다시 고른다.
 *
 * 컴파일과 검증을 여기서(= main 에서) 하는 것이 이 파일의 존재 이유다. 게스트 안에서 실패하면
 * 그 실패는 샌드박스에 갇혀 모델이 영영 모른다. 여기서 throw 하면 registry 가 `{ok:false}` 로
 * 바꿔 **그 턴에** 모델에게 준다([[agent/tools/registry]]).
 */

/** 렌더할 수 있는 종류 — 이제 카탈로그의 다섯 가지 전부다. */
const SUPPORTED: readonly ArtifactKind[] = ARTIFACT_KINDS

/**
 * Tailwind 를 얹는 종류.
 *
 * `markdown` 은 웹뷰를 안 타므로(앱이 자기 스타일로 그린다) 제외하고, `mermaid` 는 본문이
 * 다이어그램 문법이라 클래스가 나올 자리가 없다.
 */
const STYLED: readonly ArtifactKind[] = ['html', 'svg', 'react']

/**
 * preflight(브라우저 기본 스타일 리셋)를 씌우는 종류.
 *
 * `react` 만이다 — 거기서는 문서를 우리가 만들므로 리셋이 일관된 출발점이 된다. `html`·`svg`
 * 는 모델이 `<style>` 까지 쓴 문서를 넘기므로, 리셋을 얹으면 모델이 본 적 없는 화면이 된다.
 */
const PREFLIGHT: readonly ArtifactKind[] = ['react']

function workspaceOf(workspaceId: string): Workspace {
  const ws = getStore()
    .getState()
    .workspaces.find((w) => w.id === workspaceId)
  if (!ws) throw new Error('This workspace no longer exists.')
  return ws
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 망을 타는 서브리소스를 쓰기 시점에 잡는다.
 *
 * 안 잡으면 아티팩트는 **뜨긴 뜨는데** 스타일도 스크립트도 없는 죽은 페이지가 되고, 그 사실은
 * 아무도 안 읽는 게스트 콘솔에만 남는다. 여기서 거절하면 모델이 같은 턴에 인라인으로 고친다.
 *
 * `<a href="http…">` 는 일부러 안 잡는다 — 눌러도 이동이 막힐 뿐 렌더는 멀쩡하고, 문서 안에
 * 참고 링크를 적는 것은 정상적인 일이다.
 */
const NETWORK_REFS: readonly RegExp[] = [
  /<script\b[^>]*\bsrc\s*=\s*["']?(?:https?:)?\/\//i,
  /<link\b[^>]*\bhref\s*=\s*["']?(?:https?:)?\/\//i,
  /<(?:img|image|iframe|video|audio|source|use)\b[^>]*\b(?:src|href|xlink:href)\s*=\s*["']?(?:https?:)?\/\//i,
  /@import\s+(?:url\()?["']?(?:https?:)?\/\//i,
  /url\(\s*["']?(?:https?:)?\/\//i
]

/**
 * 망 참조 검사를 거는 종류. `markdown` 은 HTML 태그가 안 나오고, `mermaid` 는 다이어그램
 * 문법이라 이 정규식들이 겨냥하는 모양이 애초에 없다.
 */
const OFFLINE_CHECKED: readonly ArtifactKind[] = ['html', 'svg', 'react']

function assertOffline(content: string, kind: ArtifactKind): void {
  if (!OFFLINE_CHECKED.includes(kind)) return
  if (!NETWORK_REFS.some((re) => re.test(content))) return
  throw new Error(
    'Artifacts run with no network access, so a CDN or remote URL will not load. ' +
      'Inline the code, styles and data directly in the artifact instead. ' +
      (kind === 'svg'
        ? 'For images, embed them as a data: URI.'
        : 'For images, embed them as a data: URI; for fonts, fall back to system fonts.')
  )
}

/**
 * 종류별로 디스크에 눕힐 파일들.
 *
 * 컴파일이 전부 여기서 끝나는 것이 요점이다 — 게스트는 완성된 정적 파일만 받는다
 * ([[main/artifactBuild]]). 실패는 throw 이고, 그 문구가 곧 모델이 다음 턴에 읽을 지시다.
 */
async function filesFor(
  kind: ArtifactKind,
  content: string,
  title: string
): Promise<{ files: Record<string, string>; hasCss: boolean }> {
  // react 는 컴파일된 모듈까지 후보에 넣지 않는다 — 원본의 className 이면 충분하고,
  // 컴파일 산출물에는 우리가 심은 URL 처럼 후보가 아닌 토큰이 섞인다.
  const css = STYLED.includes(kind)
    ? await compileCss(extractCandidates(content), { preflight: PREFLIGHT.includes(kind) })
    : ''
  const hasCss = css.length > 0
  const style: Record<string, string> = hasCss ? { 'style.css': css } : {}

  switch (kind) {
    case 'html':
      // 원본이 곧 문서다 — 복사본을 따로 두지 않고, 스타일시트 링크만 끼워 넣는다.
      return { files: { 'index.html': injectStylesheet(content), ...style }, hasCss }
    case 'svg':
      return {
        files: {
          [sourceFileFor('svg')]: content,
          'index.html': svgDocument(content, hasCss),
          ...style
        },
        hasCss
      }
    case 'markdown':
      // 웹뷰를 타지 않는다. 렌더러가 기존 MarkdownBody 로 그린다([[ChatPrimitives]]).
      return { files: { [sourceFileFor('markdown')]: content }, hasCss: false }
    case 'react':
      return {
        files: {
          [sourceFileFor('react')]: content,
          'module.js': compileReact(content),
          'index.html': reactDocument(title, hasCss),
          ...style
        },
        hasCss
      }
    case 'mermaid':
      return {
        files: {
          [sourceFileFor('mermaid')]: content,
          'index.html': mermaidDocument(title, content)
        },
        hasCss: false
      }
  }
}

export const createArtifact: AgentToolHandler = async (_deps, workspaceId, args) => {
  workspaceOf(workspaceId)

  const id = str(args.artifact_id)
  const kind = str(args.kind) as ArtifactKind
  const title = str(args.title)
  const content = typeof args.content === 'string' ? args.content : ''

  if (!SUPPORTED.includes(kind))
    throw new Error(`Unknown kind "${kind || '(missing)'}". Use one of: ${SUPPORTED.join(', ')}.`)
  if (!content.trim()) throw new Error('The artifact is empty — pass the full content to render.')

  const bytes = Buffer.byteLength(content, 'utf-8')
  if (bytes > ARTIFACT_MAX_BYTES)
    throw new Error(
      `That artifact is ${Math.round(bytes / 1024)}KB, over the ${ARTIFACT_MAX_BYTES / 1024}KB limit. ` +
        'Trim it down — inline data especially — or split it into more than one artifact.'
    )

  assertOffline(content, kind)

  const { files, hasCss } = await filesFor(kind, content, title || id)
  const meta = getArtifacts().write(workspaceId, {
    id,
    kind,
    title: title || id,
    files,
    hasCss
  })

  // 목록 갱신 → 탭 열기. 둘 다 best-effort 다 — 받을 화면이 없어도 아티팩트는 이미 디스크에 있다.
  notifyArtifactsChanged(workspaceId)
  requestArtifactOpen(workspaceId, meta.id, meta.version)

  // 본문은 돌려주지 않는다. 모델이 방금 쓴 것이고, 그대로 되돌리면 같은 토큰을 두 번 낸다.
  return {
    artifactId: meta.id,
    version: meta.version,
    kind: meta.kind,
    shownTo: 'The user can see it in the Artifacts tab of this workspace.'
  }
}
