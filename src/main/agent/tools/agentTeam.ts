import { AGENT_BACKEND_LABELS } from '@shared/types'
import { getStore } from '../../store'
import { canLeadAgentTeam, delegateBackendsFor } from '../multiAgent'
import { delegateToolName } from './catalog'
import type { AgentToolHandler } from './registry'
import { callerWorkspace } from './target'

/**
 * Solo 워크스페이스를 에이전트 팀으로 바꾸는 도구.
 *
 * 왜 에이전트가 스스로 바꾸게 두는가: 모드는 워크스페이스를 **만들 때** 정해지는데, "이건 둘로
 * 나눠서 Codex 랑 같이 해 줘" 는 대화 도중에 나온다. 그 순간 Solo 워크스페이스의 모델에게는
 * 위임 도구가 아예 없고(delegateBackendsFor 가 빈 배열이면 도구가 생성되지 않는다), 모델은
 * "할 수 없다" 고 답하거나 자기 네이티브 서브에이전트로 얼버무린다 — 사용자가 요청한 것과
 * 다른 일이 조용히 일어난다. 켜는 길을 도구로 열어 두면 그 요청을 사실대로 처리할 수 있다.
 *
 * **한 방향뿐이다.** 끄는 쪽은 만들지 않았다. 켜는 것은 사용자가 방금 말로 요청한 일이지만,
 * 끄는 것은 아무도 요청하지 않았는데 모델이 자기 판단으로 능력을 줄이는 일이고, 위임이 도는
 * 중에 꺼지면 무슨 일이 일어나는지도 분명하지 않다. Solo 로 돌아가는 것은 헤더의 토글로
 * 사람이 한다(ChatView).
 */

export const switchToAgentTeam: AgentToolHandler = async (deps, workspaceId) => {
  const ws = callerWorkspace(workspaceId)

  // 거절 조건은 delegateBackendsFor 와 **같은 판단**을 쓴다([[agent/multiAgent]]). 여기서 조건을
  // 새로 발명하면 "켰다고 하는데 도구는 안 생기는" 상태를 만들 수 있다 — 모드를 켠 뒤 위임
  // 도구가 없는 것만큼 모델이 고치기 어려운 실패는 없다. 문장만 여기서 고른다.
  if (!canLeadAgentTeam(ws)) {
    const label = AGENT_BACKEND_LABELS[ws.agentBackend] ?? ws.agentBackend
    throw new Error(
      `${label} cannot lead an agent team in Wooi — there is no way to attach the teammate ` +
        'tools to its session, so the mode would change nothing.'
    )
  }

  // 이미 켜져 있다면 실패가 아니다. 도구 오류로 만들면 모델이 자기가 뭘 잘못했다고 읽고 다른
  // 길을 찾아 헤매는데, 사실은 원하던 상태가 이미 참이다. 다만 **세션을 다시 열지는 않는다** —
  // 켜진 채로 열린 세션에는 위임 도구가 이미 있으므로 재시작은 값 없이 대화만 끊는 일이 된다.
  if (ws.multiAgent) {
    return {
      mode: 'team',
      alreadyOn: true,
      teammateTools: delegateBackendsFor(ws).map(delegateToolName),
      note: 'This workspace was already an agent team, so nothing changed.'
    }
  }

  getStore().update((st) => {
    const target = st.workspaces.find((w) => w.id === workspaceId)
    if (target) target.multiAgent = true
  })

  // 위임 도구는 세션을 **열 때** 그 세션에 박힌다(claude/host.ts 의 ensure, codex/thread.ts 의
  // openThread). 그래서 플래그만 바꾸면 지금 도는 세션에는 영원히 도구가 없다. 다음 전송에서
  // 세션을 다시 열도록 예약해 둔다 — 지금 끊으면 이 호출을 낸 턴이 결과도 못 받고 죽는다.
  deps.sessions.restartBeforeNextMessage(workspaceId)
  // 헤더 배지가 바로 'Agent team' 으로 바뀌어, 사용자가 승인한 것이 실제로 일어났음을 본다.
  deps.broadcastState()

  const teammateTools = delegateBackendsFor({ ...ws, multiAgent: true }).map(delegateToolName)
  return {
    mode: 'team',
    teammateTools,
    // 이 문장이 이 도구 결과의 핵심이다. 도구가 생기는 시점을 정확히 적어 두지 않으면 모델은
    // 곧바로 위임을 시도하고, 없는 도구를 부르며 자기가 뭘 잘못했는지 찾는 데 턴을 쓴다.
    next:
      'The teammate tools are not in this session yet — Wooi reopens the session on the next ' +
      'message to load them, and this conversation carries over. Finish this turn now: tell the ' +
      'user the workspace is an agent team, say what you plan to delegate to whom, and ask them ' +
      'to reply so you can start. Delegate from that turn on.'
  }
}
