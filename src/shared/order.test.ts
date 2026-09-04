import { describe, it, expect } from 'vitest'
import {
  orderByStack,
  orderVisibleWorkspaces,
  promoteWorkspaceStack,
  reorderById,
  reorderWorkspaceStack,
  workspaceStackMembers
} from './types'

type W = {
  id: string
  repoId: string
  archived: boolean
  parentWorkspaceId: string | null
  forkedFromWorkspaceId?: string | null
}

const ws = (
  id: string,
  repoId: string,
  parentWorkspaceId: string | null = null,
  archived = false,
  forkedFromWorkspaceId?: string | null
): W => ({
  id,
  repoId,
  archived,
  parentWorkspaceId,
  forkedFromWorkspaceId
})

const ids = (list: W[]): string[] => list.map((w) => w.id)

describe('orderVisibleWorkspaces', () => {
  it('레포별로 묶어서, repos 배열 순서대로 낸다(생성 순으로 섞여 있어도)', () => {
    const repos = [{ id: 'r1' }, { id: 'r2' }]
    // 생성 순: r1 → r2 → r1 (사용자가 레포를 번갈아 만든 경우)
    const workspaces = [ws('a', 'r1'), ws('b', 'r2'), ws('c', 'r1'), ws('d', 'r2')]
    expect(ids(orderVisibleWorkspaces(repos, workspaces))).toEqual(['a', 'c', 'b', 'd'])
  })

  it('레포 안에서는 stack 순서(부모 바로 뒤에 자식)를 따른다', () => {
    const repos = [{ id: 'r1' }]
    // 배열 순서는 [부모, 남, 자식] 이지만 화면에서는 부모→자식→남 으로 그려진다.
    const workspaces = [ws('parent', 'r1'), ws('other', 'r1'), ws('child', 'r1', 'parent')]
    expect(ids(orderVisibleWorkspaces(repos, workspaces))).toEqual(['parent', 'child', 'other'])
  })

  it('fork 를 원본 바로 뒤에 놓되 들여쓰지 않는다', () => {
    const repos = [{ id: 'r1' }]
    const workspaces = [
      ws('origin', 'r1'),
      ws('other', 'r1'),
      ws('fork', 'r1', null, false, 'origin')
    ]

    expect(orderByStack(workspaces).map(({ workspace, depth }) => [workspace.id, depth])).toEqual([
      ['origin', 0],
      ['fork', 0],
      ['other', 0]
    ])
    expect(ids(orderVisibleWorkspaces(repos, workspaces))).toEqual(['origin', 'fork', 'other'])
  })

  it('fork 는 원본의 스택 자식들 뒤에 온다 — 그 자식들은 원본 위에 쌓인 것이다', () => {
    const workspaces = [
      ws('origin', 'r1'),
      ws('stacked-on-origin', 'r1', 'origin'),
      ws('fork', 'r1', null, false, 'origin')
    ]

    expect(orderByStack(workspaces).map(({ workspace, depth }) => [workspace.id, depth])).toEqual([
      ['origin', 0],
      ['stacked-on-origin', 1],
      ['fork', 0]
    ])
  })

  it('스택 자식을 fork 하면 원본과 같은 깊이에 남아 진짜 스택 위치를 감추지 않는다', () => {
    const workspaces = [
      ws('root', 'r1'),
      ws('origin', 'r1', 'root'),
      ws('fork', 'r1', 'root', false, 'origin')
    ]

    expect(orderByStack(workspaces).map(({ workspace, depth }) => [workspace.id, depth])).toEqual([
      ['root', 0],
      ['origin', 1],
      ['fork', 1]
    ])
  })

  it('fork 의 fork 도 같은 깊이로 이어 붙는다', () => {
    const workspaces = [
      ws('origin', 'r1'),
      ws('fork-2', 'r1', null, false, 'fork-1'),
      ws('fork-1', 'r1', null, false, 'origin')
    ]

    expect(orderByStack(workspaces).map(({ workspace, depth }) => [workspace.id, depth])).toEqual([
      ['origin', 0],
      ['fork-1', 0],
      ['fork-2', 0]
    ])
  })

  it('fork 원본이 보이지 않으면 기존의 없는 부모 규칙처럼 뿌리로 폴백한다', () => {
    const archivedOrigin = ws('archived-origin', 'r1', null, true)
    const forkOfArchived = ws('fork-a', 'r1', null, false, archivedOrigin.id)
    const otherRepoOrigin = ws('other-origin', 'r2')
    const forkAcrossRepo = ws('fork-b', 'r1', null, false, otherRepoOrigin.id)

    expect(
      orderByStack([forkOfArchived]).map(({ workspace, depth }) => [workspace.id, depth])
    ).toEqual([['fork-a', 0]])
    expect(
      ids(
        orderVisibleWorkspaces(
          [{ id: 'r1' }, { id: 'r2' }],
          [archivedOrigin, forkOfArchived, otherRepoOrigin, forkAcrossRepo]
        )
      )
    ).toEqual(['fork-a', 'fork-b', 'other-origin'])
  })

  it('archived 워크스페이스는 번호에서 제외된다', () => {
    const repos = [{ id: 'r1' }]
    const workspaces = [ws('a', 'r1'), ws('gone', 'r1', null, true), ws('b', 'r1')]
    expect(ids(orderVisibleWorkspaces(repos, workspaces))).toEqual(['a', 'b'])
  })

  it('repos 순서를 바꾸면 번호 순서도 같이 따라온다', () => {
    const workspaces = [ws('a', 'r1'), ws('b', 'r2')]
    expect(ids(orderVisibleWorkspaces([{ id: 'r2' }, { id: 'r1' }], workspaces))).toEqual([
      'b',
      'a'
    ])
  })

  it('repos 목록에 없는 레포의 워크스페이스도 유실 없이 뒤에 붙는다', () => {
    const workspaces = [ws('orphan', 'gone'), ws('a', 'r1')]
    expect(ids(orderVisibleWorkspaces([{ id: 'r1' }], workspaces))).toEqual(['a', 'orphan'])
  })

  // 드래그 앤 드롭 재정렬(reorderById)은 배열 자체를 다시 끼워 넣는다. 번호는 그 배열에서
  // 파생되므로, 사용자가 행을 끌어 옮기면 ⌘번호도 화면을 따라 같이 움직여야 한다.
  it('워크스페이스를 형제 사이에서 끌어 옮기면 번호도 따라 움직인다', () => {
    const repos = [{ id: 'r1' }]
    const workspaces = [ws('a', 'r1'), ws('b', 'r1'), ws('c', 'r1')]
    // c 를 a 앞으로 끌어다 놓으면 화면은 c, a, b 가 된다.
    const moved = reorderById(workspaces, 'c', 'a', 'before')
    expect(ids(orderVisibleWorkspaces(repos, moved))).toEqual(['c', 'a', 'b'])
  })

  it('레포를 끌어 옮기면 그 레포의 워크스페이스 묶음이 통째로 따라 움직인다', () => {
    const repos = [{ id: 'r1' }, { id: 'r2' }]
    const workspaces = [ws('a', 'r1'), ws('b', 'r2')]
    const movedRepos = reorderById(repos, 'r2', 'r1', 'before')
    expect(ids(orderVisibleWorkspaces(movedRepos, workspaces))).toEqual(['b', 'a'])
  })
})

