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

import { AntigravitySessionManager, composeAntigravityPrompt, parseModelsText } from './manager'

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

describe('composeAntigravityPrompt', () => {
  it('첫 턴에는 워크스페이스 문맥과 절대 경로를 넣는다', () => {
    const prompt = composeAntigravityPrompt('Implement it.', '/tmp/worktree', null)
    expect(prompt).toContain('git worktree at /tmp/worktree')
    expect(prompt).toContain('Read CLAUDE.md')
    expect(prompt).toContain('Implement it.')
  })

  it('기존 대화의 후속 턴에는 문맥을 반복하지 않는다', () => {
    expect(composeAntigravityPrompt('Continue.', '/tmp/worktree', 'conversation-1')).toBe(
      'Continue.'
    )
  })

  it('호출자가 준 prefix를 첫 턴 문맥과 함께 보존한다', () => {
    const prompt = composeAntigravityPrompt('Review this.', '/tmp/worktree', null, 'Agent handoff')
    expect(prompt).toContain('git worktree at /tmp/worktree')
    expect(prompt).toContain('\n\nAgent handoff\n\nReview this.')
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

  it('탭으로 나뉜 슬러그와 표시 이름을 갈라 읽는다', () => {
    // 실물 `agy models` 출력. 앞이 --model 에 넘길 값, 뒤가 사람이 읽는 이름이다.
    expect(
      parseModelsText(
        'Fetching available models...\n' +
          'gemini-3.1-pro-high\tGemini 3.1 Pro (High)\n' +
          'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\n'
      )
    ).toEqual([
      { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' },
      { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' }
    ])
  })

  it('한 열짜리 출력은 그대로 id 이자 label 로 쓴다', () => {
    expect(parseModelsText('gemini-3.1-pro-high\n')).toEqual([
      { id: 'gemini-3.1-pro-high', label: 'gemini-3.1-pro-high' }
    ])
  })
})
