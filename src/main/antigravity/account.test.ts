import { describe, expect, it } from 'vitest'
import { usageWindowLabel } from './account'

describe('usageWindowLabel', () => {
  it('실측 usage payload의 그룹과 window로 짧은 라벨을 만든다', () => {
    const groups = [
      {
        name: 'Gemini Models',
        description: 'Models within this group: Gemini Flash, Gemini Pro',
        buckets: [
          { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly' },
          { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h' }
        ]
      },
      {
        name: 'Claude and GPT models',
        buckets: [
          { id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly' },
          { id: '3p-5h', name: 'Five Hour Limit Remaining', window: '5h' }
        ]
      }
    ]

    expect(
      groups.flatMap((group) => group.buckets.map((bucket) => usageWindowLabel(group.name, bucket)))
    ).toEqual(['Gemini · Weekly', 'Gemini · 5h', 'Claude and GPT · Weekly', 'Claude and GPT · 5h'])
  })

  it('모르는 window는 원문을 쓰고 window가 없으면 bucket 이름으로 돌아간다', () => {
    expect(usageWindowLabel(undefined, { name: 'Daily Limit Remaining', window: '24h' })).toBe(
      '24h'
    )
    expect(usageWindowLabel('Other Models', { name: 'Daily Limit Remaining' })).toBe(
      'Other · Daily Limit Remaining'
    )
  })
})
