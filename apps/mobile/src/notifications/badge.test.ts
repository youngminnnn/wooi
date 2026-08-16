import { describe, expect, it } from 'vitest'
import type { RemoteState, RemoteWorkspace } from '@shared/remote'
import { attentionCount } from './badge'

function workspace(overrides: Partial<RemoteWorkspace> & { id: string }): RemoteWorkspace {
  return {
    repoId: 'repo',
    name: overrides.id,
    displayName: null,
    branch: 'feat/x',
    status: 'idle',
    permissionMode: 'default',
    model: null,
    effort: null,
    archived: false,
    muted: false,
    prNumber: null,
    lastActiveAt: 0,
    attention: null,
    ...overrides
  }
}

function state(workspaces: RemoteWorkspace[]): RemoteState {
  return {
    rev: 1,
    machine: { id: 'machine', name: 'Laptop', appVersion: '1.0.0' },
    repos: [{ id: 'repo', name: 'wooi' }],
    workspaces,
    pendingPermissions: []
  }
}

describe('attentionCount', () => {
  it('상태가 없으면 0 이다', () => {
    expect(attentionCount(null)).toBe(0)
  })

  it('미확인과 권한 대기를 함께 센다', () => {
    expect(
      attentionCount(
        state([
          workspace({ id: 'a', unread: true }),
          workspace({ id: 'b', attention: 'permission' }),
          workspace({ id: 'c' })
        ])
      )
    ).toBe(2)
  })

  it('한 워크스페이스가 둘 다여도 하나로 센다 — 배지는 "봐야 할 곳"의 수다', () => {
    expect(attentionCount(state([workspace({ id: 'a', unread: true, attention: 'permission' })]))).toBe(1)
  })

  it('음소거와 아카이브는 빼며, 데스크톱 Dock 배지와 같은 규칙이다', () => {
    expect(
      attentionCount(
        state([
          workspace({ id: 'a', unread: true, muted: true }),
          workspace({ id: 'b', attention: 'permission', muted: true }),
          workspace({ id: 'c', unread: true, archived: true })
        ])
      )
    ).toBe(0)
  })

  it('에러는 따로 세지 않는다 — 미확인이 이미 포함하고, 읽어도 사라지지 않는다', () => {
    expect(attentionCount(state([workspace({ id: 'a', status: 'error', attention: 'error' })]))).toBe(0)
  })

  it('unread 를 보내지 않는 구형 랩탑은 세지 않는다', () => {
    expect(attentionCount(state([workspace({ id: 'a' })]))).toBe(0)
  })
})
