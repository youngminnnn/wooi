import { AGENT_BACKEND_LABELS } from '@shared/types'
import { getStore } from '../../store'
import { canLeadAgentTeam, delegateBackendsFor } from '../multiAgent'
import { delegateToolName } from './catalog'
import type { AgentToolHandler } from './registry'
import { callerWorkspace } from './target'

/**
 * Solo 워크스페이스를 에이전트 팀으로 바꾸는 도구.
 *
 * 왜 에이전트가 스스로 바꾸게 두는가: 새 워크스페이스는 **언제나 Solo** 이고 켜는 UI 는 어디에도
 * 없다. "이건 둘로 나눠서 Codex 랑 같이 해 줘" 는 대화 도중에 나오는데, 그 순간 Solo 워크스페이스의
 * 모델에게는 위임 도구가 아예 없고(delegateBackendsFor 가 빈 배열이면 도구가 생성되지 않는다),
 * 모델은 "할 수 없다" 고 답하거나 자기 네이티브 서브에이전트로 얼버무린다 — 사용자가 요청한 것과
 * 다른 일이 조용히 일어난다. 그래서 이 도구가 **켜는 유일한 길**이다. 사용자에게 어딘가를 눌러
 * 달라고 답하는 것은 답이 될 수 없다. 누를 곳이 없기 때문이다.
 *
 * **한 방향뿐이다.** 끄는 쪽은 만들지 않았다. 켜는 것은 사용자가 방금 말로 요청한 일이지만,
 * 끄는 것은 아무도 요청하지 않았는데 모델이 자기 판단으로 능력을 줄이는 일이고, 위임이 도는
 * 중에 꺼지면 무슨 일이 일어나는지도 분명하지 않다. Solo 로 돌아가는 것은 헤더 배지로 사람이
 * 한다(ChatView) — 화면에 남은 단 하나의 스위치이고, 그것도 끄는 쪽뿐이다.
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
  // openThread). 그래서 플래그만 바꾸면 지금 도는 세션에는 영원히 도구가 없다. 지금 끊으면 이
  // 호출을 낸 턴이 결과도 못 받고 죽으므로, 이 턴이 **끝나는 즉시** 다시 열고 이어 가게 한다.
  //
  // 사용자의 다음 메시지를 기다리지 않는 이유가 이 도구의 전부다. 여기까지 온 이유는 사용자가
  // 방금 "Codex 한테 리뷰 시켜줘" 라고 말했기 때문인데, 거기서 멈추고 "이제 다시 말해 주세요" 로
  // 끝내면 사용자가 시킨 일은 시작도 못 한 채 턴 하나가 지나간다. 이어지는 턴은 사용자가
  // 시작시키지 않았을 뿐, 사용자가 시작시킨 작업이다([[agent/orchestrator]] resumeAfterTurn).
  deps.sessions.resumeAfterTurn(workspaceId, RESUME_PROMPT)
  // 헤더 배지가 바로 'Agent team' 으로 바뀌어, 사용자가 승인한 것이 실제로 일어났음을 본다.
  deps.broadcastState()

  const teammateTools = delegateBackendsFor({ ...ws, multiAgent: true }).map(delegateToolName)
  return {
    mode: 'team',
    teammateTools,
    // 이 문장이 이 도구 결과의 핵심이다. 도구가 생기는 시점을 정확히 적어 두지 않으면 모델은
    // 곧바로 위임을 시도하고, 없는 도구를 부르며 자기가 뭘 잘못했는지 찾는 데 턴을 쓴다.
    // "기다려라" 라고 적지 않는 것도 그만큼 중요하다 — 그렇게 적으면 다음 턴이 저절로 시작되는데
    // 모델은 사용자 대답을 요청해 둔 상태라, 자기가 물어본 것에 자기가 답하는 꼴이 된다.
    next:
      'The teammate tools are not in this session yet — Wooi reopens the session the moment this ' +
      'turn ends and then continues on its own, with this conversation carried over. So end this ' +
      'turn now in a line or two: say the workspace is an agent team and what you are about to ' +
      'delegate to whom. Do not ask the user to reply — the next turn starts by itself, and that ' +
      'is where you delegate.'
  }
}

/**
 * 팀이 된 뒤 이어지는 턴에 Wooi 가 넣는 말.
 *
 * **화면에는 한 글자도 남지 않는다**([[agent/orchestrator]] resumeAfterTurn 이 silent 로 보낸다).
 * 사용자가 치지도 않은 문장이 자기 말풍선으로 대화에 쌓이면 안 되기 때문이다 — 사용자가 보는 것은
 * 자기 요청에 이어 에이전트가 계속 일하는 모습뿐이어야 한다.
 *
 * 문장이 하는 일은 두 가지다. 하나는 이 턴을 **누가** 시작했는지 밝히는 것 — 밝히지 않으면 모델은
 * 사용자가 다시 말을 건 줄 알고 "무엇을 도와드릴까요" 로 답한다. 다른 하나는 이미 한 일을 다시
 * 하지 말라는 것 — 방금 끝난 턴에서 계획을 말해 뒀으므로 그 계획을 실행할 차례다.
 */
const RESUME_PROMPT =
  'Wooi reopened this session so the teammate tools are loaded; they are available to you now. ' +
  'Wooi started this turn, not the user — it continues the request the user made just before ' +
  'your last turn, which is why you switched this workspace to an agent team. This message is ' +
  'not shown to the user, so do not refer to it. Carry out the delegation you just described. ' +
  'Do not plan it again, do not repeat work that is already done, and do not ask the user to ' +
  'confirm — they already asked for this.'
