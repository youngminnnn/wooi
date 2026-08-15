import { workspaceDisplayName } from '@shared/types'
import { isWorktreeClean } from '../../git'
import { getStore } from '../../store'
import { archiveWorkspace, createWorkspace } from '../../workspaces'
import { resolveRequestedAgentOptions } from './agentOptions'
import type { AgentToolHandler } from './registry'
import { callerWorkspace, resolveTargetWorkspace } from './target'

/**
 * 스택에 얽히지 않는 워크스페이스 조작 — 독립 생성과 아카이브.
 *
 * create_stacked_workspace 와 나란히 두지 않고 파일을 가른 이유는 **전제가 다르기 때문**이다.
 * 스택은 부모의 커밋된 tip 에서 갈라지므로 워크트리가 clean 이어야 하지만, 여기 만드는 것은
 * `origin/<default>` 에서 갈라지므로 부모가 무엇을 들고 있든 상관이 없다. 한 파일에 두면
 * 그 차이가 조건문 하나로 보이고, 언젠가 "일관성" 이라는 이름으로 지워진다.
 *
 * 스택을 별도 도구로 남긴 이유도 같다. 기존 도구에 불린 플래그를 붙이면 이름이 거짓말을 하고,
 * 무엇보다 위의 clean 전제가 플래그 값에 따라 켜졌다 꺼졌다 하게 된다.
 */

/**
 * 독립 워크스페이스에 넘기는 최초 메시지.
 *
 * 스택의 handoffMessage([[agent/tools/stackedWorkspace]])와 두 군데가 다르고, 둘 다 의도한 것이다.
 *
 * 하나 — "부모 브랜치를 향한다" 는 문장을 뺐다. 여기서는 거짓이다.
 *
 * 둘 — **report_to_parent 안내를 뺐다.** 이 워크스페이스는 parentWorkspaceId 가 null 이라
 * (workspaces.ts 의 createWorkspace) 그 도구가 항상 "보고할 부모가 없다" 로 던진다. 반드시
 * 실패하는 도구를 알려 주는 것은 안내가 아니라 함정이고, 모델은 그 실패를 자기 잘못으로 읽고
 * 되풀이한다. 독립 워크스페이스에서 결과가 돌아갈 곳은 사용자뿐이므로 그렇게 적는다.
 */
function startMessage(task: string, baseBranch: string): string {
  return [
    task,
    '',
    '---',
    `This workspace was created by Wooi as a fresh branch off \`${baseBranch}\`, so its pull ` +
      'request targets that branch. It is deliberately independent: it does not build on the ' +
      'workspace that started you, and it must not wait for one.',
    'Nothing crosses between workspaces on its own, and there is no workspace for you to report ' +
      'back to — when you finish or get stuck, say so to the user.'
  ].join('\n')
}

