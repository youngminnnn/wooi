import { describe, expect, it } from 'vitest'
import type { ChatItem } from '@shared/types'
import { compactHistoryWindow } from './compactHistory'

const system = (id: string): ChatItem => ({ id, type: 'system', text: id, ts: 1 })

describe('compactHistoryWindow', () => {
  it('마지막 압축 경계를 선택한다', () => {
    const items: ChatItem[] = [
      system('old'),
      { id: 'c1', type: 'compaction', trigger: 'auto', ts: 2 },
      system('middle'),
      { id: 'c2', type: 'compaction', trigger: 'auto', ts: 3 },
      system('new')
    ]
    expect(compactHistoryWindow(items)).toEqual({ boundaryIndex: 3, boundary: items[3] })
  })

  it('경계가 없으면 기존 전체 기록을 유지한다', () => {
    expect(compactHistoryWindow([system('one')])).toEqual({ boundaryIndex: -1 })
  })
})
