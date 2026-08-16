import { describe, expect, it } from 'vitest'
import type { PrStatus } from '@shared/types'
import { forgetPrStatus, getCachedPrStatus, rememberPrStatus } from './prStatusCache'

const status = (over: Partial<PrStatus> = {}): PrStatus => ({
  number: 7,
  url: 'https://example/pr/7',
  title: 'Fix login',
  state: 'open',
  label: 'Open',
  needsBaseUpdate: false,
  ...over
})

describe('PR 상태 캐시', () => {
  it('폰이 보는 값이 바뀌었을 때만 바뀌었다고 답한다', () => {
    // 부르는 쪽(ipc 의 prStatus 핸들러)은 이 답으로 상태를 방송할지 정한다. 폴링마다
    // 방송하면 아무것도 바꾸지 못하는 방송이 워크스페이스 수만큼 반복된다.
    forgetPrStatus('ws')

    // 처음 알게 된 것은 언제나 새 소식이다 — "모른다"와 "PR 이 없다"는 폰에서 다른 화면이다.
    expect(rememberPrStatus('ws', null)).toBe(true)
    expect(rememberPrStatus('ws', null)).toBe(false)

    expect(rememberPrStatus('ws', status())).toBe(true)
    expect(rememberPrStatus('ws', status())).toBe(false)

    // 제목은 표시 이름이다 — 제목만 바뀌어도 폰의 워크스페이스 이름이 낡는다.
    expect(rememberPrStatus('ws', status({ title: 'Fix login redirect' }))).toBe(true)
    expect(rememberPrStatus('ws', status({ state: 'approved', label: 'Ready to merge' }))).toBe(
      true
    )

    // 투영되지 않는 필드는 방송할 이유가 없다.
    expect(rememberPrStatus('ws', status({ state: 'approved', label: 'Ready to merge' }))).toBe(
      false
    )
    expect(
      rememberPrStatus(
        'ws',
        status({ state: 'approved', label: 'Ready to merge', url: 'https://example/pr/7?x=1' })
      )
    ).toBe(false)

    expect(rememberPrStatus('ws', null)).toBe(true)
    expect(getCachedPrStatus('ws')).toBeNull()
  })
})
