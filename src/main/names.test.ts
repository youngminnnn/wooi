import { describe, it, expect, vi, afterEach } from 'vitest'
import { generateWorkspaceName } from './names'

describe('generateWorkspaceName', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('빈 집합에서는 "형용사-동물" 형태의 이름을 만든다', () => {
    const name = generateWorkspaceName(new Set())
    expect(name).toMatch(/^[a-z]+-[a-z]+$/)
  })

  it('기존 이름과 겹치지 않는 이름을 반환한다', () => {
    const existing = new Set<string>()
    for (let i = 0; i < 100; i++) {
      const name = generateWorkspaceName(existing)
      expect(existing.has(name)).toBe(false)
      existing.add(name)
    }
    // 100 개를 뽑는 동안 중복이 하나도 없어야 한다.
    expect(existing.size).toBe(100)
  })

  it('형용사-동물 후보가 계속 충돌하면 workspace-N 으로 폴백한다', () => {
    // Math.random 을 0 으로 고정하면 pick() 은 항상 첫 항목을 골라 같은 후보만 낸다.
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const firstCombo = generateWorkspaceName(new Set())

    // 그 유일한 후보가 이미 점유돼 있으면 50 번 시도가 모두 충돌 → 폴백한다.
    const name = generateWorkspaceName(new Set([firstCombo]))
    expect(name).toBe('workspace-1')
  })

  it('폴백 시 이미 쓰인 workspace-N 번호는 건너뛴다', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const firstCombo = generateWorkspaceName(new Set())

    const name = generateWorkspaceName(new Set([firstCombo, 'workspace-1', 'workspace-2']))
    expect(name).toBe('workspace-3')
  })
})