describe('workspaceStackMembers', () => {
  it('뿌리부터 DFS 로 모은다', () => {
    const workspaces = [ws('child', 'r1', 'root'), ws('root', 'r1'), ws('grand', 'r1', 'child')]
    expect(ids(workspaceStackMembers(workspaces, 'child'))).toEqual(['root', 'child', 'grand'])
  })

  /**
   * 정상적인 생성 경로에서는 부모 고리가 생기지 않지만, 이 함수는 이미 위로 올라가는 루프에
   * 순환 가드를 들고 있다 — 그 전제가 아래로 내려올 때만 빠져 있으면 손상된 상태 파일 하나가
   * 스택 팝오버를 여는 순간 앱을 통째로 죽인다(무한 재귀).
   */
  it('부모 고리가 있어도 무한 재귀하지 않는다', () => {
    const workspaces = [ws('a', 'r1', 'b'), ws('b', 'r1', 'a')]
    const members = ids(workspaceStackMembers(workspaces, 'a'))
    expect(members).toHaveLength(2)
    expect([...members].sort()).toEqual(['a', 'b'])
  })

  it('자기 자신을 부모로 가리켜도 한 번만 담는다', () => {
    const workspaces = [ws('a', 'r1', 'a')]
    expect(ids(workspaceStackMembers(workspaces, 'a'))).toEqual(['a'])
  })
})

describe('sidebar stack ordering', () => {
  it('자식을 끌어도 뿌리와 자손이 함께 다른 stack 앞으로 이동한다', () => {
    const workspaces = [
      ws('a', 'r1'),
      ws('a-child', 'r1', 'a'),
      ws('b', 'r1'),
      ws('b-child', 'r1', 'b')
    ]
    const moved = reorderWorkspaceStack(workspaces, 'b-child', 'a-child', 'before')
    expect(orderByStack(moved).map(({ workspace }) => workspace.id)).toEqual([
      'b',
      'b-child',
      'a',
      'a-child'
    ])
  })

  it('최근 활성 stack 은 고정 stack 아래로 올라오고 고정 stack 은 움직이지 않는다', () => {
    const pinned = { ...ws('pinned', 'r1'), sidebarPinned: true }
    const workspaces = [pinned, ws('older', 'r1'), ws('active', 'r1'), ws('child', 'r1', 'active')]
    const moved = promoteWorkspaceStack(workspaces, 'child')
    expect(orderByStack(moved).map(({ workspace }) => workspace.id)).toEqual([
      'pinned',
      'active',
      'child',
      'older'
    ])
  })
})