export const createIndependentWorkspace: AgentToolHandler = async (deps, workspaceId, args) => {
  const ws = callerWorkspace(workspaceId)
  const repo = getStore()
    .getState()
    .repos.find((r) => r.id === ws.repoId)
  if (!repo) throw new Error('This workspace’s repository is no longer registered with Wooi.')

  // clean 검사를 **하지 않는다**. 새 브랜치는 이 워크트리가 아니라 `origin/<default>` 에서
  // 갈라지므로, 여기 미커밋 변경이 있든 없든 새 워크스페이스는 정확히 같은 것을 받는다.
  // 스택에서 clean 을 요구하는 것은 조용히 어긋난 스택을 막기 위함인데, 그 사고가 여기엔 없다.
  const name = typeof args.name === 'string' ? args.name.trim() : ''
  // 에이전트·모델·effort 는 여기서 검증하고 넘긴다 — 잘못된 값을 그대로 저장하면 사고는 새
  // 워크스페이스의 첫 턴에서 터진다([[agent/tools/agentOptions]]). 부모는 없다(독립이다).
  const agentOptions = await resolveRequestedAgentOptions(deps, args, null)
  const result = await createWorkspace(deps, {
    repoId: ws.repoId,
    // parentWorkspaceId 를 넘기지 않는 것이 이 도구의 전부다 — createWorkspace 는 그러면
    // repo.defaultBranch 에서 갈라진다. 능력은 이미 있었고 노출만 안 돼 있었다.
    //
    // 대신 생성자는 남긴다. 부모가 없어도 "내가 만든 것" 이라는 사실은 남아야, 나중에 이
    // 워크스페이스를 아카이브할 수 있다([[agent/tools/target]]).
    createdByWorkspaceId: ws.id,
    ...agentOptions,
    ...(name ? { name } : {})
  })
  if (result.error) throw new Error(result.error)
  const newId = result.workspaceId
  if (!newId) throw new Error('The workspace was created but Wooi lost track of it.')

  // 작업을 넘기면 새 워크스페이스는 **즉시 돌기 시작한다**. 사용자는 방금 이 도구 호출을
  // 승인하면서 그 작업 문장까지 카드에서 봤으므로, 여기서 다시 묻지 않는다.
  const task = typeof args.task === 'string' ? args.task.trim() : ''
  if (task) deps.sendMessage(newId, startMessage(task, repo.defaultBranch))

  // 전달 실패는 생성을 막지 않지만 조용히 넘기면 안 된다 — 새 워크스페이스의 에이전트가
  // 프로젝트 지침(CLAUDE.local.md 등)을 못 읽은 채 다르게 동작한다.
  const carryFailures = (result.carryFailures ?? []).map((f) => `${f.path}: ${f.reason}`)

  return {
    workspaceId: newId,
    branch: result.branch,
    baseBranch: repo.defaultBranch,
    started: !!task,
    // 스택과 달리 check_stacked_work 로 이 워크스페이스를 들여다볼 수 없다(부모가 아니다).
    // 그 사실을 여기서 말해 두지 않으면, 모델은 오지 않을 보고를 기다리게 된다.
    next:
      'This workspace is not stacked on yours, so it will not report back and does not appear in ' +
      '`check_stacked_work`. Tell the user it is ready and what it is for.',
    ...(task
      ? {}
      : {
          note: 'No task was handed over, so the new workspace is idle until someone prompts it.'
        }),
    ...(carryFailures.length ? { carryFailures } : {})
  }
}

export const archiveWorkspaceTool: AgentToolHandler = async (deps, workspaceId, args) => {
  // 자기 자신은 무조건 거부한다. 아카이브의 첫 걸음이 sessions.dispose 라, 이 호출을 낸 세션이
  // 이 호출에 의해 죽는다 — 도구 결과가 돌아갈 곳이 없고, 에이전트는 지워지는 워크트리 안에서
  // 돌고 있다. 실패해도 실패를 알릴 수 없는 유일한 도구가 되므로 대상 검증보다 먼저 막는다.
  const requested = typeof args.workspaceId === 'string' ? args.workspaceId.trim() : ''
  if (requested === workspaceId) {
    throw new Error(
      'You cannot archive the workspace you are running in: archiving ends this session and ' +
        'deletes the worktree you are working in, so this call could never report back. Ask the ' +
        'user to archive it from the sidebar.'
    )
  }

  const target = resolveTargetWorkspace(workspaceId, requested)

  // 미커밋 변경이 있으면 거부한다. removeWorktree 는 `git worktree remove --force` 를 쓰므로
  // ([[git]]) 커밋 안 된 변경이 경고 없이 사라지고, 언아카이브로 되살아나는 것은 커밋된 것뿐이다.
  // "되돌릴 수 있다" 가 이 도구를 안전하게 만드는 근거인데, dirty 워크트리에서는 그 근거가 없다.
  if (!(await isWorktreeClean(target.worktreePath))) {
    throw new Error(
      `${workspaceDisplayName(target)} has uncommitted changes, and archiving would delete them ` +
        'for good — only committed work comes back. Have it commit them first.'
    )
  }

  // 이름은 아카이브 **전에** 잡는다. archiveWorkspace 가 표시 이름을 스냅샷해 덮어쓸 수 있다.
  const name = workspaceDisplayName(target)
  const { archiveScriptFailure } = await archiveWorkspace(deps, target.id)

  return {
    archived: { workspaceId: target.id, name, branch: target.branch },
    note:
      'The worktree is gone, but the branch, its pull request and the conversation are kept — ' +
      'the user can restore it from the sidebar.',
    // 스크립트 실패는 아카이브를 막지 않지만(worktree 는 이미 사라졌다) 정리가 안 끝났다는 뜻이라
    // 에이전트에게도 알린다 — 사용자에게는 렌더러가 토스트로 따로 알린다.
    ...(archiveScriptFailure
      ? {
          archiveScriptFailed: {
            command: archiveScriptFailure.command,
            code: archiveScriptFailure.code,
            timedOut: archiveScriptFailure.timedOut,
            output: archiveScriptFailure.output,
            note: "The repository's archive script did not succeed, so leftover containers or processes may remain."
          }
        }
      : {})
  }
}
