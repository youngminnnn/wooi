import { workspaceDisplayName } from '@shared/types'
import type { Workspace } from '@shared/types'
import { listChangedPaths } from '../../git'
import { getStore } from '../../store'
import type { AgentToolHandler } from './registry'

/**
 * 같은 리포의 다른 워크스페이스가 지금 어떤 파일을 건드리고 있는지 본다.
 *
 * 스택은 의존 관계가 있는 작업을 줄로 세워 충돌을 없애지만, **스택 관계가 없는 형제 워크스페이스는
 * 그냥 같은 파일을 동시에 고친다.** 그 사실은 머지 때가 돼서야 드러나고, 그때 해결하려면 양쪽
 * diff 를 다 읽어야 해서 비싸다. check_stacked_work 가 내 자식만 보는 것과 달리 여기서는 형제까지
 * 본다 — 정작 위험한 쪽이 형제다.
 *
 * **경로만 준다. diff 내용은 절대 싣지 않는다** — 남의 작업 내용까지 컨텍스트로 끌고 올 이유가
 * 없고, 비용도 폭발한다. 모델은 "겹치는가" 만 알면 되고, 겹치면 사람에게 물으면 된다.
 */

/** 워크스페이스 1건당 돌려줄 경로 수. 넘으면 잘라 내고 남은 개수를 함께 준다. */
const MAX_PATHS_PER_WORKSPACE = 50

/** 돌려줄 워크스페이스 수. 리포에 워크스페이스가 수십 개인 상태에서 전부 실으면 결과가 폭발한다. */
const MAX_WORKSPACES = 20

type Relation = 'parent' | 'child' | 'sibling'

function relationTo(self: Workspace, other: Workspace): Relation {
  if (other.id === self.parentWorkspaceId) return 'parent'
  if (other.parentWorkspaceId === self.id) return 'child'
  return 'sibling'
}

export const checkRelatedWork: AgentToolHandler = async (_deps, workspaceId, args) => {
  const state = getStore().getState()
  const self = state.workspaces.find((w) => w.id === workspaceId)
  if (!self) throw new Error('This workspace no longer exists.')

  const others = state.workspaces.filter(
    (w) => w.repoId === self.repoId && w.id !== workspaceId && !w.archived
  )
  if (others.length === 0) {
    return {
      branch: self.branch,
      workspaces: [],
      overlaps: [],
      note: 'No other workspace is open on this repository, so nothing can collide right now.'
    }
  }

  // 관심 경로를 주면 그것과 비교하고(아직 고치지 않은 파일도 미리 물어볼 수 있다), 안 주면
  // 이 워크스페이스가 지금까지 건드린 파일과 비교한다.
  const asked = Array.isArray(args.paths)
    ? args.paths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    : null
  const mine = new Set(asked ?? (await listChangedPaths(self.worktreePath, self.baseBranch)))

  // git 조회는 워크스페이스마다 프로세스를 띄우므로 병렬로 돌린다. 하나가 실패해도(워크트리가
  // 사라졌거나 base ref 가 없어도) 나머지는 그대로 나와야 하므로 개별적으로 잡는다.
  const scanned = await Promise.all(
    others.map(async (w) => {
      const paths = await listChangedPaths(w.worktreePath, w.baseBranch).catch(() => [])
      return { ws: w, paths }
    })
  )

  // 겹침은 **자르기 전** 전체 집합에서 구한다. 잘라 낸 꼬리에 겹친 파일이 있으면 이 도구가
  // 존재하는 이유가 사라진다.
  const rows = scanned.map(({ ws, paths }) => ({
    ws,
    paths,
    overlapping: mine.size ? paths.filter((p) => mine.has(p)) : []
  }))

  // 겹치는 워크스페이스를 먼저 놓고 자른다 — 상한에 걸려 잘리는 쪽은 항상 덜 위험한 쪽이어야 한다.
  rows.sort((a, b) => b.overlapping.length - a.overlapping.length)
  const shown = rows.slice(0, MAX_WORKSPACES)
  const colliding = rows.filter((r) => r.overlapping.length > 0)

  return {
    branch: self.branch,
    comparedPaths: mine.size,
    // 모델이 두 목록을 직접 대조하게 두지 않는다 — 겹친 것은 여기 모아 준다.
    overlaps: colliding
      // 정렬이 겹침 많은 순이라 잘려도 가장 위험한 것부터 남는다.
      .slice(0, MAX_WORKSPACES)
      .map((r) => ({
        workspaceId: r.ws.id,
        name: workspaceDisplayName(r.ws),
        branch: r.ws.branch,
        relation: relationTo(self, r.ws),
        paths: r.overlapping.slice(0, MAX_PATHS_PER_WORKSPACE)
      })),
    workspaces: shown.map((r) => ({
      workspaceId: r.ws.id,
      name: workspaceDisplayName(r.ws),
      branch: r.ws.branch,
      // running 이면 지금 이 순간에도 파일이 늘어나는 중이다 — 목록이 곧 낡는다.
      running: r.ws.status === 'running',
      relation: relationTo(self, r.ws),
      // 여기가 모델이 **다른 워크스페이스의 id 를 보는 유일한 곳**이다. 대상을 받는 도구는
      // 자기가 만든 것만 받으므로([[agent/tools/target]]), 어느 것이 그에 해당하는지 여기서
      // 말해 주지 않으면 모델은 찍어 보고 거절당하는 수밖에 없다. relation 으로는 알 수 없다 —
      // 사람이 만든 스택 자식도 'child' 다.
      // false 는 싣지 않는다. 목록이 길고, 없는 것이 곧 "네 것이 아니다" 다.
      ...(r.ws.createdByWorkspaceId === workspaceId ? { createdByYou: true } : {}),
      changedPaths: r.paths.slice(0, MAX_PATHS_PER_WORKSPACE),
      ...(r.paths.length > MAX_PATHS_PER_WORKSPACE
        ? { truncatedPaths: r.paths.length - MAX_PATHS_PER_WORKSPACE }
        : {})
    })),
    ...(rows.length > MAX_WORKSPACES ? { truncatedWorkspaces: rows.length - MAX_WORKSPACES } : {}),
    ...noteFor(mine.size, colliding.length)
  }
}

/**
 * 결과를 어떻게 읽어야 하는지 한 줄로 말해 준다.
 *
 * 목록만 돌려주면 겹침을 찾고도 그냥 편집을 이어가는 일이 생긴다 — 그러면 부른 보람이 없다.
 * 특히 **여기서는 남의 diff 를 볼 수 없다**는 사실이 중요하다: 겹친 파일이 정말 충돌하는지는
 * 이 도구가 판단할 수 없고, 모델도 판단할 수 없다. 그러니 조용히 넘기지 말고 사람에게 말해야 한다.
 */
function noteFor(comparedPaths: number, collidingWorkspaces: number): { note?: string } {
  if (comparedPaths === 0)
    return { note: 'This workspace has not changed anything yet, so no overlap could be computed.' }
  if (collidingWorkspaces === 0)
    return { note: 'Nothing you are changing is being changed elsewhere right now.' }
  return {
    note:
      `${collidingWorkspaces} other workspace(s) are changing files you are changing too. ` +
      'Tell the user which workspace and which paths before you edit them — you cannot see the ' +
      'other side’s diff, so you cannot tell on your own whether the two changes conflict.'
  }
}
