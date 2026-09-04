import { describe, expect, it } from 'vitest'
import {
  compareBaseBranch,
  normalizeCompareBase,
  offersCompareBaseChoice,
  DEFAULT_COMPARE_BASE
} from './compareBase'

describe('normalizeCompareBase', () => {
  it('저장된 값이 없으면 지금까지의 자동 판정을 쓴다', () => {
    expect(normalizeCompareBase(undefined)).toBe(DEFAULT_COMPARE_BASE)
    expect(normalizeCompareBase(null)).toBe('stack-parent')
  })

  it('예전 빌드가 써 둔 모르는 값도 기본으로 되돌린다', () => {
    expect(normalizeCompareBase('upstream-of-the-week')).toBe('stack-parent')
    expect(normalizeCompareBase(42)).toBe('stack-parent')
  })

  it('아는 값은 그대로 둔다', () => {
    expect(normalizeCompareBase('default-branch')).toBe('default-branch')
  })
})

describe('compareBaseBranch', () => {
  const stacked = { baseBranch: 'feat/parent', defaultBranch: 'main' }

  it('기본값은 워크스페이스의 진짜 base — 즉 아무것도 바뀌지 않는다', () => {
    expect(compareBaseBranch(stacked)).toBe('feat/parent')
    expect(compareBaseBranch({ ...stacked, compareBase: null })).toBe('feat/parent')
    expect(compareBaseBranch({ ...stacked, compareBase: 'stack-parent' })).toBe('feat/parent')
  })

  it('기본 브랜치를 고르면 그쪽과 견준다', () => {
    expect(compareBaseBranch({ ...stacked, compareBase: 'default-branch' })).toBe('main')
  })

  it('origin/ 을 붙이는 일은 여기서 하지 않는다', () => {
    // resolveBaseStartPoint 가 리모트 유무를 보고 하던 판단은 어느 쪽을 골라도 그대로 남는다.
    expect(compareBaseBranch({ ...stacked, compareBase: 'default-branch' })).not.toMatch(
      /^origin\//
    )
  })
})

describe('offersCompareBaseChoice', () => {
  it('스택 위에서는 고를 것이 둘이다', () => {
    expect(offersCompareBaseChoice('feat/parent', 'main')).toBe(true)
  })

  it('스택 뿌리는 두 선택지가 같은 곳이라 메뉴를 내지 않는다', () => {
    expect(offersCompareBaseChoice('main', 'main')).toBe(false)
  })

  it('한쪽만 origin/ 이 붙어 있어도 같은 브랜치로 본다', () => {
    expect(offersCompareBaseChoice('origin/main', 'main')).toBe(false)
  })
})
