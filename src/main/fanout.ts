import { randomUUID } from 'node:crypto'
import { FANOUT_MAX_SLOTS, FANOUT_MIN_SLOTS, fanoutSlotName } from '@shared/types'
import type {
  AdoptFanoutResult,
  ArchiveScriptFailure,
  CarryFailure,
  CreateFanoutArgs,
  CreateFanoutResult,
  FanoutGroup,
  Repo,
  SendMessageOptions,
  Workspace
} from '@shared/types'
import { log } from './logger'
import { generateWorkspaceName } from './names'
import { getStore } from './store'
import { archiveWorkspace, createWorkspace } from './workspaces'
import type { ArchiveWorkspaceDeps, CreateWorkspaceDeps } from './workspaces'

/**
 * fan-out — 같은 프롬프트를 후보 워크스페이스 N 개에 동시에 던지고, 나중에 하나를 채택한다.
 *
 * 워크스페이스를 **직접 만들지 않는다**. 생성은 [[workspaces]] createWorkspace 하나만 하고,
 * 여기가 더하는 것은 (1) 후보들을 한 묶음으로 기억하는 것과 (2) 같은 프롬프트를 전부에게
 * 보내는 것뿐이다. 생성 규칙(브랜치 고유화·전달 파일·셋업 스크립트·포트)이 갈라지면 fan-out
 * 으로 만든 워크스페이스만 조용히 다르게 동작하게 된다.
 *
 * 스택과 섞이지 않는 것도 요점이다 — 후보는 전부 리포 기본 브랜치에서 갈라지므로
 * parentWorkspaceId 를 넘기지 않는다. 그래서 restack·캐스케이드는 이 형제들을 아예 보지 못한다.
 */

export interface CreateFanoutDeps extends CreateWorkspaceDeps {
  /** 만들어진 후보에게 첫 프롬프트를 보낸다(chat:send 와 같은 경로). */
  sendMessage: (workspaceId: string, text: string, opts?: SendMessageOptions) => void
}

export type AdoptFanoutDeps = ArchiveWorkspaceDeps

/**
 * 후보에게 실제로 보내는 첫 메시지.
 *
 * 프롬프트는 후보마다 **글자 하나까지 같다** — 다르면 비교의 전제가 무너진다. 아래 안내문도
 * 전 후보 공통이라 그 전제를 깨지 않는다. 안내를 붙이는 이유는 하나: 이 워크스페이스는 형제가
 * 있다는 것을 모르면 안 되는데, 동시에 형제를 기다리거나 조율하려 들면 안 되기 때문이다
 * (형제끼리는 통신 수단이 없다 — 기다리면 영원히 멈춘다).
 */
export function fanoutStartMessage(prompt: string, slots: number, baseBranch: string): string {
  return [
    prompt,
    '',
    '---',
    `Wooi sent this same prompt to ${slots} independent workspaces at once, and yours is one of ` +
      `them. Each branches from \`${baseBranch}\`, and the user will compare the results and keep one.`,
    'The siblings are invisible to you and cannot be reached, so do not wait for them, coordinate ' +
      'with them, or assume they are taking a different approach. Solve the task the way you think ' +
      'is best and tell the user when you are done.'
  ].join('\n')
}

function repoFor(repoId: string): Repo | undefined {
  return getStore()
    .getState()
    .repos.find((r) => r.id === repoId)
}

