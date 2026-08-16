import type {
  AgentBackendId,
  EffortSetting,
  ReviewArtifact,
  ReviewLayerDiff,
  ReviewProgressItem
} from '@shared/types'
import { buildReviewPrompt, reviewOutputSchema, type ReviewPromptMeta } from './prompt'
import { runClaudeReview } from './runClaude'
import { runCodexReview } from './runCodex'
import { runCopilotReview } from './runCopilot'

/**
 * 리뷰 실행의 백엔드 분배기.
 *
 * 어느 에이전트로 돌든 **바깥에서 보이는 계약은 같다** — 같은 프롬프트를 받고, 같은 구조화
 * 결과(ReviewArtifact)와 이어 붙일 세션 id 를 돌려준다. 그래서 manager 는 백엔드를 신경 쓰지
 * 않고, 새 백엔드가 늘어도 여기 한 줄만 늘어난다.
 */

export interface ReviewRunDeps {
  /** 이 리뷰를 돌릴 에이전트. 세션 생성 시 고정되며 후속 턴도 같은 것을 쓴다. */
  backend: AgentBackendId
  /** PR head 가 체크아웃된 리뷰 워크트리. */
  cwd: string
  /** MCP 서버 해석 기준이 되는 원본 repo 경로. */
  repoPath: string
  model: string | null
  effort: EffortSetting | null
  userPrompt: string
  meta: ReviewPromptMeta
  /** 레이어별 diff(아래→위). PR 하나짜리 리뷰는 원소가 하나다. */
  diffs: ReviewLayerDiff[]
  /**
   * 이어받을 에이전트 세션 id. 주면 앞선 리뷰 맥락 위에서 대화가 이어진다.
   * Claude 는 `resume`, Codex 는 `codex exec resume` 의 thread id, Copilot 은 ACP `session/load` 의
   * session id 다.
   */
  resumeSessionId?: string | null
  /** 주면 이 문장을 그대로 프롬프트로 쓴다(후속 턴). 없으면 최초 리뷰 프롬프트를 만든다. */
  promptOverride?: string
  abort: AbortController
  onProgress: (item: ReviewProgressItem) => void
}

export interface ReviewRunResult {
  artifact: ReviewArtifact | null
  /** 구조화 출력이 없을 때 사용자에게 보여줄 원문. */
  rawText: string
  /** 후속 턴을 같은 맥락으로 resume 하기 위한 세션 id. */
  sessionId: string | null
  error: string | null
  /** 예산에 못 들어가 프롬프트에서 이름만 나열된 파일 수(후속 턴은 프롬프트를 새로 짓지 않아 0). */
  truncatedFiles: number
}

/** 백엔드가 돌려주는 것. 예산 보고는 프롬프트를 지은 이쪽이 붙인다. */
export type BackendReviewResult = Omit<ReviewRunResult, 'truncatedFiles'>

/** 이 실행에 쓸 출력 스키마. 레이어 수에 따라 필수 필드가 달라진다([[review/prompt]]). */
export function schemaFor(deps: ReviewRunDeps): Record<string, unknown> {
  return reviewOutputSchema(deps.meta.layers.length)
}

export async function runReview(deps: ReviewRunDeps): Promise<ReviewRunResult> {
  const built = deps.promptOverride
    ? { text: deps.promptOverride, truncatedFiles: 0 }
    : buildReviewPrompt({
        userPrompt: deps.userPrompt,
        meta: deps.meta,
        diffs: deps.diffs
      })

  const result =
    deps.backend === 'codex'
      ? await runCodexReview(deps, built.text)
      : deps.backend === 'copilot'
        ? await runCopilotReview(deps, built.text)
        : await runClaudeReview(deps, built.text)
  return { ...result, truncatedFiles: built.truncatedFiles }
}
