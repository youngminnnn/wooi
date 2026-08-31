import { isAllowedBranchName } from '../../../../scripts/branch-name-rule.mjs'
import { workspaceDisplayName, type Workspace } from '@shared/types'
import {
  proposeBranchRename,
  renameLocalBranch,
  type BranchRenameProposal
} from '../../branchNameFromWork'
import { countCommitsAhead, originHasBranch, pushCurrentBranch } from '../../git'
import { createPr, findOpenPrStatus, listOpenPrs } from '../../github'
import { getStore } from '../../store'
import type { AgentToolHandler } from './registry'

/**
 * 에이전트가 PR 을 여는 통로.
 *
 * 핵심은 **base 를 모델에게 묻지 않는다** 는 것이다. 지금까지 에이전트는 `gh pr create` 를 직접
 * 불렀고 `--base` 를 빠뜨렸다 — PR 이 스택 부모가 아니라 리포 기본 브랜치를 향하고, 앱은 그것을
 * 사후에 감지해 배너로 수습했다([[stack]] 의 detectBaseMismatch). 앱이 이미 아는 값을 앱이 채우면
 * 어긋난 상태가 애초에 만들어지지 않는다.
 */

function workspaceOf(workspaceId: string): Workspace {
  const ws = getStore()
    .getState()
    .workspaces.find((w) => w.id === workspaceId)
  if (!ws) throw new Error('This workspace no longer exists.')
  return ws
}

/**
 * 이 워크스페이스의 PR 이 향해야 할 브랜치.
 *
 * 부모의 `branch` 를 그때그때 읽는다. 워크스페이스의 `baseBranch` 를 쓰지 않는 이유는 그 값이
 * **이미 열린 PR 의 base 로 덮어써지기 때문**이다(ipc.ts 의 PR 동기화). 잘못 열린 PR 이 다음 PR 의
 * base 를 오염시키는 고리를 끊으려면 스택 관계를 원본 그대로 봐야 한다.
 *
 * 승인 카드도 같은 값을 보여 줘야 하므로([[agent/tools/permission]]) export 한다 — 사용자가 카드에서
 * 본 base 와 실제로 열리는 base 가 다르면 승인이 승인이 아니게 된다.
 */
export function resolvePrBase(ws: Workspace): string {
  const state = getStore().getState()
  const parent = ws.parentWorkspaceId
    ? state.workspaces.find((w) => w.id === ws.parentWorkspaceId)
    : null
  if (parent) return parent.branch
  const repo = state.repos.find((r) => r.id === ws.repoId)
  return repo?.defaultBranch || ws.baseBranch
}

/**
 * 개명에 쓸 이름의 출처.
 *
 * 사용자가 직접 고친 이름이 있으면 그것이 이긴다 — 사용자 본인의 말이다. 없으면 에이전트가
 * `set_workspace_name` 으로 정한 이름을 쓴다. `Workspace.name` 은 일부러 보지 않는다. 그것이
 * 바로 지금 바꾸려는 랜덤 이름이라, 그걸로 슬러그를 만들면 `feat/savvy-numbat` 이 된다.
 */
function renameSourceName(ws: Workspace): string | null {
  return ws.displayName?.trim() || ws.autoName?.trim() || null
}

/**
 * 아직 랜덤 이름인 브랜치를 push 로 굳히기 전에 사용자에게 물을 문장.
 *
 * 조용히 바꾸지 않는다. 이름은 사용자 것이므로 에이전트가 제안하고 승인을 받게 한다 — 도구를
 * 한 번 되돌려 보내면 그 확인이 지금 도는 턴 안에서 일어나고, 백엔드(Claude·Codex)와
 * 권한 모드에 상관없이 같은 방식으로 일어난다.
 */
function renamePrompt(proposal: BranchRenameProposal, ws: Workspace): string {
  return (
    `This branch is still \`${proposal.from}\` — the random name Wooi gave the workspace, which ` +
    "this repository's branch name rule rejects. It has not been pushed yet, so the name can " +
    `still be changed. Wooi suggests \`${proposal.to}\`, from this workspace's name ` +
    `(“${workspaceDisplayName(ws)}”). Ask the user whether to use it, then call this tool again ` +
    'with `renameBranch` set to the name they approved — or to an empty string to push ' +
    `\`${proposal.from}\` as it is. Do not rename the branch yourself.`
  )
}