export async function createFanout(
  deps: CreateFanoutDeps,
  args: CreateFanoutArgs
): Promise<CreateFanoutResult> {
  const repo = repoFor(args.repoId)
  if (!repo) return { error: 'Repository not found.' }

  const slots = args.slots ?? []
  if (slots.length < FANOUT_MIN_SLOTS || slots.length > FANOUT_MAX_SLOTS) {
    return {
      error: `Fan-out needs between ${FANOUT_MIN_SLOTS} and ${FANOUT_MAX_SLOTS} candidates.`
    }
  }

  const store = getStore()
  // 공통 뿌리 이름을 먼저 정한다 — 후보 이름이 <base>-1 … <base>-N 로 나와야 브랜치만 보고도
  // 어느 그룹의 몇 번째인지 알 수 있다. 비어 있으면 자동 생성 이름 하나를 뿌리로 삼는다.
  let base = (args.name ?? '').trim()
  if (!base) {
    const existing = new Set(
      store
        .getState()
        .workspaces.filter((w) => w.repoId === repo.id)
        .map((w) => w.branch)
    )
    base = generateWorkspaceName(existing)
  }

  const workspaceIds: string[] = []
  const failures: string[] = []
  const carryFailures: CarryFailure[] = []
  const carryMissing = new Set<string>()
  let carrySuggestions: string[] | undefined

  // **순차로** 만든다. 같은 리포에 `git worktree add` 를 동시에 던지면 인덱스 락을 다투다가
  // 일부만 실패하는데, 그 실패는 "후보 하나가 조용히 없는 fan-out" 으로 나타난다. 후보 수는
  // 많아야 4 개라 순차로 만들어도 사용자가 기다리는 시간은 worktree 하나 몫씩 늘 뿐이다.
  for (const [index, slot] of slots.entries()) {
    const result = await createWorkspace(deps, {
      repoId: repo.id,
      name: fanoutSlotName(base, index),
      // parentWorkspaceId 를 넘기지 않는 것이 fan-out 의 정의다 — 후보는 서로의 위에 쌓이지
      // 않고 전부 리포 기본 브랜치에서 갈라진다.
      agentBackend: slot.agentBackend,
      ...(slot.multiAgent === undefined ? {} : { multiAgent: slot.multiAgent })
    })
    if (result.error || !result.workspaceId) {
      failures.push(result.error ?? 'The workspace could not be created.')
      continue
    }
    workspaceIds.push(result.workspaceId)
    if (result.carryFailures?.length) carryFailures.push(...result.carryFailures)
    // "원본 없음" 은 리포 단위 사실이라 후보마다 똑같이 온다 — 합집합으로 접어 한 번만 알린다.
    for (const path of result.carryMissing ?? []) carryMissing.add(path)
    // 전달 후보 제안은 리포 단위 사실이라 한 번만 실어 보낸다(후보마다 같은 값이 온다).
    if (!carrySuggestions && result.carrySuggestions?.length)
      carrySuggestions = result.carrySuggestions
  }

  if (workspaceIds.length === 0) {
    return { error: failures[0] ?? 'No workspaces could be created.', failures }
  }

  const group: FanoutGroup = {
    id: randomUUID(),
    repoId: repo.id,
    name: base,
    prompt: args.prompt.trim(),
    workspaceIds,
    adoptedWorkspaceId: null,
    createdAt: Date.now()
  }
  store.update((st) => {
    st.fanoutGroups = [...(st.fanoutGroups ?? []), group]
  })
  deps.broadcastState()

  // 프롬프트 발송은 그룹을 저장한 **뒤**다. 첫 턴이 돌기 시작하면 사이드바가 곧바로 상태를
  // 그리는데, 그때 그룹이 아직 없으면 형제 관계 없이 낱개 워크스페이스로만 보인다.
  const prompt = group.prompt
  if (prompt) {
    for (const id of workspaceIds) {
      // 사용자가 친 것은 fan-out 프롬프트 한 줄이고, 여기서 나가는 것은 Wooi 가 거기에 규칙을
      // 붙여 만든 지시문이다 — 대화에는 남기되 접어 둔다([[shared/types]] WooiTurnOrigin).
      deps.sendMessage(id, fanoutStartMessage(prompt, workspaceIds.length, repo.defaultBranch), {
        origin: { kind: 'wooi', label: 'Fan-out task' }
      })
    }
  }

  return {
    groupId: group.id,
    workspaceIds,
    ...(failures.length ? { failures } : {}),
    ...(carryFailures.length ? { carryFailures } : {}),
    ...(carryMissing.size ? { carryMissing: [...carryMissing] } : {}),
    ...(carrySuggestions ? { carrySuggestions } : {})
  }
}

