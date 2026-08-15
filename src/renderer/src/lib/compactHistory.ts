import type { ChatItem } from '@shared/types'

export interface CompactHistoryWindow {
  boundaryIndex: number
  boundary?: Extract<ChatItem, { type: 'compaction' }>
}

/** 마지막 압축 경계만 찾는다. 호출자는 접힌 동안 이 앞의 항목을 React 트리에 올리지 않는다. */
export function compactHistoryWindow(items: ChatItem[]): CompactHistoryWindow {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.type === 'compaction') return { boundaryIndex: i, boundary: item }
  }
  return { boundaryIndex: -1 }
}