export const openPullRequest: AgentToolHandler = async (deps, workspaceId, args) => {
  const ws = workspaceOf(workspaceId)
  if (ws.archived) {
    throw new Error('This workspace is archived — you cannot open a pull request from it.')
  }

  const title = typeof args.title === 'string' ? args.title.trim() : ''
  if (!title) throw new Error('The title is empty — give the pull request a title.')
  const body = typeof args.body === 'string' ? args.body.trim() : ''
  if (!body) throw new Error('The body is empty — describe what this pull request changes.')
  const draft = args.draft === true
  // 개명하면 아래에서 바뀐다. 결과에 실어 모델이 무엇이 push 됐는지 알게 한다.
  let branch = ws.branch

  // 이미 열려 있으면 새로 만들지 않는다. GitHub 은 한 브랜치에 열린 PR 을 둘 두지 못하므로
  // 그냥 부르면 실패만 반복하는데, 있는 것을 돌려주면 모델이 그 번호로 이어서 일할 수 있다.
  const open = await findOpenPrStatus(ws.worktreePath, ws.repoId, ws.branch)
  if (open) {
    // base 는 상태 조회 결과에 없다. 같은 캐시된 목록을 다시 읽을 뿐이라 gh 호출은 늘지 않는다.
    const row = (await listOpenPrs(ws.worktreePath, ws.repoId)).find((p) => p.head === ws.branch)
    return {
      number: open.number,
      url: open.url,
      base: row?.base ?? '',
      draft: open.state === 'draft',
      note: 'This branch already had an open pull request, so nothing was created.'
    }
  }

  const base = resolvePrBase(ws)
  if (base === ws.branch) {
    throw new Error(
      `Wooi resolved the base branch to \`${base}\`, which is this branch itself — there is ` +
        'nothing to open a pull request against.'
    )
  }

  // 빈 PR 은 리뷰어에게 보낼 것이 없다. 커밋을 잊은 채 도구를 부르는 것이 가장 흔한 실수라
  // gh 의 모호한 실패 대신 무엇을 해야 하는지 문장으로 말해 준다.
  const ahead = await countCommitsAhead(ws.worktreePath, base)
  if (ahead === 0) {
    throw new Error(
      `There is nothing to review — this branch has no commits that \`${base}\` does not ` +
        'already have. Commit your work first, then call this again.'
    )
  }

  const onOrigin = await originHasBranch(ws.worktreePath, ws.branch)

  // push 는 브랜치 이름을 굳히는 자리다. 여기를 지나면 원격에 그 이름이 생기고, 그 뒤에 로컬만
  // 바꾸면 restack 의 force-push 가 엉뚱한 ref 를 겨눈다. 그래서 이름을 고칠 마지막 기회가
  // 바로 여기이고, 작업이 끝난 지금이 그 작업의 이름을 가장 잘 아는 때이기도 하다.
  const proposal = proposeBranchRename({
    branch: ws.branch,
    workspaceName: renameSourceName(ws),
    onOrigin,
    hasBranchStack: (ws.stack?.length ?? 0) > 1
  })
  const answer = typeof args.renameBranch === 'string' ? args.renameBranch.trim() : null
  // 아직 묻지 않았으면 도구를 되돌려 보낸다. 던진 문장은 도구 오류로 모델에게 가므로, 모델이
  // 그것을 읽고 사용자에게 물은 뒤 답을 실어 다시 부른다. 빈 문자열이 "그대로 둬라" 이므로
  // 되돌려 보내기가 반복되지 않는다.
  if (proposal && answer === null) throw new Error(renamePrompt(proposal, ws))

  if (answer && !onOrigin && answer !== ws.branch) {
    // 사용자가 제안을 고쳐서 줄 수 있으므로 우리 제안이 아니라 **받은 이름**을 검증한다.
    if (!isAllowedBranchName(answer)) {
      throw new Error(
        `\`${answer}\` does not satisfy this repository's branch name rule, so pushing it would ` +
          'fail. Ask the user for a name of the form `<type>/<description>`.'
      )
    }
    await renameLocalBranch(ws.worktreePath, ws.branch, answer)
    // 아래의 createPr 과 사이드바가 곧바로 새 이름을 보게 한다. Wooi 는 워크트리 HEAD 를 다시
    // 읽어 브랜치를 맞추지만(ipc.ts), 그 갱신을 기다리면 이 턴 안에서 상태가 갈린다.
    getStore().update((st) => {
      const self = st.workspaces.find((w) => w.id === workspaceId)
      if (self) self.branch = answer
    })
    deps.broadcastState()
    branch = answer
  }

  // 리모트에 브랜치가 없으면 gh 가 PR 을 만들 수 없다. 먼저 올리되 실패 메시지는 손대지 않고
  // 그대로 올린다 — 이 리포처럼 브랜치 이름 규칙 pre-push 훅이 있으면, 모델이 그 문장을 읽고
  // 브랜치 이름을 고쳐 다시 부르는 것이 유일한 복구 경로다.
  if (!onOrigin) {
    const pushed = await pushCurrentBranch(ws.worktreePath)
    if (!pushed.ok) throw new Error(pushed.error)
  }

  const { pr, error } = await createPr(ws.worktreePath, { base, title, body, draft })
  if (error || !pr) throw new Error(error || 'Failed to open the pull request.')

  // 사이드바의 PR 칩은 store 를 본다. 다음 폴링까지 기다리면 방금 만든 PR 이 몇 초 동안 없는
  // 것처럼 보인다 — 사용자가 방금 승인한 행동의 결과이므로 바로 보여야 한다.
  getStore().update((st) => {
    const self = st.workspaces.find((w) => w.id === workspaceId)
    if (self) self.prNumber = pr.number
  })
  deps.broadcastState()

  return { number: pr.number, url: pr.url, base, branch, draft }
}
