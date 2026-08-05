import { describe, expect, it } from 'vitest'
import { UNDO_CREATE_WINDOW_MS, undoCreateVerdict } from './undoCreate'

const NOW = 1_700_000_000_000
const fresh = { workspaceId: 'w1', name: 'brave-otter', at: NOW - 1000 }
const untouched = { archived: false, sessionId: null, status: 'idle', prNumber: null }
const clean = { changedFiles: 0, ahead: 0 }

describe('undoCreateVerdict', () => {
  it('막 만든 빈 워크스페이스는 묻지 않고 되돌린다', () => {
    expect(undoCreateVerdict(fresh, untouched, clean, NOW)).toBe('undo')
  })

  it('git 상태를 아직 못 읽었어도 되돌릴 수 있다', () => {
    expect(undoCreateVerdict(fresh, untouched, undefined, NOW)).toBe('undo')
    expect(undoCreateVerdict(fresh, untouched, null, NOW)).toBe('undo')
  })

  it('되돌릴 생성이 없으면 아무 일도 하지 않는다', () => {
    expect(undoCreateVerdict(null, untouched, clean, NOW)).toBe('nothing')
  })

  it('이미 사라졌거나 아카이브된 워크스페이스는 대상이 아니다', () => {
    expect(undoCreateVerdict(fresh, undefined, clean, NOW)).toBe('nothing')
    expect(undoCreateVerdict(fresh, { ...untouched, archived: true }, clean, NOW)).toBe('nothing')
  })

  it('되돌리기 창이 지나면 조용히 지우지 않는다', () => {
    const old = { ...fresh, at: NOW - UNDO_CREATE_WINDOW_MS - 1 }
    expect(undoCreateVerdict(old, untouched, clean, NOW)).toBe('nothing')
    // 경계 안쪽은 아직 유효하다.
    expect(
      undoCreateVerdict({ ...fresh, at: NOW - UNDO_CREATE_WINDOW_MS }, untouched, clean, NOW)
    ).toBe('undo')
  })

  it('쓴 흔적이 있으면 확인을 거친다', () => {
    // 세션이 붙었다 = 에이전트가 한 번이라도 돌았다.
    expect(undoCreateVerdict(fresh, { ...untouched, sessionId: 's1' }, clean, NOW)).toBe('confirm')
    expect(undoCreateVerdict(fresh, { ...untouched, status: 'running' }, clean, NOW)).toBe(
      'confirm'
    )
    expect(undoCreateVerdict(fresh, { ...untouched, prNumber: 12 }, clean, NOW)).toBe('confirm')
    expect(undoCreateVerdict(fresh, untouched, { changedFiles: 2, ahead: 0 }, NOW)).toBe('confirm')
    expect(undoCreateVerdict(fresh, untouched, { changedFiles: 0, ahead: 1 }, NOW)).toBe('confirm')
  })
})
