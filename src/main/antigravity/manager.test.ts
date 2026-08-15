import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Workspace } from '@shared/types'

const fixture = vi.hoisted(() => {
  const workspace = {
    id: 'ws-1',
    worktreePath: '/tmp/worktree',
    sessionId: 'conversation-1',
    permissionMode: 'default',
    model: null,
    effort: null,
    additionalDirs: [],
    status: 'idle',
    lastActiveAt: 0
  } as unknown as Workspace
  const state = { workspaces: [workspace], settings: {}, rateLimitsByAgent: {} }
  return {
    workspace,
    state,
    store: {
      getState: () => state,
      update: (fn: (value: typeof state) => void) => fn(state)
    }
  }
})

vi.mock('electron', () => ({
  Notification: class {
    static isSupported(): boolean {
      return false
    }
  }
}))
vi.mock('../store', () => ({ getStore: () => fixture.store }))
vi.mock('../transcripts', () => ({ getTranscripts: () => ({ upsert: vi.fn() }) }))

import { AntigravitySessionManager } from './manager'

type TestState = {
  conversationId: string | null
  model: null
  effort: null
  permissionMode: 'default'
  extraDirs: string[]
  child: null
  abort: null
  running: boolean
  queue: Array<{ text: string }>
}

describe('AntigravitySessionManager bookkeeping', () => {
  let manager: AntigravitySessionManager
  let state: TestState

  beforeEach(() => {
    fixture.workspace.sessionId = 'conversation-1'
    fixture.workspace.additionalDirs = []
    state = {
      conversationId: 'conversation-1',
      model: null,
      effort: null,
      permissionMode: 'default',
      extraDirs: [],
      child: null,
      abort: null,
      running: false,
      queue: []
    }
    manager = new AntigravitySessionManager(vi.fn(), () => null)
    manager['states'].set(fixture.workspace.id, state)
  })

  it('queues a message while a turn is running', () => {
    state.running = true
    manager.sendMessage(fixture.workspace.id, 'next')
    expect(state.queue).toEqual([{ text: 'next', images: undefined, opts: undefined }])
  })

  it('clearSession drops the conversation id and queued messages', () => {
    state.queue.push({ text: 'queued' })
    manager.clearSession(fixture.workspace.id)
    expect(state.conversationId).toBeNull()
    expect(state.queue).toEqual([])
    expect(fixture.workspace.sessionId).toBeNull()
  })

  it('rejects a relative add-directory path', () => {
    expect(manager.addDirectory(fixture.workspace.id, 'relative/path')).toEqual({
      error: 'Antigravity requires an absolute directory path.'
    })
    expect(state.extraDirs).toEqual([])
  })

  it('recycleAll preserves the conversation id', () => {
    manager.recycleAll()
    expect(state.conversationId).toBe('conversation-1')
  })
})
