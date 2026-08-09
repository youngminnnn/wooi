import { workspaceDisplayName } from '@shared/types'
import type { ChatItem, StackedHandoffStatus, Workspace } from '@shared/types'
import { isWorktreeClean, summarizeBranch } from '../../git'
import type { BranchSummary } from '../../git'
import { getStore } from '../../store'
import { createWorkspace } from '../../workspaces'
import type { AgentToolHandler } from './registry'

/**
 * 스택 워크스페이스 사이의 작업 인계.
 *
 * 두 방향이 비대칭인 것이 핵심이다. 부모 → 자식은 **깨운다**(빈 워크스페이스에 최초 작업을
 * 넘기는 것이고, 사용자가 그 도구 호출을 방금 승인했다). 자식 → 부모는 **기록만 한다** —
 * 부모는 사람과 대화 중일 수 있고, 승인하지 않은 턴 비용을 자식이 일으켜서는 안 된다.
 * 부모는 check_stacked_work 로 직접 읽는다.
 */

function workspaceOf(workspaceId: string): Workspace {
  const ws = getStore()
    .getState()
    .workspaces.find((w) => w.id === workspaceId)
  if (!ws) throw new Error('This workspace no longer exists.')
  return ws
}

/**
 * 부모 브랜치가 이미 담고 있는 것. 자식이 물려받은 코드라 첫 턴에 반드시 알아내야 하는데,
 * 놔두면 `git log` · `git diff` · 파일 훑기로 두세 턴을 쓴다. git 이 공짜로 정확히 답하는
 * 질문을 모델에게 시키지 않는다.
 *
 * 부모 모델이 쓰는 인계문(task)과 역할이 다르다 — 저쪽은 **판단**(왜 이렇게 했는가)이고
 * 이쪽은 **사실**(무엇이 바뀌었는가)이다. 사실 쪽은 모델이 빠뜨릴 수 없어야 한다.
 */
function inheritedWorkSection(summary: BranchSummary): string[] {
  const lines = ['', '## What this branch already contains']
  if (summary.commits.length) {
    lines.push('', 'Commits since the base branch (newest first):')
    lines.push(...summary.commits.map((c) => `- ${c}`))
    if (summary.omittedCommits) lines.push(`- …and ${summary.omittedCommits} older commits`)
  }
  if (summary.files.length) {
    lines.push('', 'Files they changed (largest first):')
    lines.push(...summary.files.map((f) => `- ${f}`))
    if (summary.omittedFiles) lines.push(`- …and ${summary.omittedFiles} more files`)
  }
  return lines
}

/**
 * 자식에게 넘기는 최초 메시지.
 *
 * 보고하라는 지시를 부모 모델의 문장에 맡기지 않고 여기서 붙인다 — 부모가 빠뜨리면 자식은
 * 보고할 줄 모르고, 그 순간 인계 고리가 조용히 끊긴다. 규약은 앱이 보장해야 한다.
 */
function handoffMessage(task: string, parent: Workspace, summary: BranchSummary | null): string {
  return [
    task,
    '',
    '---',
    `This workspace was created by Wooi as a stacked branch on top of \`${parent.branch}\`, ` +
      'so its pull request will target that branch rather than the default one.',
    'When you finish this task — or if you get stuck and need a decision — call ' +
      '`mcp__wooi__report_to_parent` with a summary. That is the only way the parent workspace ' +
      'finds out; nothing crosses between workspaces on its own.',
    ...(summary ? inheritedWorkSection(summary) : [])
  ].join('\n')
}

