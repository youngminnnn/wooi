import { normalizeWorkspaceName, workspaceDisplayName } from '@shared/types'
import type { Repo } from '@shared/types'
import { isWorktreeClean } from '../../git'
import { getStore } from '../../store'
import { archiveWorkspace, createWorkspace } from '../../workspaces'
import { resolveRequestedAgentOptions } from './agentOptions'
import type { AgentToolHandler } from './registry'
import { callerWorkspace, resolveTargetRepo, resolveTargetWorkspace } from './target'

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
 *
 * 리포 목록(list_repositories)도 여기 있다. 조회 도구지만 존재 이유가 생성 하나뿐이라서다 —
 * create_workspace 의 `repo` 에 무엇을 적을 수 있는지 알려 주는 것이 전부고, 그 답을 만드는
 * 규칙(이름·경로·중복)은 [[agent/tools/target]] 의 해석과 짝을 이뤄야 한다.
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
function startMessage(task: string, baseBranch: string, otherRepo: Repo | null): string {
  return [
    task,
    '',
    '---',
    `This workspace was created by Wooi as a fresh branch off \`${baseBranch}\`, so its pull ` +
      'request targets that branch. It is deliberately independent: it does not build on the ' +
      'workspace that started you, and it must not wait for one.',
    // 다른 리포에 만들어졌으면 그 사실이 첫 줄에 있어야 한다. 인계문을 쓴 모델은 자기 리포를
    // 보며 썼으므로 위의 task 에 적힌 경로가 여기에는 없을 수 있고, 그 어긋남은 에러가 아니라
    // "왜 파일이 없지" 로 시작하는 몇 턴이 된다.
    ...(otherRepo
      ? [
          `It is in the \`${otherRepo.name}\` repository — not the one the workspace that asked ` +
            'for it works in. Nothing from that checkout is here, so check any path in the task ' +
            'above against this repository before trusting it.'
        ]
      : []),
    'Nothing crosses between workspaces on its own, and there is no workspace for you to report ' +
      'back to — when you finish or get stuck, say so to the user.'
  ].join('\n')
}

