import { describe, expect, it } from 'vitest'
import {
  announce,
  announceChange,
  announceStateKey,
  newToastMessages,
  subscribeAnnouncements,
  type AnnounceSnapshot,
  type AnnounceState,
  type Announcement
} from './announce'

function snap(state: AnnounceState, overrides: Partial<AnnounceSnapshot> = {}): AnnounceSnapshot {
  return { workspaceId: 'ws-1', workspaceName: 'Fix the toolbar', state, ...overrides }
}

describe('announceChange', () => {
  it('첫 스냅샷은 아무것도 읽지 않는다 — 라이브 리전은 초기 내용을 알리지 않는다', () => {
    expect(announceChange(null, snap({ kind: 'running' }))).toBeNull()
    expect(announceChange(null, snap({ kind: 'awaiting-response' }))).toBeNull()
  })

  describe('같은 상태가 연속으로 오면 두 번 읽히지 않는다', () => {
    // 스토어는 스트리밍 중 초당 여러 번 갱신된다. 이 억제가 없으면 같은 문장이 끝없이 반복된다.
    const states: AnnounceState[] = [
      { kind: 'running' },
      { kind: 'idle' },
      { kind: 'error' },
      { kind: 'interrupted' },
      { kind: 'awaiting-response' },
      { kind: 'awaiting-response', ask: 'Run npm test?' }
    ]
    for (const state of states) {
      it(`${announceStateKey(state)}`, () => {
        expect(announceChange(snap(state), snap(state))).toBeNull()
      })
    }

    it('여러 번 반복해도 계속 침묵한다', () => {
      const prev = snap({ kind: 'running' })
      for (let i = 0; i < 5; i++) expect(announceChange(prev, snap({ kind: 'running' }))).toBeNull()
    })
  })

  it('턴 시작은 polite 로 알린다', () => {
    expect(announceChange(snap({ kind: 'idle' }), snap({ kind: 'running' }))).toEqual<Announcement>(
      {
        politeness: 'polite',
        message: 'Fix the toolbar started running.'
      }
    )
  })

  it('턴 종료(running → idle)는 polite 로 알린다', () => {
    expect(announceChange(snap({ kind: 'running' }), snap({ kind: 'idle' }))).toEqual<Announcement>(
      {
        politeness: 'polite',
        message: 'Fix the toolbar finished.'
      }
    )
  })

  it('running 을 거치지 않은 idle 은 알리지 않는다 — 끝난 턴이 없으므로 알릴 사건이 아니다', () => {
    expect(announceChange(snap({ kind: 'error' }), snap({ kind: 'idle' }))).toBeNull()
    expect(announceChange(snap({ kind: 'interrupted' }), snap({ kind: 'idle' }))).toBeNull()
  })

  it('응답 대기는 assertive 로, 무엇을 묻는지까지 읽는다', () => {
    expect(
      announceChange(
        snap({ kind: 'running' }),
        snap({ kind: 'awaiting-response', ask: 'Run npm test?' })
      )
    ).toEqual<Announcement>({
      politeness: 'assertive',
      message: 'Fix the toolbar needs your input: Run npm test?'
    })
  })

  it('묻는 내용이 없으면 일반 문구로 물러선다', () => {
    expect(
      announceChange(snap({ kind: 'running' }), snap({ kind: 'awaiting-response' }))
    ).toEqual<Announcement>({
      politeness: 'assertive',
      message: 'Fix the toolbar needs your input.'
    })
  })

  it('연달아 다른 것을 물으면 다시 읽는다 — 그건 새 사실이다', () => {
    const first = snap({ kind: 'awaiting-response', ask: 'Run npm test?' })
    const second = snap({ kind: 'awaiting-response', ask: 'Delete build/?' })
    expect(announceChange(first, second)?.message).toBe(
      'Fix the toolbar needs your input: Delete build/?'
    )
  })

  it('오류와 중단은 assertive 다', () => {
    expect(
      announceChange(snap({ kind: 'running' }), snap({ kind: 'error' }))
    ).toEqual<Announcement>({
      politeness: 'assertive',
      message: 'Fix the toolbar stopped with an error.'
    })
    expect(
      announceChange(snap({ kind: 'running' }), snap({ kind: 'interrupted' }))
    ).toEqual<Announcement>({
      politeness: 'assertive',
      message: 'Fix the toolbar was stopped before finishing.'
    })
  })

  describe('워크스페이스를 갈아탔을 때', () => {
    const other = { workspaceId: 'ws-2', workspaceName: 'Ship the release' }

    it('행동이 필요 없는 상태는 알리지 않는다 — 목록을 훑는 내내 따라다니면 잡음이다', () => {
      expect(announceChange(snap({ kind: 'running' }), snap({ kind: 'running' }, other))).toBeNull()
      expect(announceChange(snap({ kind: 'running' }), snap({ kind: 'idle' }, other))).toBeNull()
      expect(
        announceChange(snap({ kind: 'idle' }), snap({ kind: 'interrupted' }, other))
      ).toBeNull()
    })

    it('응답 대기와 오류는 지금 행동해야 할 사실이라 알린다', () => {
      expect(
        announceChange(snap({ kind: 'idle' }), snap({ kind: 'awaiting-response' }, other))?.message
      ).toBe('Ship the release needs your input.')
      expect(announceChange(snap({ kind: 'idle' }), snap({ kind: 'error' }, other))?.message).toBe(
        'Ship the release stopped with an error.'
      )
    })

    it('같은 상태여도 워크스페이스가 다르면 억제 대상이 아니다', () => {
      const state: AnnounceState = { kind: 'awaiting-response', ask: 'Run npm test?' }
      expect(announceChange(snap(state), snap(state, other))?.message).toBe(
        'Ship the release needs your input: Run npm test?'
      )
    })
  })
})

describe('newToastMessages', () => {
  it('아직 읽지 않은 토스트의 문장만 돌려준다', () => {
    expect(
      newToastMessages(new Set(['a']), [
        { id: 'a', message: 'Restored 2 workspaces.' },
        { id: 'b', message: 'Nothing to undo.' }
      ])
    ).toEqual(['Nothing to undo.'])
  })

  it('전부 읽었으면 빈 배열이다', () => {
    expect(newToastMessages(new Set(['a', 'b']), [{ id: 'a', message: 'x' }])).toEqual([])
  })

  it('문장이 같아도 새 토스트면 돌려준다 — 억제는 DOM 층이 맡는다', () => {
    expect(
      newToastMessages(new Set(['a']), [
        { id: 'a', message: 'Nothing to undo.' },
        { id: 'b', message: 'Nothing to undo.' }
      ])
    ).toEqual(['Nothing to undo.'])
  })
})

describe('announce 버스', () => {
  it('구독자에게 문장과 politeness 를 그대로 전한다', () => {
    const seen: Announcement[] = []
    const off = subscribeAnnouncements((a) => seen.push(a))
    announce('Something broke in Settings.', 'assertive')
    off()
    announce('after unsubscribe', 'assertive')
    expect(seen).toEqual([{ message: 'Something broke in Settings.', politeness: 'assertive' }])
  })

  it('빈 문장은 흘리지 않는다', () => {
    const seen: Announcement[] = []
    const off = subscribeAnnouncements((a) => seen.push(a))
    announce('', 'assertive')
    off()
    expect(seen).toEqual([])
  })
})
