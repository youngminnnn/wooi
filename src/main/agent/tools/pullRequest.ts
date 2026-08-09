import type { Workspace } from '@shared/types'
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

  // 리모트에 브랜치가 없으면 gh 가 PR 을 만들 수 없다. 먼저 올리되 실패 메시지는 손대지 않고
  // 그대로 올린다 — 이 리포처럼 브랜치 이름 규칙 pre-push 훅이 있으면, 모델이 그 문장을 읽고
  // 브랜치 이름을 고쳐 다시 부르는 것이 유일한 복구 경로다.
  if (!(await originHasBranch(ws.worktreePath, ws.branch))) {
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

  return { number: pr.number, url: pr.url, base, draft }
}
