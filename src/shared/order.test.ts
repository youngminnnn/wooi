import { describe, it, expect } from 'vitest'
import { orderVisibleWorkspaces } from './types'

type W = {
  id: string
  repoId: string
  archived: boolean
  parentWorkspaceId: string | null
}

const ws = (
  id: string,
  repoId: string,
  parentWorkspaceId: string | null = null,
  archived = false
): W => ({
  id,
  repoId,
  archived,
  parentWorkspaceId
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
})
