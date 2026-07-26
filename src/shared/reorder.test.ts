import { describe, it, expect } from 'vitest'
import { reorderById, orderByStack } from './types'

const ids = (items: Array<{ id: string }>): string[] => items.map((i) => i.id)
const list = (...names: string[]): Array<{ id: string }> => names.map((id) => ({ id }))

describe('reorderById', () => {
  it('아래 항목을 위쪽 항목 앞으로 옮긴다', () => {
    expect(ids(reorderById(list('a', 'b', 'c'), 'c', 'a', 'before'))).toEqual(['c', 'a', 'b'])
  })

  it('아래 항목을 위쪽 항목 뒤로 옮긴다', () => {
    expect(ids(reorderById(list('a', 'b', 'c'), 'c', 'a', 'after'))).toEqual(['a', 'c', 'b'])
  })

  // 아래로 옮길 때가 인덱스 계산이 어긋나기 쉬운 지점 — 드래그 항목을 먼저 빼면 대상 인덱스가
  // 한 칸 당겨지므로, 원본 인덱스를 그대로 쓰면 한 칸씩 밀린 자리에 꽂힌다.
  it('위 항목을 아래쪽 항목 뒤로 옮길 때 한 칸 밀리지 않는다', () => {
    expect(ids(reorderById(list('a', 'b', 'c'), 'a', 'c', 'after'))).toEqual(['b', 'c', 'a'])
  })

  it('위 항목을 아래쪽 항목 앞으로 옮긴다', () => {
    expect(ids(reorderById(list('a', 'b', 'c'), 'a', 'c', 'before'))).toEqual(['b', 'a', 'c'])
  })

  it('이웃끼리 맞바꾼다', () => {
    expect(ids(reorderById(list('a', 'b'), 'a', 'b', 'after'))).toEqual(['b', 'a'])
    expect(ids(reorderById(list('a', 'b'), 'b', 'a', 'before'))).toEqual(['b', 'a'])
  })

  it('자기 자신에 놓거나 대상이 없으면 원본을 그대로 돌려준다', () => {
    const items = list('a', 'b', 'c')
    expect(reorderById(items, 'a', 'a', 'before')).toBe(items)
    expect(reorderById(items, 'a', 'nope', 'before')).toBe(items)
    expect(reorderById(items, 'nope', 'a', 'before')).toBe(items)
  })

  it('원본 배열을 변형하지 않는다', () => {
    const items = list('a', 'b', 'c')
    reorderById(items, 'a', 'c', 'after')
    expect(ids(items)).toEqual(['a', 'b', 'c'])
  })
})

describe('reorderById + orderByStack', () => {
  type Ws = { id: string; parentWorkspaceId: string | null }
  // root1 ─ child, root2. 사이드바는 이 배열을 DFS 로 펼쳐 그린다.
  const stacked: Ws[] = [
    { id: 'root1', parentWorkspaceId: null },
    { id: 'child', parentWorkspaceId: 'root1' },
    { id: 'root2', parentWorkspaceId: null }
  ]

  it('부모를 옮기면 자식이 배열 어디에 있든 따라 붙는다', () => {
    const moved = reorderById(stacked, 'root1', 'root2', 'after')
    expect(orderByStack(moved).map((e) => e.workspace.id)).toEqual(['root2', 'root1', 'child'])
  })

  it('형제 뿌리끼리의 순서 교환이 화면 순서에 그대로 반영된다', () => {
    const moved = reorderById(stacked, 'root2', 'root1', 'before')
    expect(orderByStack(moved).map((e) => e.workspace.id)).toEqual(['root2', 'root1', 'child'])
  })
})
