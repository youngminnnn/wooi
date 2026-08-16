/** 연동 패널용 브랜드 마크. 외부 에셋 없이 인라인 SVG 로 둔다. */

import { AGENT_BACKEND_LABELS } from '@shared/types'
import type { AgentBackendId } from '@shared/types'
import { CLAUDE_MARK, CODEX_MARK, GITHUB_MARK } from '@shared/brandMarks'

export function ClaudeMark({ size = 18 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox={CLAUDE_MARK.viewBox} fill="none" aria-label="Claude">
      <path d={CLAUDE_MARK.path} fill={CLAUDE_MARK.fill} />
    </svg>
  )
}

export function CodexMark({ size = 18 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox={CODEX_MARK.viewBox}
      fill="currentColor"
      aria-label="Codex"
    >
      <path d={CODEX_MARK.path} />
    </svg>
  )
}

export function GithubMark({ size = 18 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox={GITHUB_MARK.viewBox}
      fill="currentColor"
      aria-label="GitHub"
    >
      <path d={GITHUB_MARK.path} />
    </svg>
  )
}

/**
 * 에이전트 백엔드별 마크. 백엔드가 여럿이 되면(예: Codex) 에이전트 행에서 "무엇이 돌고 있나"
 * 뿐 아니라 "무엇으로 돌고 있나"까지 한눈에 구분돼야 하므로, 아이콘을 백엔드에서 파생시킨다.
 *
 * Record<AgentBackendId, …> 로 두는 것이 핵심이다 — AgentBackendId 유니온에 'codex' 를 추가하면
 * 이 맵이 **컴파일 에러**가 되어, 아이콘을 빼먹은 채로 새 백엔드가 붙는 일이 생기지 않는다.
 * (이름은 도메인 쪽 AGENT_BACKEND_LABELS 가 같은 방식으로 보장한다.)
 */
const BACKEND_MARKS: Record<AgentBackendId, (props: { size?: number }) => React.JSX.Element> = {
  claude: ClaudeMark,
  codex: CodexMark
}

/**
 * 모르는 백엔드용 대체 마크. 속이 빈 원 — 무언가가 돌고 있다는 것만 말하고 어느 제품인지는
 * 주장하지 않는다.
 */
function UnknownMark({ size = 18 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.5" opacity="0.6" />
    </svg>
  )
}

export function AgentBackendMark({
  backend,
  size = 14
}: {
  backend: AgentBackendId
  size?: number
}): React.JSX.Element {
  // 위 맵의 exhaustive 보장은 **컴파일 시점**의 것이다. 여기 들어오는 값은 디스크에서 읽은
  // 워크스페이스의 것이고, dev 스토어는 워크트리끼리 공유된다 — 다른 브랜치가 추가한 백엔드
  // (예: 'copilot')가 그대로 흘러들어온다. 그때 조회 결과는 undefined 이고, React 는
  // <undefined /> 를 그리려다 **트리 전체를 죽인다**. 아이콘 하나 때문에 앱이 열리지 않는다.
  const Mark = (BACKEND_MARKS as Partial<typeof BACKEND_MARKS>)[backend] ?? UnknownMark
  const label = AGENT_BACKEND_LABELS[backend] ?? backend
  return (
    <span title={label} aria-label={label} className="inline-grid place-items-center">
      <Mark size={size} />
    </span>
  )
}
