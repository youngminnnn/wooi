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

import { AntigravitySessionManager, parseModelsText } from './manager'

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

/**
 * 실물 `agy` 1.1.13 은 **오류에도 exit 0 을 돌려준다.** 그래서 종료 코드로 성공을 판정하면
 * 진단 문장이 그대로 모델 라벨이 되고, 그 값이 `--model` 로 넘어간다.
 */
describe('parseModelsText — 실측 출력', () => {
  it('로그인 전 안내문을 모델로 만들지 않는다', () => {
    // `agy models` (미로그인) 실제 출력. exit code 는 0 이었다.
    expect(
      parseModelsText(
        'Fetching available models...\n' +
          'Error: Please sign in to view available models. Launch the CLI without arguments to sign in.\n'
      )
    ).toEqual([])
  })

  it('--output-format 을 거부한 사용법 출력도 걸러낸다', () => {
    // `agy models --output-format json` 실제 출력(upstream #777 이 실측대로였다). exit code 0.
    expect(
      parseModelsText(
        'Usage: agy models [flags]\n\nList available models\n\nFlags:\n  -h      Show help\n' +
          '  --help  Show help\nError: flags provided but not defined: -output-format\n'
      )
    ).toEqual([])
  })

  it('모델 라벨은 원문 그대로 남긴다', () => {
    expect(parseModelsText('Gemini 3.1 Pro (High)\n* Gemini 3.6 Flash (High)\n')).toEqual([
      { id: 'Gemini 3.1 Pro (High)', label: 'Gemini 3.1 Pro (High)' },
      { id: 'Gemini 3.6 Flash (High)', label: 'Gemini 3.6 Flash (High)' }
    ])
  })
})