export const createIndependentWorkspace: AgentToolHandler = async (deps, workspaceId, args) => {
  const ws = callerWorkspace(workspaceId)
  // 리포는 **여기가 기본이되 여기로 고정은 아니다**([[agent/tools/target]] lookupTargetRepo).
  // 스택과 갈리는 두 번째 지점이다 — 스택은 부모 브랜치 위에 쌓이므로 같은 리포일 수밖에 없지만,
  // 독립 워크스페이스는 `origin/<default>` 에서 갈라질 뿐이라 어느 리포든 성립한다. 사용자가
  // Wooi 에 등록해 둔 리포라는 것이 경계이고, 어느 리포인지는 승인 카드에 적힌다.
  const repo = resolveTargetRepo(ws, args.repo)
  const otherRepo = repo.id === ws.repoId ? null : repo

  // clean 검사를 **하지 않는다**. 새 브랜치는 이 워크트리가 아니라 `origin/<default>` 에서
  // 갈라지므로, 여기 미커밋 변경이 있든 없든 새 워크스페이스는 정확히 같은 것을 받는다.
  // 스택에서 clean 을 요구하는 것은 조용히 어긋난 스택을 막기 위함인데, 그 사고가 여기엔 없다.
  const pullRequestNumber =
    typeof args.pullRequestNumber === 'number' ? args.pullRequestNumber : undefined
  if (pullRequestNumber !== undefined && args.parentWorkspaceId !== undefined) {
    throw new Error(
      'A workspace cannot be stacked on a parent branch and checked out at a pull request head.'
    )
  }
  const name =
    pullRequestNumber === undefined && typeof args.name === 'string' ? args.name.trim() : ''
  // 에이전트·모델·effort 는 여기서 검증하고 넘긴다 — 잘못된 값을 그대로 저장하면 사고는 새
  // 워크스페이스의 첫 턴에서 터진다([[agent/tools/agentOptions]]). 부모는 없다(독립이다).
  const agentOptions = await resolveRequestedAgentOptions(deps, args, null)
  const result = await createWorkspace(deps, {
    repoId: repo.id,
    // parentWorkspaceId 를 넘기지 않는 것이 이 도구의 전부다 — createWorkspace 는 그러면
    // repo.defaultBranch 에서 갈라진다. 능력은 이미 있었고 노출만 안 돼 있었다.
    //
    // 대신 생성자는 남긴다. 부모가 없어도 "내가 만든 것" 이라는 사실은 남아야, 나중에 이
    // 워크스페이스를 아카이브할 수 있다([[agent/tools/target]]).
    createdByWorkspaceId: ws.id,
    ...agentOptions,
    ...(pullRequestNumber !== undefined ? { fromPrNumber: pullRequestNumber } : {}),
    ...(name ? { name } : {})
  })
  if (result.error) throw new Error(result.error)
  if (result.existingWorkspaceId) {
    return {
      workspaceId: result.existingWorkspaceId,
      existing: true,
      archived: result.existingWorkspaceArchived ?? false,
      note: result.existingWorkspaceArchived
        ? `That pull request already has archived workspace ${result.existingWorkspaceId}. Restore it to continue.`
        : `That pull request already has workspace ${result.existingWorkspaceId}. Open it to continue.`
    }
  }
  const newId = result.workspaceId
  if (!newId) throw new Error('The workspace was created but Wooi lost track of it.')

  // 작업을 넘기면 새 워크스페이스는 **즉시 돌기 시작한다**. 사용자는 방금 이 도구 호출을
  // 승인하면서 그 작업 문장까지 카드에서 봤으므로, 여기서 다시 묻지 않는다.
  const task = typeof args.task === 'string' ? args.task.trim() : ''
  if (task) deps.sendMessage(newId, startMessage(task, repo.defaultBranch, otherRepo))

  // 전달 실패는 생성을 막지 않지만 조용히 넘기면 안 된다 — 새 워크스페이스의 에이전트가
  // 프로젝트 지침(CLAUDE.local.md 등)을 못 읽은 채 다르게 동작한다.
  const carryFailures = (result.carryFailures ?? []).map((f) => `${f.path}: ${f.reason}`)
  // 원본이 없어 건너뛴 항목은 실패가 아니지만, 이 경로에는 사용자에게 띄울 토스트가 없다
  // (도구 결과가 곧 유일한 출구다). 등록해 둔 파일이 아무 일도 하지 않았다는 사실은 전한다.
  const carryMissing = result.carryMissing ?? []

  return {
    workspaceId: newId,
    branch: result.branch,
    baseBranch: repo.defaultBranch,
    // 다른 리포에 만들었을 때만 싣는다. 같은 리포는 말할 것이 없고, 다른 리포는 모델이 그 뒤에
    // 쓰는 문장(사용자에게 무엇이 준비됐는지 알리는 말)이 어느 코드베이스인지 밝혀야 한다.
    ...(otherRepo ? { repo: otherRepo.name } : {}),
    started: !!task,
    // 스택과 달리 check_stacked_work 로 이 워크스페이스를 들여다볼 수 없다(부모가 아니다).
    // 그 사실을 여기서 말해 두지 않으면, 모델은 오지 않을 보고를 기다리게 된다.
    next:
      'This workspace is not stacked on yours, so it will not report back and does not appear in ' +
      '`check_stacked_work`. Use `set_workspace_name` if you need to rename it. Tell the user it ' +
      'is ready and what it is for.',
    ...(task
      ? {}
      : {
          note: 'No task was handed over, so the new workspace is idle until someone prompts it.'
        }),
    ...(carryFailures.length ? { carryFailures } : {}),
    ...(carryMissing.length
      ? {
          carryMissing:
            `Listed in this repo's workspace files but missing from the main checkout, ` +
            `so nothing was carried: ${carryMissing.join(', ')}.`
        }
      : {})
  }
}

/**
 * `create_workspace` 의 `repo` 에 적을 수 있는 값 전부.
 *
 * 이 도구가 없으면 다른 리포에 만드는 길은 사실상 닫혀 있다. 모델이 볼 수 있는 리포 이름은
 * `list_workspace_peers` 가 알려 주는 것 — 즉 **지금 워크스페이스가 열려 있는** 리포뿐이라,
 * 등록만 해 두고 아직 아무 작업도 없는 리포는 존재 자체가 보이지 않는다. 그리고 그런 리포야말로
 * "저쪽에서 시작해야 하는 일" 이 생기는 곳이다.
 *
 * 자기 리포도 빼지 않고 `current` 로 표시한다. 목록에서 빠지면 모델은 `repo` 를 생략했을 때
 * 어디에 만들어지는지를 목록과 맞춰 볼 수 없고, 굳이 자기 리포 이름을 적어 넣게 된다.
 *
 * 읽기 전용이라 승인 카드가 없다(catalog 의 readOnlyHint). 사용자가 이미 Wooi 에 추가해 둔
 * 리포의 이름과 경로일 뿐이고, 매번 카드가 뜨면 정작 **생성** 카드가 묻힌다.
 */