/**
 * 승자를 채택하고 나머지 형제를 아카이브한다.
 *
 * 아카이브는 [[workspaces]] archiveWorkspace 를 그대로 쓴다 — worktree 만 걷어내고 브랜치·PR·
 * 대화는 남으므로, 나중에 "저쪽 방식이 맞았다" 는 것을 알게 돼도 사이드바에서 되살릴 수 있다.
 * 되돌릴 수 있다는 이 성질이 M1 에서 hunk 병합 없이 "채택" 만으로 충분한 이유다.
 *
 * 하나가 실패해도 멈추지 않는다. 중간에 서면 형제 절반만 정리된 상태가 남는데, 그건 사용자가
 * 지시한 것도 아니고 다시 시도하기도 애매한 상태다.
 */
export async function adoptFanoutWinner(
  deps: AdoptFanoutDeps,
  groupId: string,
  workspaceId: string
): Promise<AdoptFanoutResult> {
  const store = getStore()
  const state = store.getState()
  const group = (state.fanoutGroups ?? []).find((g) => g.id === groupId)
  if (!group) return { error: 'That fan-out group no longer exists.' }
  if (!group.workspaceIds.includes(workspaceId)) {
    return { error: 'That workspace is not one of this fan-out group’s candidates.' }
  }
  const winner = state.workspaces.find((w) => w.id === workspaceId)
  if (!winner || winner.archived) {
    return { error: 'The workspace you picked is archived or no longer exists.' }
  }

  const siblings = group.workspaceIds
    .filter((id) => id !== workspaceId)
    .map((id) => state.workspaces.find((w) => w.id === id))
    .filter((w): w is Workspace => !!w && !w.archived)

  const archived: string[] = []
  const archiveScriptFailures: ArchiveScriptFailure[] = []
  for (const sibling of siblings) {
    try {
      const { archiveScriptFailure } = await archiveWorkspace(deps, sibling.id)
      archived.push(sibling.name)
      if (archiveScriptFailure) archiveScriptFailures.push(archiveScriptFailure)
    } catch (err) {
      log.error(`fan-out 형제 아카이브 실패: ${sibling.name}`, err)
    }
  }

  store.update((st) => {
    const g = (st.fanoutGroups ?? []).find((x) => x.id === groupId)
    if (g) g.adoptedWorkspaceId = workspaceId
  })
  deps.broadcastState()

  return {
    ...(archived.length ? { archived } : {}),
    ...(archiveScriptFailures.length ? { archiveScriptFailures } : {})
  }
}

/** 그룹 기록만 지운다. 워크스페이스는 건드리지 않는다 — 묶여 있었다는 사실만 잊는 것이다. */
export function forgetFanoutGroup(broadcastState: () => void, groupId: string): void {
  const store = getStore()
  let changed = false
  store.update((st) => {
    const next = (st.fanoutGroups ?? []).filter((g) => g.id !== groupId)
    changed = next.length !== (st.fanoutGroups ?? []).length
    st.fanoutGroups = next
  })
  if (changed) broadcastState()
}

/**
 * 영구 삭제된 워크스페이스를 그룹에서 떼어 낸다.
 *
 * 아카이브는 대상이 아니다 — 아카이브된 워크스페이스는 되살아날 수 있으므로 후보 자리를 지켜야
 * 한다. 지워진 id 가 남아 있으면 비교 화면이 존재하지 않는 후보 칸을 그리고, 채택이 그 유령을
 * 아카이브하려 든다. 후보가 하나도 남지 않은 그룹은 비교할 것이 없으므로 통째로 버린다.
 *
 * @returns 상태가 실제로 바뀌었는지(호출부가 방송 여부를 정한다).
 */
export function pruneFanoutGroups(removedWorkspaceIds: string[]): boolean {
  if (removedWorkspaceIds.length === 0) return false
  const removed = new Set(removedWorkspaceIds)
  const store = getStore()
  let changed = false
  store.update((st) => {
    const groups = st.fanoutGroups ?? []
    const next: FanoutGroup[] = []
    for (const group of groups) {
      const ids = group.workspaceIds.filter((id) => !removed.has(id))
      if (ids.length === group.workspaceIds.length) {
        next.push(group)
        continue
      }
      changed = true
      if (ids.length === 0) continue
      next.push({
        ...group,
        workspaceIds: ids,
        adoptedWorkspaceId:
          group.adoptedWorkspaceId && removed.has(group.adoptedWorkspaceId)
            ? null
            : group.adoptedWorkspaceId
      })
    }
    st.fanoutGroups = next
  })
  return changed
}
