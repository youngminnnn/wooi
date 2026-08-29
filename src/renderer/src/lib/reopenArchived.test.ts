import { describe, it, expect } from 'vitest'
import {
  REOPEN_STACK_LIMIT,
  dropReopenable,
  nextReopenable,
  pushReopenable
} from './reopenArchived'

describe('pushReopenable', () => {
  it('가장 최근에 아카이브한 것이 맨 위다', () => {
    expect(pushReopenable(pushReopenable([], 'a'), 'b')).toEqual(['a', 'b'])
  })

  /** 되살렸다가 다시 치운 워크스페이스가 스택에 두 번 남으면 ⇧⌘T 가 같은 곳을 두 번 연다. */
  it('같은 워크스페이스는 하나만 남기고 맨 위로 올린다', () => {
    expect(pushReopenable(['a', 'b'], 'a')).toEqual(['b', 'a'])
  })

  it('상한을 넘으면 오래된 것부터 버린다', () => {
    let stack: string[] = []
    for (let i = 0; i < REOPEN_STACK_LIMIT + 3; i++) stack = pushReopenable(stack, `w${i}`)
    expect(stack).toHaveLength(REOPEN_STACK_LIMIT)
    expect(stack[0]).toBe('w3')
  })
})

describe('dropReopenable', () => {
  /** 영구 삭제된 워크스페이스가 남아 있으면 ⇧⌘T 가 되살릴 수 없는 것을 시도하게 된다. */
  it('영구 삭제된 워크스페이스를 뺀다', () => {
    expect(dropReopenable(['a', 'b', 'c'], 'b')).toEqual(['a', 'c'])
  })

  /** 매번 새 배열을 내면 이 값을 보는 셀렉터가 끝없이 다시 그린다. */
  it('없는 id 면 같은 배열을 그대로 돌려준다', () => {
    const stack = ['a']
    expect(dropReopenable(stack, 'b')).toBe(stack)
  })
})

describe('nextReopenable', () => {
  it('가장 최근에 아카이브한 것부터 되살린다', () => {
    const first = nextReopenable(['a', 'b'], new Set(['a', 'b']))
    expect(first.target).toBe('b')
    const second = nextReopenable(first.stack, new Set(['a']))
    expect(second.target).toBe('a')
    expect(second.stack).toEqual([])
  })

  /** 사이드바에서 이미 되살렸거나 그 뒤 삭제된 것은 다시 열 대상이 아니다. */
  it('지금 아카이브 상태가 아닌 것은 건너뛴다', () => {
    const { target, stack } = nextReopenable(['a', 'restored', 'gone'], new Set(['a']))
    expect(target).toBe('a')
    expect(stack).toEqual([])
  })

  it('되살릴 것이 없으면 아무 일도 하지 않고 스택을 비운다', () => {
    expect(nextReopenable(['gone'], new Set())).toEqual({ target: null, stack: [] })
    expect(nextReopenable([], new Set(['a']))).toEqual({ target: null, stack: [] })
  })
})
