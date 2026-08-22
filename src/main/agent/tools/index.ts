import { switchToAgentTeam } from './agentTeam'
import { awaitStackedWork } from './awaitStackedWork'
import {
  listWorkspacePeers,
  listWorkspacePeersExternal,
  sendToWorkspace,
  sendToWorkspaceExternal
} from './peer'
import { openPullRequest } from './pullRequest'
import { checkRelatedWork } from './relatedWork'
import {
  initRegistry,
  registerAgentTool,
  registerExternalAgentTool,
  type AgentToolDeps
} from './registry'
import { readScriptOutput, runScript, stopScript } from './script'
import {
  checkStackedWork,
  createStackedWorkspace,
  notifyChild,
  reportToParent
} from './stackedWorkspace'
import { runDelegateTool } from './subagent'
import { archiveWorkspaceTool, createIndependentWorkspace, listRepositories } from './workspace'
import { delegateToolName } from './catalog'
import { listIssues } from './issues'
import { AGENT_BACKEND_IDS } from '@shared/types'

export { runAgentTool, type AgentToolDeps, type AgentToolHandler } from './registry'

/**
 * 도구를 실행부에 붙이고 의존성을 주입한다. 메인 부팅 시 한 번 부른다(index.ts).
 *
 * 등록을 import 부작용이 아니라 여기 목록으로 두는 이유: 부작용 등록은 "아무도 import 하지
 * 않아 조용히 사라진 도구" 를 만든다. 카탈로그([[agent/tools/catalog]])에 정의가 있는데 실행부가
 * 없으면 모델은 도구를 보고 부르는데 매번 실패하므로, 대응 관계는 눈에 보여야 한다.
 */
export function initAgentTools(deps: AgentToolDeps): void {
  initRegistry(deps)
  registerAgentTool('create_stacked_workspace', createStackedWorkspace)
  registerAgentTool('report_to_parent', reportToParent)
  registerAgentTool('notify_child', notifyChild)
  registerAgentTool('check_stacked_work', checkStackedWork)
  // 위임 도구는 백엔드마다 하나다. 카탈로그도 같은 이름을 같은 규칙으로 만들므로(delegateToolName)
  // 백엔드가 늘면 정의와 실행부가 함께 늘어난다.
  for (const backend of AGENT_BACKEND_IDS) {
    registerAgentTool(delegateToolName(backend), runDelegateTool(backend))
  }
  registerAgentTool('open_pull_request', openPullRequest)
  registerAgentTool('run_script', runScript)
  registerAgentTool('stop_script', stopScript)
  registerAgentTool('read_script_output', readScriptOutput)
  registerAgentTool('check_related_work', checkRelatedWork)
  registerAgentTool('list_workspace_peers', listWorkspacePeers)
  registerAgentTool('send_to_workspace', sendToWorkspace)
  registerExternalAgentTool('list_workspace_peers', listWorkspacePeersExternal)
  registerExternalAgentTool('send_to_workspace', sendToWorkspaceExternal)
  registerAgentTool('list_issues', listIssues)
  registerAgentTool('list_repositories', listRepositories)
  registerAgentTool('create_workspace', createIndependentWorkspace)
  registerAgentTool('archive_workspace', archiveWorkspaceTool)
  registerAgentTool('switch_to_agent_team', switchToAgentTeam)
  registerAgentTool('await_stacked_work', awaitStackedWork)
}