export const createStackedWorkspace: AgentToolHandler = async (deps, workspaceId, args) => {
  const ws = workspaceOf(workspaceId)
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
    // 부모 관계와 별개로 생성자도 남긴다. 스택에서는 두 값이 같지만 묻는 것이 다르다 —
    // 사람이 UI 에서 만든 스택 자식은 부모가 있어도 생성자가 없고, 그 구분이 대상을 받는
    // 도구의 권한 판정 근거가 된다([[agent/tools/target]]).
    createdByWorkspaceId: ws.id,
    ...(name ? { name } : {})
  })
  if (result.error) throw new Error(result.error)
  const childId = result.workspaceId
  if (!childId) throw new Error('The workspace was created but Wooi lost track of it.')

  // 작업을 넘기면 자식은 **즉시 돌기 시작한다**. 사용자는 방금 이 도구 호출을 승인하면서
  // 그 작업 문장까지 카드에서 봤으므로, 여기서 다시 묻지 않는다.
  const task = typeof args.task === 'string' ? args.task.trim() : ''
  if (task) {
    // 요약은 **부모 워크트리에서** 읽는다. 자식은 방금 만들어져 아직 아무 커밋도 없고, 부모는
    // 위에서 clean 을 확인했으므로 HEAD 가 곧 자식이 갈라진 지점이다.
    //
    // 생성 **뒤에** 부르는 것이 중요하다 — createWorkspace 가 addWorktree 에서 fetch 를 돌리므로
    // 이 시점의 origin ref 가 최신이고, 분기점을 그만큼 정확히 잡는다([[git]] branchPoint).
    //
    // 실패해도 인계는 진행한다 — 요약은 자식을 빠르게 만들 뿐, 없다고 틀리지는 않는다.
    const summary = await summarizeBranch(ws.worktreePath, ws.baseBranch).catch(() => null)
    deps.sendMessage(childId, handoffMessage(task, ws, summary))
  }

  // 전달 실패는 생성을 막지 않지만 조용히 넘기면 안 된다 — 새 워크스페이스의 에이전트가
  // 프로젝트 지침(CLAUDE.local.md 등)을 못 읽은 채 다르게 동작한다.
  const carryFailures = (result.carryFailures ?? []).map((f) => `${f.path}: ${f.reason}`)

  return {
    workspaceId: childId,
    branch: result.branch,
    baseBranch: ws.branch,
    started: !!task,
    // 인계 규약의 부모 쪽 절반. 서버 안내(WOOI_MCP_INSTRUCTIONS)에 두면 스택을 안 쓰는
    // 워크스페이스까지 매 요청 값을 치르므로, 자식이 생긴 바로 이 순간에만 붙인다.
    next:
      'Nothing crosses between workspaces on its own. This workspace will not be interrupted when ' +
      'the new one reports back — call `check_stacked_work` when its result would change what you do.',
    ...(task
      ? {}
      : { note: 'No task was handed over, so this workspace is idle until someone prompts it.' }),
    ...(carryFailures.length ? { carryFailures } : {})
  }
}

export const reportToParent: AgentToolHandler = async (deps, workspaceId, args) => {
  const ws = workspaceOf(workspaceId)
  const parentId = ws.parentWorkspaceId
  if (!parentId) {
    throw new Error(
      'This workspace is not stacked on another one, so there is no parent to report to.'
    )
  }
  const parent = getStore()
    .getState()
    .workspaces.find((w) => w.id === parentId)
  if (!parent) throw new Error('The parent workspace no longer exists.')

  const summary = typeof args.summary === 'string' ? args.summary.trim() : ''
  if (!summary) throw new Error('The summary is empty — say what you did or what you are stuck on.')
  const status: StackedHandoffStatus = args.status === 'blocked' ? 'blocked' : 'done'
  const at = Date.now()

  getStore().update((st) => {
    const self = st.workspaces.find((w) => w.id === workspaceId)
    // 다시 보고하면 덮어쓴다 — 부모가 알고 싶은 것은 "지금 어떤 상태인가" 하나다.
    if (self) self.handoff = { status, summary, at }
  })

  // 부모 **대화에** 카드를 남긴다. 부모 모델은 이걸 읽지 않는다(트랜스크립트 ≠ 컨텍스트) —
  // 사람이 눈으로 알아채고, 필요하면 부모에게 확인을 시키라고 있는 것이다.
  const item: ChatItem = {
    id: `handoff:${workspaceId}:${at}`,
    type: 'handoff',
    childWorkspaceId: workspaceId,
    // 자식이 사라져도 카드는 읽혀야 하므로 이름을 지금 스냅샷한다.
    childName: workspaceDisplayName(ws),
    childBranch: ws.branch,
    status,
    summary,
    ts: at
  }
  deps.postToTranscript(parentId, item)
  deps.broadcastState()

  return {
    reportedTo: { workspaceId: parentId, branch: parent.branch },
    status,
    note: 'The parent was not interrupted — it reads this on its next turn.'
  }
}

export const checkStackedWork: AgentToolHandler = async (_deps, workspaceId) => {
  const state = getStore().getState()
  const children = state.workspaces.filter((w) => w.parentWorkspaceId === workspaceId)

  return {
    children: children.map((c) => ({
      workspaceId: c.id,
      branch: c.branch,
      name: workspaceDisplayName(c),
      // running 이면 아직 도는 중이다 — 보고가 없다고 실패한 것이 아니다.
      running: c.status === 'running',
      archived: c.archived,
      prNumber: c.prNumber,
      report: c.handoff
        ? { status: c.handoff.status, summary: c.handoff.summary, at: c.handoff.at }
        : null
    })),
    ...(children.length ? {} : { note: 'Nothing is stacked on this workspace yet.' })
  }
}
