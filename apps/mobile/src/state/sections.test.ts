import { describe, expect, it } from 'vitest'
import type { RemoteState, RemoteWorkspace } from '@shared/remote'
import { workspaceSections } from './sections'

/**
 * 목록 순서는 데스크톱 사이드바와 **같아야 한다**. 두 화면에서 같은 워크스페이스가 다른 자리에
 * 있으면 폰에서 잘못된 행을 여는 일이 생기고, 무엇보다 스택된 워크스페이스가 부모에서 떨어지면
 * 행의 `↳` 가 거짓이 된다(폰에는 그것 말고 계층을 말하는 것이 없다).
 */
function ws(partial: Partial<RemoteWorkspace> & { id: string; repoId: string }): RemoteWorkspace {
  return {
    name: partial.id,
    displayName: null,
    branch: `feat/${partial.id}`,
    status: 'idle',
    permissionMode: 'default',
    model: null,
    effort: null,
    archived: false,
    muted: false,
    prNumber: null,
    lastActiveAt: 0,
    attention: null,
    parentWorkspaceId: null,
    ...partial
  }
}

const state = (workspaces: RemoteWorkspace[], repoIds = ['a', 'b']): RemoteState => ({
  rev: 1,
  machine: { id: 'm', name: 'Mac', appVersion: '1.0.0' },
  repos: repoIds.map((id) => ({ id, name: id })),
  workspaces,
  pendingPermissions: []
})

const ids = (state: RemoteState): string[][] =>
  workspaceSections(state).map((section) => section.data.map((w) => w.id))

describe('목록 구역 순서', () => {
  it('랩탑이 보낸 배열 순서를 그대로 쓴다 — 최근 활동으로 다시 정렬하지 않는다', () => {
    const rows = [
      ws({ id: 'first', repoId: 'a', lastActiveAt: 1 }),
      ws({ id: 'second', repoId: 'a', lastActiveAt: 999 })
    ]
    expect(ids(state(rows))).toEqual([['first', 'second']])
  })

  it('기다리는 워크스페이스도 위로 끌어올리지 않는다 — 자리는 그대로, 급함은 배지가 말한다', () => {
    const rows = [
      ws({ id: 'quiet', repoId: 'a' }),
      ws({ id: 'asking', repoId: 'a', attention: 'permission' })
    ]
    expect(ids(state(rows))).toEqual([['quiet', 'asking']])
  })

  it('스택된 워크스페이스는 부모 바로 아래에 온다', () => {
    const rows = [
      ws({ id: 'parent', repoId: 'a' }),
      ws({ id: 'other', repoId: 'a' }),
      ws({ id: 'child', repoId: 'a', parentWorkspaceId: 'parent', attention: 'permission' }),
      ws({ id: 'grandchild', repoId: 'a', parentWorkspaceId: 'child', lastActiveAt: 999 })
    ]
    expect(ids(state(rows))).toEqual([['parent', 'child', 'grandchild', 'other']])
  })

  it('리포 순서는 랩탑이 보낸 리포 배열을 따르고, 빈 리포는 구역을 만들지 않는다', () => {
    const rows = [ws({ id: 'only-b', repoId: 'b' }), ws({ id: 'only-a', repoId: 'a' })]
    expect(workspaceSections(state(rows)).map((s) => s.repo.id)).toEqual(['a', 'b'])
  })

  it('아카이브된 부모가 빠져도 자식은 뿌리로 남는다 — 행이 사라지지 않는다', () => {
    const rows = [
      ws({ id: 'gone', repoId: 'a', archived: true }),
      ws({ id: 'child', repoId: 'a', parentWorkspaceId: 'gone' })
    ]
    expect(ids(state(rows))).toEqual([['child']])
  })

  it('parentWorkspaceId 를 아예 보내지 않는 구형 랩탑도 뿌리로 다룬다', () => {
    const rows = [ws({ id: 'old', repoId: 'a' })]
    delete (rows[0] as { parentWorkspaceId?: string | null }).parentWorkspaceId
    expect(ids(state(rows))).toEqual([['old']])
  })

  it('상태가 없으면 구역도 없다', () => {
    expect(workspaceSections(null)).toEqual([])
  })
})
