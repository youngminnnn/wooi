import type { AgentBackendId, EffortSetting, Workspace } from '@shared/types'
import { AGENT_BACKEND_IDS } from '@shared/types'
import { backendMeta, resolveWorkspaceAgentBackend } from '../backend'
import { getStore } from '../../store'
import type { AgentToolDeps } from './registry'

/**
 * 워크스페이스를 만드는 두 도구가 공유하는 **에이전트 설정** 파싱 — 어떤 에이전트로 돌릴지,
 * 어떤 모델과 reasoning effort 로 돌릴지([[agent/tools/workspace]] · [[agent/tools/stackedWorkspace]]).
 *
 * 검증을 여기서 하는 이유는 실패 지점의 거리다. 잘못된 값은 createWorkspace 를 막지 않고 그대로
 * 저장되며, 사고는 **새 워크스페이스의 첫 턴**에서 터진다 — 화면을 가져가지도 않는 워크스페이스가
 * 조용히 세션 오류로 서 있고, 만든 에이전트는 이미 다른 일을 하는 중이다. 도구 오류로 돌려주면
 * 모델이 같은 턴 안에서 고쳐 다시 부를 수 있으므로, 메시지에 **고를 수 있는 값**을 함께 적는다.
 *
 * 모델 목록만 정적이 아니다(Codex 는 환경마다 다른 카탈로그를 준다). 그래서 도구 설명에 박지
 * 않고 런타임에 물어보며, 목록을 못 얻으면 검증을 **건너뛴다** — 알 수 없다는 이유로 사용자가
 * 정당하게 고른 모델을 거절하는 쪽이 더 나쁘다.
 */

/**
 * 어떤 실행이든 공통으로 고를 수 있는 것 — 모델과 추론 강도. 지정하지 않은 것은 키 자체가 없다.
 *
 * 워크스페이스와 위임 서브런이 이 모양을 공유한다. 둘은 백엔드를 정하는 방식이 다르지만(워크스페이스는
 * 인자·부모·기본값에서 **고르고**, 위임은 도구 이름으로 이미 **정해져 있다**) 그 뒤의 검증은 같다.
 */
export interface AgentRunOptions {
  model?: string
  effort?: EffortSetting
}

/** createWorkspace 에 그대로 펼쳐 넣을 수 있는 모양. */
export interface RequestedAgentOptions extends AgentRunOptions {
  agentBackend?: AgentBackendId
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export async function resolveRequestedAgentOptions(
  deps: AgentToolDeps,
  args: Record<string, unknown>,
  /** 스택이면 부모 워크스페이스. 에이전트를 생략했을 때 무엇을 물려받는지가 여기서 갈린다. */
  parent: Pick<Workspace, 'agentBackend'> | null
): Promise<RequestedAgentOptions> {
  const requested = readString(args.agentBackend)
  const agentBackend = AGENT_BACKEND_IDS.includes(requested as AgentBackendId)
    ? (requested as AgentBackendId)
    : undefined

  // 모델·effort 는 백엔드마다 다른 목록으로 검증해야 한다. 그 백엔드는 생성 규칙과 **같은
  // 답**이어야 하므로 createWorkspace 가 쓰는 함수를 그대로 부른다.
  const backend = resolveWorkspaceAgentBackend(
    agentBackend,
    parent,
    getStore().getState().settings.defaultAgentBackend
  )
  return {
    ...(agentBackend ? { agentBackend } : {}),
    ...(await validateAgentRunOptions(deps, backend, args))
  }
}

/**
 * 백엔드가 **이미 정해진** 실행의 model·effort 를 검증한다.
 *
 * 위임 서브런이 이 길로 온다([[agent/tools/subagent]]) — 거기서는 백엔드가 도구 이름으로 정해져
 * 있어(`codex_subagent`) 고를 것이 없고, 남는 것은 "이 백엔드가 그 모델과 강도를 받는가" 뿐이다.
 * 워크스페이스 생성과 같은 함수를 쓰는 이유는 메시지 때문이다 — 같은 실수에 같은 문장이 나와야
 * 모델이 한 번 배운 것으로 두 곳을 다 고칠 수 있다.
 */
export async function validateAgentRunOptions(
  deps: Pick<AgentToolDeps, 'listModels'>,
  backend: AgentBackendId,
  args: Record<string, unknown>
): Promise<AgentRunOptions> {
  const meta = backendMeta(backend)

  const effort = readString(args.effort)
  if (effort) {
    if (!meta.capabilities.effort) {
      throw new Error(
        `${meta.label} does not support a reasoning effort setting — omit \`effort\`.`
      )
    }
    const efforts = meta.efforts.map((option) => option.id)
    if (!efforts.includes(effort as EffortSetting)) {
      throw new Error(
        `${meta.label} has no "${effort}" reasoning effort. Valid values: ${efforts.join(', ')}.`
      )
    }
  }

  const model = readString(args.model)
  if (model) {
    const options = await deps.listModels(backend)
    if (options.length && !options.some((option) => option.id === model)) {
      throw new Error(
        `${meta.label} does not offer a model called "${model}". Available models: ` +
          `${options.map((option) => option.id).join(', ')}.`
      )
    }
  }

  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort: effort as EffortSetting } : {})
  }
}
