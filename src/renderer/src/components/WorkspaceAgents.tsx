import { ChevronDown, ChevronRight } from 'lucide-react'
import { useStore } from '../store'
import { formatDuration } from '../lib/format'
import { AgentBackendMark } from './BrandIcons'
import { AGENT_BACKEND_LABELS } from '@shared/types'
import type { AgentBackendId } from '@shared/types'

/**
 * 사이드바에서 워크스페이스 행 **바로 아래**에 붙는, 그 워크트리에서 지금 돌고 있는 서브에이전트 목록.
 *
 * 워크스페이스 행 안이 아니라 형제로 렌더한다 — 행 자체가 role="button" 인 클릭·드래그 영역이라
 * 그 안에 버튼을 중첩하면 접기 클릭이 워크스페이스 선택으로 새고 드래그 정렬과도 충돌한다.
 *
 * 실행 중인 에이전트가 없으면 아무것도 렌더하지 않는다. 즉 이 블록이 보인다는 것 자체가
 * "이 워크트리에서 무언가 돌고 있다"는 신호다.
 */
export function WorkspaceAgents({
  workspaceId,
  /** 부모 워크스페이스 행의 stack 들여쓰기 깊이. 행과 같은 기준선에서 한 단계 더 들여쓴다. */
  depth,
  /**
   * 이 워크트리를 구동하는 에이전트 백엔드. 네이티브 서브에이전트(Claude 의 Task · Codex 의
   * collab)는 정의상 부모와 같은 백엔드라 이 값이 곧 그 행의 백엔드다.
   *
   * 위임(delegate)으로 띄운 교차 백엔드 실행만 `RunningAgent.backend` 를 따로 싣고, 그때는
   * 그 값이 이 기본값을 이긴다 — 그래야 "Claude 워크스페이스인데 Codex 가 돌고 있다"가 보인다.
   */
  backend,
  now
}: {
  workspaceId: string
  depth: number
  backend: AgentBackendId
  now: number
}): React.JSX.Element | null {
  const agents = useStore((s) => s.runningAgents[workspaceId])
  const collapsed = useStore((s) => s.agentsCollapsed[workspaceId] ?? false)
  const toggle = useStore((s) => s.toggleAgentsCollapsed)
  // 설정이 로드되기 전(app === null)에는 켜진 것으로 본다 — 기본값이 켜짐이므로 첫 프레임에
  // 목록이 깜빡이며 사라지는 일이 없다.
  const enabled = useStore((s) => s.app?.settings.showRunningAgents ?? true)

  // 표시만 끈다 — main 은 계속 추적하므로 다시 켜면 지금 돌고 있는 것이 바로 나타난다.
  if (!enabled) return null
  if (!agents || agents.length === 0) return null

  // 오래 돌고 있는 것이 위로 — 멈춘 것이 눈에 먼저 띄어야 한다.
  const rows = [...agents].sort((a, b) => a.startedAt - b.startedAt)
  // 접었을 때도 "몇 개가 얼마나 돌고 있나"는 남긴다 — 접기가 정보를 감추기만 하면
  // 접어 둔 채로 잊어버리게 된다.
  const oldest = rows[0]
  // 워크스페이스 행은 paddingLeft: 12 + depth*14 에 StatusDot(8px)+gap(8px) 이 앞에 온다.
  // 에이전트 행을 그 이름 텍스트와 같은 기준선에 맞춰 하위 항목으로 읽히게 한다.
  const indent = 12 + depth * 14 + 16

  return (
    <div className="space-y-0.5">
      <button
        onClick={() => toggle(workspaceId)}
        style={{ paddingLeft: indent }}
        className="w-full flex items-center gap-1 pr-2 py-0.5 rounded-md text-xs text-neutral-500 hover:bg-[var(--surface)] hover:text-neutral-300 transition-colors"
        title={collapsed ? 'Show running agents' : 'Hide running agents'}
      >
        {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
        <span className="flex-1 text-left">
          {rows.length} agent{rows.length > 1 ? 's' : ''}
        </span>
        {collapsed && (
          <span className="tabular-nums text-neutral-600">
            {formatDuration(now - oldest.startedAt)}
          </span>
        )}
      </button>

      {!collapsed &&
        rows.map((agent) => {
          // 위임 실행은 자기 백엔드를 싣고 오고, 네이티브 서브에이전트는 부모의 것을 따른다.
          const agentBackend = agent.backend ?? backend
          return (
            <div
              key={agent.taskId}
              style={{ paddingLeft: indent + 12 }}
              className="flex items-baseline gap-1.5 pr-2 py-0.5 text-xs"
              title={[
                `${agent.agentType} · ${AGENT_BACKEND_LABELS[agentBackend]}`,
                agent.description,
                agent.lastToolName ? `Last tool: ${agent.lastToolName}` : null,
                typeof agent.toolUses === 'number' ? `${agent.toolUses} tool uses` : null,
                typeof agent.totalTokens === 'number'
                  ? `${agent.totalTokens.toLocaleString()} tokens`
                  : null
              ]
                .filter(Boolean)
                .join('\n')}
            >
              {/* 좌측 마크가 "어떤 에이전트로 돌고 있나"(Claude Code / Codex)를, 옆 텍스트가
                "어떤 서브에이전트인가"(Explore 등)를 나타낸다 — 두 축이 겹치지 않는다. */}
              <span className="shrink-0 translate-y-0.5">
                <AgentBackendMark backend={agentBackend} size={14} />
              </span>
              <span className="shrink-0 font-medium text-neutral-400">{agent.agentType}</span>
              {/* 설명은 남는 폭만 차지하고 먼저 잘린다 — 타입·경과 시간이 항상 읽히는 쪽이 유용하다. */}
              <span className="min-w-0 flex-1 truncate text-neutral-600">
                {agent.lastToolName ? `${agent.lastToolName} · ` : ''}
                {agent.description}
              </span>
              <span className="shrink-0 tabular-nums text-neutral-600">
                {formatDuration(now - agent.startedAt)}
              </span>
            </div>
          )
        })}
    </div>
  )
}
