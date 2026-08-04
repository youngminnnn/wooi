import { isWorktreeClean } from '../../git'
import { getStore } from '../../store'
import { createWorkspace } from '../../workspaces'
import type { AgentToolHandler } from './registry'

/**
 * 에이전트가 자기 작업 위에 stacked 워크스페이스를 직접 쌓는다.
 *
 * 부모는 **호출한 워크스페이스 자신**이다 — 인자로 받지 않으므로 모델이 남의 스택에 끼어들 수
 * 없고, 그게 정확히 스택의 의미이기도 하다("지금 이 작업 위에 다음을 쌓는다").
 */
export const createStackedWorkspace: AgentToolHandler = async (deps, workspaceId, args) => {
  const ws = getStore()
    .getState()
    .workspaces.find((w) => w.id === workspaceId)
  if (!ws) throw new Error('This workspace no longer exists.')
  if (ws.archived) throw new Error('This workspace is archived — you cannot stack on top of it.')

  // 새 브랜치는 부모의 **커밋된 tip** 에서 갈라진다. 미커밋 변경을 들고 쌓으면 그 변경이 새
  // 워크스페이스에 따라오지 않는데 에러는 나지 않는다 — 조용히 어긋난 스택이 만들어진다.
  // 경고로 넘기지 않고 막는 이유: 커밋하고 다시 부르는 것은 에이전트에게 전혀 어렵지 않다.
  if (!(await isWorktreeClean(ws.worktreePath))) {
    throw new Error(
      'This worktree has uncommitted changes. The new workspace would fork from the last commit ' +
        'and silently leave them behind. Commit them first, then call this again.'
    )
  }

  const name = typeof args.name === 'string' ? args.name.trim() : ''
  const result = await createWorkspace(deps, {
    repoId: ws.repoId,
    parentWorkspaceId: ws.id,
    ...(name ? { name } : {})
  })
  if (result.error) throw new Error(result.error)

  // 전달 실패는 생성을 막지 않지만 조용히 넘기면 안 된다 — 새 워크스페이스의 에이전트가
  // 프로젝트 지침(CLAUDE.local.md 등)을 못 읽은 채 다르게 동작한다.
  const carryFailures = (result.carryFailures ?? []).map((f) => `${f.path}: ${f.reason}`)

  return {
    workspaceId: result.workspaceId,
    branch: result.branch,
    baseBranch: ws.branch,
    ...(carryFailures.length ? { carryFailures } : {})
  }
}
