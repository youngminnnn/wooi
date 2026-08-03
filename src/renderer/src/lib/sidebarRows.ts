import { orderByStack } from '@shared/types'

/** 사이드바가 자리표시 행을 놓는 데 필요한 최소 정보(store 의 PendingWorkspace 부분집합). */
export interface PendingRowInput {
  id: string
  name: string
  parentWorkspaceId: string | null
}

export type SidebarRow<W> =
  | { kind: 'workspace'; workspace: W; depth: number }
  | { kind: 'pending'; pending: PendingRowInput; depth: number }

/**
 * 활성 워크스페이스의 stack 트리에 "생성 중" 자리표시 행을 끼워 넣는다.
 *
 * stacked 생성이면 목록 맨 끝이 아니라 **부모의 서브트리 바로 뒤** — 생성이 끝나면 실제 행이
 * 놓일 그 자리 — 에 부모보다 한 단계 들여써서 둔다. 맨 끝에 두면 스택이 깊거나 다른 리포
 * 워크스페이스가 많을 때 어느 부모 밑에 만들어지는지가 화면에서 사라지고, 완료 순간 행이
 * 목록 중간으로 튀어 오른다.
 *
 * 부모가 없거나(뿌리 생성) 목록에 없으면(아카이브 등) 예전처럼 맨 끝에 붙인다.
 */
export function orderRowsWithPending<W extends { id: string; parentWorkspaceId: string | null }>(
  workspaces: W[],
  pending: PendingRowInput[]
): Array<SidebarRow<W>> {
  const rows: Array<SidebarRow<W>> = orderByStack(workspaces).map(({ workspace, depth }) => ({
    kind: 'workspace',
    workspace,
    depth
  }))
  for (const p of pending) {
    const parentIdx = p.parentWorkspaceId
      ? rows.findIndex((r) => r.kind === 'workspace' && r.workspace.id === p.parentWorkspaceId)
      : -1
    if (parentIdx < 0) {
      rows.push({ kind: 'pending', pending: p, depth: 0 })
      continue
    }
    const depth = rows[parentIdx].depth + 1
    // 부모의 서브트리 끝까지 건너뛴다. 이미 끼워 넣은 자리표시 행도 depth 로 걸리므로,
    // 같은 부모에 여러 개를 만들면 만든 순서대로 줄을 선다.
    let i = parentIdx + 1
    while (i < rows.length && rows[i].depth >= depth) i++
    rows.splice(i, 0, { kind: 'pending', pending: p, depth })
  }
  return rows
}
