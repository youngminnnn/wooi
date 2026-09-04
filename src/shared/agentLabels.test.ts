import { describe, it, expect } from 'vitest'
import { compactModelLabel, modelLabel } from './agentLabels'
import type { ModelOption } from './types'

const MODELS: ModelOption[] = [
  { id: 'claude-opus-5[1m]', label: 'Opus 5 (1M context)' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }
]

describe('compactModelLabel', () => {
  it('괄호 주석을 가운뎃점 뒤 한 조각으로 접는다', () => {
    expect(compactModelLabel(MODELS, 'claude-opus-5[1m]')).toBe('Opus 5 · 1M')
    // 상태줄이 짧게 적어도 온전한 라벨은 그대로 남아 있어야 한다(칩의 title 이 이것을 쓴다).
    expect(modelLabel(MODELS, 'claude-opus-5[1m]')).toBe('Opus 5 (1M context)')
  })

  it('접미사만 다른 ID 도 같은 모델로 본다', () => {
    expect(compactModelLabel(MODELS, 'claude-opus-5')).toBe('Opus 5 · 1M')
  })

  it('괄호가 없으면 건드리지 않는다', () => {
    expect(compactModelLabel(MODELS, 'claude-sonnet-4-6')).toBe('Sonnet 4.6')
  })

  it('카탈로그에 없는 값은 ID 를 그대로 쓴다', () => {
    expect(compactModelLabel(MODELS, 'some-custom-model')).toBe('some-custom-model')
    expect(compactModelLabel(MODELS, null)).toBe('Default')
  })
})
