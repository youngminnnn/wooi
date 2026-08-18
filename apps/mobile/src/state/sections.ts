import type { RemoteRepo, RemoteState, RemoteWorkspace } from '@shared/remote'
import { orderByStack } from '@shared/types'

/** 목록 화면이 그리는 리포 구역 하나. */
export interface WorkspaceSection {
  repo: RemoteRepo
  data: RemoteWorkspace[]
}

/**
 * 목록을 **데스크톱 사이드바와 같은 순서**로 만든다: 리포는 랩탑이 보낸 배열 순서대로,
 * 리포 안에서는 orderByStack(부모 바로 뒤에 그 자식들, DFS pre-order)이다. 두 배열 순서가
 * 곧 데스크톱의 표시 순서라(shared/types.ts 의 orderVisibleWorkspaces 참고, 드래그 앤 드롭
 * 재정렬도 거기 담긴다), 폰이 다시 정렬하지 않는 것만으로 두 화면이 같아진다.
 *
 * 예전에는 여기서 attention·lastActiveAt 으로 다시 정렬했다. 그러면 같은 워크스페이스가 두
 * 화면에서 다른 자리에 있을 뿐 아니라, **스택된 워크스페이스가 부모에서 떨어져 나간다** —
 * 행의 `↳` 표시는 "바로 위가 부모" 라는 뜻인데 그게 거짓이 되어, 폰에서는 계층을 읽을 방법이
 * 아예 없어진다. 급한 것을 위로 올리는 일은 순서가 아니라 행의 배지(PERMISSION/QUESTION)와
 * 구역 헤더의 개수가 맡는다.
 *
 * 아카이브된 워크스페이스는 뺀다. 데스크톱은 접힌 구역에 따로 두고, 폰에서 할 일은 "지금
 * 돌아가는 것"을 보는 쪽에 훨씬 가깝다. 부모가 아카이브돼 목록에 없으면 orderByStack 이 그
 * 자식을 뿌리로 올려 주므로 행이 사라지지 않는다.
 */
export function workspaceSections(state: RemoteState | null): WorkspaceSection[] {
  const workspaces = (state?.workspaces ?? []).filter((item) => !item.archived)
  const byRepo = new Map<string, RemoteWorkspace[]>()
  for (const workspace of workspaces) {
    const list = byRepo.get(workspace.repoId) ?? []
    list.push(workspace)
    byRepo.set(workspace.repoId, list)
  }
  const sections: WorkspaceSection[] = []
  for (const repo of state?.repos ?? []) {
    const list = byRepo.get(repo.id)
    if (list === undefined || list.length === 0) continue
    byRepo.delete(repo.id)
    sections.push({
      repo,
      // orderByStack 은 parentWorkspaceId 를 옵셔널로 보내는 구형 랩탑도 다뤄야 한다 —
      // undefined 는 "뿌리" 와 같게 취급한다(필드 자체가 v1 이후에 붙었다).
      data: orderByStack(
        list.map((workspace) => ({ ...workspace, parentWorkspaceId: workspace.parentWorkspaceId ?? null }))
      ).map(({ workspace }) => workspace)
    })
  }
  return sections
}
