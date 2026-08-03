import { describe, it, expect } from 'vitest'
import { orderRowsWithPending } from './sidebarRows'

const ws = (
  id: string,
  parentWorkspaceId: string | null = null
): { id: string; parentWorkspaceId: string | null } => ({
  id,
  parentWorkspaceId
})
const pending = (
  id: string,
  parentWorkspaceId: string | null = null
): { id: string; name: string; parentWorkspaceId: string | null } => ({
  id,
  name: '',
  parentWorkspaceId
})

const layout = (rows: ReturnType<typeof orderRowsWithPending>): Array<[string, number]> =>
  rows.map((r) => [r.kind === 'workspace' ? r.workspace.id : r.pending.id, r.depth])

describe('orderRowsWithPending', () => {
  it('부모 없는 자리표시 행은 목록 맨 끝에 붙는다', () => {
    const rows = orderRowsWithPending([ws('a'), ws('b')], [pending('p1')])
    expect(layout(rows)).toEqual([
      ['a', 0],
      ['b', 0],
      ['p1', 0]
    ])
  })

  it('stacked 자리표시 행은 부모 바로 밑에 한 단계 들여써서 놓인다', () => {
    const rows = orderRowsWithPending([ws('a'), ws('b')], [pending('p1', 'a')])
    expect(layout(rows)).toEqual([
      ['a', 0],
      ['p1', 1],
      ['b', 0]
    ])
  })

  it('부모에 이미 자식이 있으면 그 서브트리 뒤 — 실제 행이 놓일 자리 — 에 들어간다', () => {
    const rows = orderRowsWithPending(
      [ws('a'), ws('child', 'a'), ws('grandchild', 'child'), ws('b')],
      [pending('p1', 'a')]
    )
    expect(layout(rows)).toEqual([
      ['a', 0],
      ['child', 1],
      ['grandchild', 2],
      ['p1', 1],
      ['b', 0]
    ])
  })

  it('같은 부모에 여러 개를 만들면 만든 순서대로 줄을 선다', () => {
    const rows = orderRowsWithPending([ws('a'), ws('b')], [pending('p1', 'a'), pending('p2', 'a')])
    expect(layout(rows)).toEqual([
      ['a', 0],
      ['p1', 1],
      ['p2', 1],
      ['b', 0]
    ])
  })

  it('부모가 목록에 없으면(아카이브 등) 맨 끝으로 되돌아간다', () => {
    const rows = orderRowsWithPending([ws('a')], [pending('p1', 'gone')])
    expect(layout(rows)).toEqual([
      ['a', 0],
      ['p1', 0]
    ])
  })
})
