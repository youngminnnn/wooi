import { describe, expect, it } from 'vitest'
import { codexGoalTone, goalNeedsAttention } from '../lib/goal'

describe('goal 상태 표현', () => {
  it.each(['blocked', 'usageLimited', 'budgetLimited'] as const)(
    '%s는 진행 중단 상태로 표현한다',
    (status) => {
      expect(
        goalNeedsAttention({
          backend: 'codex',
          objective: 'Finish',
          status,
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0
        })
      ).toBe(true)
      expect(codexGoalTone(status)).not.toBe(codexGoalTone('active'))
    }
  )

  it('active와 Claude iteration은 진행 중단으로 취급하지 않는다', () => {
    expect(
      goalNeedsAttention({
        backend: 'codex',
        objective: 'Finish',
        status: 'active',
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0
      })
    ).toBe(false)
    expect(goalNeedsAttention({ backend: 'claude', condition: 'Finish', iterations: 2 })).toBe(
      false
    )
  })
})
