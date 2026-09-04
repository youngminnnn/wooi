import { describe, it, expect } from 'vitest'
import type { StackOpProgress, StackSyncPlan } from '@shared/types'
import { rebaseShortcutGate, upToDateWithBase } from './rebaseGate'
import { git, workspace } from '../test/fixtures'

function progress(overrides: Partial<StackOpProgress> = {}): StackOpProgress {
  return {
    workspaceId: 'workspace-1',
    kind: 'restack',
    startedAt: 1,
    current: null,
    done: [],
    total: 1,
    finished: false,
    ...overrides
  } as StackOpProgress
}

describe('upToDateWithBase', () => {
  it('behind 가 0 이라도 PR 이 base 갱신을 요구하면 최신이 아니다', () => {
    expect(upToDateWithBase(git({ behind: 0 }))).toBe(true)
    expect(upToDateWithBase(git({ behind: 0 }), true)).toBe(false)
    expect(upToDateWithBase(git({ behind: 3 }))).toBe(false)
  })
})

describe('rebaseShortcutGate', () => {
  const behind = git({ behind: 2 })

  it('뒤처졌고 다른 사정이 없으면 통과시킨다', () => {
    expect(rebaseShortcutGate({ workspace: workspace(), git: behind, progress: null })).toEqual({
      ok: true
    })
  })

  it('git 상태를 아직 못 읽었으면 막는다', () => {
    const gate = rebaseShortcutGate({ workspace: workspace(), git: null, progress: null })
    expect(gate.ok).toBe(false)
  })

  it('이미 rebase 중이면 막는다', () => {
    const gate = rebaseShortcutGate({
      workspace: workspace(),
      git: behind,
      progress: progress()
    })
    expect(gate).toEqual({ ok: false, message: 'This workspace is already rebasing.' })
  })

  it('끝난 진행 표시는 막지 않는다', () => {
    const gate = rebaseShortcutGate({
      workspace: workspace(),
      git: behind,
      progress: progress({ finished: true })
    })
    expect(gate).toEqual({ ok: true })
  })

  it('충돌이 남아 있으면 막는다', () => {
    const gate = rebaseShortcutGate({
      workspace: workspace(),
      git: git({ behind: 2, conflicted: true }),
      progress: null
    })
    expect(gate).toEqual({ ok: false, message: 'Resolve the conflicts in this worktree first.' })
  })

  it('승인 대기 중인 스택 동기화가 있으면 배너로 보낸다', () => {
    const gate = rebaseShortcutGate({
      workspace: workspace({ stackSync: {} as StackSyncPlan }),
      git: behind,
      progress: null
    })
    expect(gate).toEqual({
      ok: false,
      message: 'A stack update is waiting for your approval in the banner.'
    })
  })

  it('이미 최신이면 base 이름과 함께 막는다 — idle restack 은 force-push 만 남긴다', () => {
    const gate = rebaseShortcutGate({
      workspace: workspace({ baseBranch: 'main' }),
      git: git({ behind: 0 }),
      progress: null
    })
    expect(gate).toEqual({ ok: false, message: 'Already up to date with main.' })
  })

  it('behind 가 0 이어도 PR 이 base 갱신을 요구하면 통과시킨다', () => {
    const gate = rebaseShortcutGate({
      workspace: workspace(),
      git: git({ behind: 0 }),
      progress: null,
      prNeedsBaseUpdate: true
    })
    expect(gate).toEqual({ ok: true })
  })
})
