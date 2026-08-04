import { describe, it, expect } from 'vitest'
import {
  WORKSPACE_HISTORY_LIMIT,
  popWorkspaceHistory,
  pushWorkspaceHistory
} from './workspaceHistory'

/** 워크스페이스 id 몇 개를 방문한 뒤의 기록을 만든다. */
function visit(ids: (string | null)[]): { history: string[]; current: string | null } {
  let history: string[] = []
  let current: string | null = null
  for (const id of ids) {
    history = pushWorkspaceHistory(history, current, id)
    current = id
  }
  return { history, current }
}

describe('pushWorkspaceHistory', () => {
  it('직전 워크스페이스를 순서대로 쌓는다', () => {
    expect(visit(['a', 'b', 'c']).history).toEqual(['a', 'b'])
  })

  it('첫 선택은 쌓을 직전이 없다', () => {
    expect(pushWorkspaceHistory([], null, 'a')).toEqual([])
  })

  it('같은 워크스페이스를 다시 고르면 쌓지 않는다', () => {
    expect(pushWorkspaceHistory(['a'], 'b', 'b')).toEqual(['a'])
  })

  /** 뒤로가기로 온 선택까지 쌓으면 두 워크스페이스 사이를 오가기만 한다. */
  it('뒤로가기로 인한 선택은 쌓지 않는다', () => {
    expect(pushWorkspaceHistory(['a'], 'c', 'b', true)).toEqual(['a'])
  })

  it('기록 길이는 상한을 넘지 않고 오래된 것부터 버린다', () => {
    let history: string[] = []
    for (let i = 0; i < WORKSPACE_HISTORY_LIMIT + 10; i++) {
      history = pushWorkspaceHistory(history, `w${i}`, `w${i + 1}`)
    }
    expect(history).toHaveLength(WORKSPACE_HISTORY_LIMIT)
    expect(history[0]).toBe('w10')
  })
})

describe('popWorkspaceHistory', () => {
  const alive = new Set(['a', 'b', 'c'])

  /** A → B → C 에서 ⌘[ 두 번이면 B 를 거쳐 A 까지 거슬러 올라간다. */
  it('방문 순서를 거슬러 올라간다', () => {
    const first = popWorkspaceHistory(['a', 'b'], 'c', alive)
    expect(first.target).toBe('b')
    const second = popWorkspaceHistory(first.history, 'b', alive)
    expect(second.target).toBe('a')
    expect(second.history).toEqual([])
  })

  it('돌아갈 곳이 없으면 아무 데도 가지 않는다', () => {
    expect(popWorkspaceHistory([], 'a', alive)).toEqual({ target: null, history: [] })
  })

  it('아카이브·삭제된 워크스페이스는 건너뛴다', () => {
    const { target, history } = popWorkspaceHistory(['a', 'gone', 'also-gone'], 'c', alive)
    expect(target).toBe('a')
    expect(history).toEqual([])
  })

  it('기록에 남은 현재 워크스페이스는 건너뛴다', () => {
    expect(popWorkspaceHistory(['a', 'c'], 'c', alive).target).toBe('a')
  })

  it('되짚을 것이 하나도 없으면 기록을 비운다', () => {
    expect(popWorkspaceHistory(['gone'], 'c', alive)).toEqual({ target: null, history: [] })
  })
})
