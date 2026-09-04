import { describe, it, expect } from 'vitest'
import { fastModeStatus } from './fastMode'

describe('fastModeStatus', () => {
  it('꺼져 있으면 말할 것이 없다 — 상태줄은 아이콘만 남긴다', () => {
    const off = fastModeStatus(false, null, null)
    expect(off.text).toBe('Standard')
    expect(off.notable).toBe(false)
  })

  it('평소와 다른 상태는 전부 글자로 말한다', () => {
    expect(fastModeStatus(true, null, null).notable).toBe(true)
    expect(fastModeStatus(true, 'on', null).notable).toBe(true)
    expect(fastModeStatus(true, 'cooldown', null).notable).toBe(true)
    // 켜 뒀는데 실제로는 안 도는 경우 — 이건 특히 말해 줘야 한다.
    expect(fastModeStatus(true, 'off', null).notable).toBe(true)
  })
})
