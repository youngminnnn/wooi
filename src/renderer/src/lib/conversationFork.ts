import { workspaceTreeParent, type Workspace } from '@shared/types'

/**
 * 세 입구(사이드바·헤더·/fork)가 서로 다른 순간에 활성화되면 사용자는 같은 동작을 믿을 수 없다.
 * 대화 파일을 읽는 안전 조건을 한곳에서 결정해, 새 입구가 생겨도 같은 경계를 쓰게 한다.
 */
export function conversationForkDisabledReason(
  workspace: Pick<Workspace, 'sessionId' | 'status'>
): string | null {
  if (workspace.sessionId == null) return 'No conversation to fork yet'
  if (workspace.status === 'running') return 'Wait for the current turn to finish'
  return null
}

/** `/fork [name]` 의 선택 이름. 빈 인자는 키 자체를 만들지 않아 main 의 이름 생성을 그대로 쓴다. */
export function parseForkCommand(text: string): { name?: string } | null {
  const match = /^\/fork(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match) return null
  const name = (match[1] ?? '').trim()
  return name ? { name } : {}
}

/** 화면에 그린 트리와 드래그 가능한 형제의 정의가 갈라지지 않게 같은 부모 함수를 쓴다. */
export function areWorkspaceTreeSiblings(
  a: Pick<Workspace, 'repoId' | 'archived' | 'parentWorkspaceId' | 'forkedFromWorkspaceId'>,
  b: Pick<Workspace, 'repoId' | 'archived' | 'parentWorkspaceId' | 'forkedFromWorkspaceId'>
): boolean {
  return (
    a.repoId === b.repoId &&
    workspaceTreeParent(a) === workspaceTreeParent(b) &&
    a.archived === b.archived
  )
}
