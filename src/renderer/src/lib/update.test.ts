import { describe, expect, it } from 'vitest'
import { RESTART_SETTLE_MS } from '@shared/types'
import type { UpdateStatus } from '@shared/types'
import { scheduledRestartText } from './update'

const ready = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({
  state: 'ready',
  version: '1.9.0',
  ...over
})

describe('scheduledRestartText', () => {
  it('예약이 없으면 빈 문자열', () => {
    expect(scheduledRestartText(ready(), 0)).toBe('')
  })

  it('아직 다운로드 중이면 다운로드와 작업을 함께 기다린다고 알린다', () => {
    const text = scheduledRestartText(
      { state: 'downloading', percent: 40, restartWhenIdle: true },
      0
    )
    expect(text).toContain('download')
  })

  it('진행 중인 작업 수를 그대로 보여 준다(단수/복수)', () => {
    expect(scheduledRestartText(ready({ restartWhenIdle: true, busyCount: 1 }), 0)).toContain(
      '1 running task'
    )
    expect(scheduledRestartText(ready({ restartWhenIdle: true, busyCount: 3 }), 0)).toContain(
      '3 running tasks'
    )
  })

  it('카운트다운이 시작되면 남은 초를 보여 준다', () => {
    const now = 10_000
    const status = ready({ restartWhenIdle: true, busyCount: 0, restartAt: now + 12_400 })
    expect(scheduledRestartText(status, now)).toBe('All work finished — restarting in 13s.')
  })

  it('now 가 한 박자 늦어도 유예 길이를 넘겨 표시하지 않는다', () => {
    // restartAt 이 막 정해진 순간의 첫 렌더 — 마운트 때의 now 는 한참 과거일 수 있다.
    const status = ready({ restartWhenIdle: true, restartAt: 5_000_000 })
    expect(scheduledRestartText(status, 0)).toBe(
      `All work finished — restarting in ${RESTART_SETTLE_MS / 1000}s.`
    )
  })

  it('지난 시각은 0s 로 바닥을 친다', () => {
    const status = ready({ restartWhenIdle: true, restartAt: 1_000 })
    expect(scheduledRestartText(status, 9_000)).toBe('All work finished — restarting in 0s.')
  })
})