export const listRepositories: AgentToolHandler = async (_deps, workspaceId) => {
  const state = getStore().getState()
  const ws = callerWorkspace(workspaceId)

  const open = new Map<string, number>()
  for (const w of state.workspaces) {
    if (w.archived) continue
    open.set(w.repoId, (open.get(w.repoId) ?? 0) + 1)
  }

  // 자기 리포를 맨 위에, 나머지는 이름순. 등록순(addedAt)은 모델에게 아무것도 뜻하지 않는다.
  const repos = [...state.repos].sort((a, b) => {
    if (a.id === ws.repoId) return -1
    if (b.id === ws.repoId) return 1
    return a.name.localeCompare(b.name)
  })

  // 이름이 겹치는 리포는 이름만으로 지목할 수 없다([[agent/tools/target]] lookupTargetRepo).
  // 그 사실을 목록에서 미리 말해 주지 않으면, 모델은 반드시 한 번 거절당하고 나서야 안다.
  const counts = new Map<string, number>()
  for (const r of repos) {
    const key = r.name.toLowerCase()
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  return {
    repositories: repos.map((r) => ({
      name: r.name,
      path: r.path,
      defaultBranch: r.defaultBranch,
      ...(r.id === ws.repoId ? { current: true } : {}),
      openWorkspaces: open.get(r.id) ?? 0,
      // 겹치는 이름에만 붙는다 — 안 겹치는 쪽까지 경고를 달면 경고가 값을 잃는다.
      ...((counts.get(r.name.toLowerCase()) ?? 0) > 1
        ? { ambiguousName: true, note: 'Another repository has this name — pass `path` instead.' }
        : {})
    })),
    next:
      'Pass a `name` from this list as `create_workspace`’s `repo` to start work in another ' +
      'repository. Omitting it creates the workspace in the one marked `current`.'
  }
}

export const setWorkspaceName: AgentToolHandler = async (deps, workspaceId, args) => {
  const requested = typeof args.workspaceId === 'string' ? args.workspaceId.trim() : ''
  // 자기 자신은 이미 존재하고 아카이브되지 않았으며, 지금 도는 턴도 바로 자기 턴이다. 그래서
  // [[agent/tools/target]] 의 네 가지 대상 검사는 적용할 사고가 없고 callerWorkspace 만 확인한다.
  const target =
    !requested || requested === workspaceId
      ? callerWorkspace(workspaceId)
      : // running 가드는 턴을 **죽이는** 도구를 막는다. 이름 변경은 notify_child 처럼 턴을
        // 건드리지 않으므로 도는 중인 자식도 안전하다([[agent/tools/target]]).
        resolveTargetWorkspace(workspaceId, requested, { allowRunning: true })

  const rawName = args.name
  const clearing = typeof rawName === 'string' && rawName.trim() === ''
  const normalized = normalizeWorkspaceName(rawName)
  // 빈 문자열은 사이드바 rename IPC 와 같은 "자동 이름 지우기"다. 하지만 내용이 있었는데 제어
  // 문자·마크다운 잡음만 남은 값은 실수이므로 조용히 clear 로 바꾸지 않는다.
  if (!clearing && normalized === null) {
    throw new Error(
      'The workspace name must contain readable text after markdown and control characters are removed.'
    )
  }
  const autoName = clearing ? null : normalized

  getStore().update((state) => {
    const workspace = state.workspaces.find((w) => w.id === target.id)
    if (!workspace) throw new Error('This workspace no longer exists.')
    workspace.autoName = autoName
  })
  deps.broadcastState()

  // 쓴 뒤의 상태를 다시 읽는다 — 결과에 실을 유효 표시 이름은 방금 쓴 값이 아니라
  // workspaceDisplayName 의 판정이고, target 은 쓰기 이전의 사본이라 그 답을 모른다.
  const updated =
    getStore()
      .getState()
      .workspaces.find((w) => w.id === target.id) ?? target
  return {
    workspaceId: updated.id,
    autoName,
    displayName: workspaceDisplayName(updated),
    // 도구는 사람 이름을 일부러 덮을 수 없다. 이 설명이 없으면 모델은 성공 결과를 보고도 화면이
    // 안 바뀐 이유를 몰라, 사용자에게 보이는 이름까지 바뀌었다고 잘못 보고한다.
    ...(updated.displayName?.trim()
      ? {
          note:
            'A name set by the user is still taking precedence. The user must clear it in the ' +
            'sidebar rename box before this agent-set name will be displayed.'
        }
      : {})
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
