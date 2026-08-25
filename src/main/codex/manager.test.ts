import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppState, ModelOption, Workspace } from '@shared/types'
import { DEFAULT_SETTINGS, EMPTY_STATE } from '../storeSchema'

const state = vi.hoisted(() => ({ value: null as AppState | null }))
const update = vi.hoisted(() =>
  vi.fn((mutate: (value: AppState) => void) => mutate(state.value as AppState))
)
const info = vi.hoisted(() => vi.fn())
const transcriptUpsert = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  Notification: class {},
  utilityProcess: { fork: vi.fn() }
}))
vi.mock('../store', () => ({
  getStore: () => ({ getState: () => state.value, update })
}))
vi.mock('../transcripts', () => ({ getTranscripts: () => ({ upsert: transcriptUpsert }) }))
vi.mock('../logger', () => ({ log: { error: vi.fn(), info } }))
vi.mock('../rateLimitResume', () => ({
  RATE_LIMIT_CONTINUATION: '',
  RateLimitResumeCoordinator: class {
    restore(): void {}
    cancel(): void {}
  }
}))

import { CODEX_ACCOUNT_CONFIG_COMMANDS, CodexSessionManager, parseReviewTarget } from './manager'

describe('Codex account/configuration command catalog', () => {
  it('advertises every locally handled account/configuration command exactly once', () => {
    expect(CODEX_ACCOUNT_CONFIG_COMMANDS.map((command) => command.name)).toEqual([
      'logout',
      'debug-config',
      'plugins',
      'experimental'
    ])
  })
})

function workspace(
  id: string,
  agentBackend: 'codex' | 'claude',
  model: string | null,
  worktreePath = '/tmp/worktree'
): Workspace {
  return {
    id,
    agentBackend,
    model,
    worktreePath,
    permissionMode: 'default',
    status: 'idle'
  } as Workspace
}

function resetState(workspaces: Workspace[], codexModel: string | null = null): void {
  state.value = {
    ...structuredClone(EMPTY_STATE),
    workspaces,
    settings: structuredClone(DEFAULT_SETTINGS)
  }
  state.value.settings.agents.codex.model = codexModel
}

function managerWith(result: ModelOption[] | Error): {
  manager: CodexSessionManager
  dispatch: ReturnType<typeof vi.fn>
} {
  const dispatch = vi.fn()
  const manager = new CodexSessionManager(dispatch, () => null)
  const request = vi.spyOn(
    manager as unknown as { request: () => Promise<ModelOption[]> },
    'request'
  )
  if (result instanceof Error) request.mockRejectedValue(result)
  else request.mockResolvedValue(result)
  return { manager, dispatch }
}

describe('Codex model catalog reconciliation', () => {
  beforeEach(() => {
    update.mockClear()
    info.mockClear()
  })

  it('카탈로그에서 사라진 Codex workspace 모델을 null로 되돌린다', async () => {
    resetState([workspace('codex-old', 'codex', 'gpt-retired')])
    const { manager, dispatch } = managerWith([{ id: 'gpt-current', label: 'Current' }])

    await manager.listModels()

    expect(state.value?.workspaces[0].model).toBeNull()
    expect(dispatch).toHaveBeenCalledOnce()
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('gpt-retired for workspace codex-old')
    )
  })

  it('카탈로그에 남은 Codex workspace 모델은 유지한다', async () => {
    resetState([workspace('codex-current', 'codex', 'gpt-current')])
    const { manager, dispatch } = managerWith([{ id: 'gpt-current', label: 'Current' }])

    await manager.listModels()

    expect(state.value?.workspaces[0].model).toBe('gpt-current')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('빈 카탈로그는 알 수 없는 상태로 보고 아무것도 지우지 않는다', async () => {
    resetState([workspace('codex-old', 'codex', 'gpt-retired')], 'gpt-retired')
    const { manager, dispatch } = managerWith([])

    await manager.listModels()

    expect(state.value?.workspaces[0].model).toBe('gpt-retired')
    expect(state.value?.settings.agents.codex.model).toBe('gpt-retired')
    expect(update).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('카탈로그 요청 실패는 저장값을 건드리지 않고 그대로 전파한다', async () => {
    resetState([workspace('codex-old', 'codex', 'gpt-retired')], 'gpt-retired')
    const { manager, dispatch } = managerWith(new Error('not ready'))

    await expect(manager.listModels()).rejects.toThrow('not ready')

    expect(state.value?.workspaces[0].model).toBe('gpt-retired')
    expect(state.value?.settings.agents.codex.model).toBe('gpt-retired')
    expect(update).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('같은 모델 문자열을 가진 Claude workspace는 건드리지 않는다', async () => {
    resetState([workspace('claude-old', 'claude', 'gpt-retired')])
    const { manager } = managerWith([{ id: 'gpt-current', label: 'Current' }])

    await manager.listModels()

    expect(state.value?.workspaces[0].model).toBe('gpt-retired')
  })

  it('Codex 설정 기본값도 같은 규칙으로 조정하고 Claude 설정은 유지한다', async () => {
    resetState([], 'gpt-retired')
    const claudeModel = state.value?.settings.agents.claude.model
    const { manager, dispatch } = managerWith([{ id: 'gpt-current', label: 'Current' }])

    await manager.listModels()

    expect(state.value?.settings.agents.codex.model).toBeNull()
    expect(state.value?.settings.agents.claude.model).toBe(claudeModel)
    expect(dispatch).toHaveBeenCalledOnce()
  })
})

describe('Codex slash command dispatch', () => {
  beforeEach(() => {
    transcriptUpsert.mockClear()
    resetState([workspace('ws1', 'codex', null)])
  })

  function captureSend(manager: CodexSessionManager): ReturnType<typeof vi.fn> {
    return vi
      .spyOn(manager as unknown as { send: (command: unknown) => void }, 'send')
      .mockImplementation(() => {})
  }

  it.each([
    ['/compact', 'compact'],
    ['/review', 'review'],
    ['/review base main', 'review']
  ])('keeps supported command %s on its control path', (input, type) => {
    const dispatch = vi.fn()
    const manager = new CodexSessionManager(dispatch, () => null)
    const send = captureSend(manager)

    manager.sendMessage('ws1', input)

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type, workspaceId: 'ws1' }))
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('intercepts an unknown command instead of sending it to the model', () => {
    const dispatch = vi.fn()
    const manager = new CodexSessionManager(dispatch, () => null)
    const send = captureSend(manager)

    manager.sendMessage('ws1', '/definitely-not-a-command arg')

    expect(send).not.toHaveBeenCalled()
    expect(transcriptUpsert).toHaveBeenCalledWith(
      'ws1',
      expect.objectContaining({ type: 'system', text: expect.stringContaining('Unknown') })
    )
    expect(dispatch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ workspaceId: 'ws1' })
    )
  })

  it('does not block prose that merely contains slashes', () => {
    const manager = new CodexSessionManager(vi.fn(), () => null)
    const send = captureSend(manager)

    manager.sendMessage('ws1', 'Please inspect src/main/codex/manager.ts before answering.')

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'send' }))
  })

  it('keeps a resolved installed skill command working before unknown interception', () => {
    const manager = new CodexSessionManager(vi.fn(), () => null)
    const send = captureSend(manager)
    const skills = (manager as unknown as { skills: { resolved: Map<string, unknown[]> } }).skills
    skills.resolved.set('/tmp/worktree', [
      {
        name: 'my-skill',
        path: '/skills/my-skill/SKILL.md',
        description: 'test',
        scope: 'user',
        enabled: true
      }
    ])

    manager.sendMessage('ws1', '/my-skill target')

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'send',
        skill: expect.objectContaining({ name: 'my-skill' })
      })
    )
  })
})

describe('/review target parsing', () => {
  it('supports uncommitted changes, a base branch, and a commit', () => {
    expect(parseReviewTarget('/review')).toEqual({ type: 'uncommittedChanges' })
    expect(parseReviewTarget('/review base origin/main')).toEqual({
      type: 'baseBranch',
      branch: 'origin/main'
    })
    expect(parseReviewTarget('/review commit abc123')).toEqual({ type: 'commit', sha: 'abc123' })
  })

  it('rejects ambiguous review arguments so they can be explained instead', () => {
    expect(parseReviewTarget('/review something vague')).toBeNull()
  })
})

describe('Codex local conversation commands', () => {
  beforeEach(() => {
    update.mockClear()
  })

  it('/plan updates the stored permission mode and returns a local result', async () => {
    resetState([workspace('ws-plan', 'codex', null)])
    const dispatch = vi.fn()
    const manager = new CodexSessionManager(dispatch, () => null)

    await expect(manager.runCommand('ws-plan', 'plan')).resolves.toEqual({
      kind: 'plan',
      permissionMode: 'plan'
    })
    expect(state.value?.workspaces[0].permissionMode).toBe('plan')
  })

  it('/status combines the host thread snapshot with stored plan usage', async () => {
    resetState([workspace('ws-status', 'codex', 'gpt-test')])
    const usage = {
      fetchedAt: 1,
      available: true,
      subscriptionType: 'pro',
      windows: [{ label: 'Weekly', utilization: 25, resetsAt: null }]
    }
    if (state.value) state.value.rateLimitsByAgent = { codex: usage }
    const manager = new CodexSessionManager(vi.fn(), () => null)
    vi.spyOn(
      manager as unknown as { request: () => Promise<unknown> },
      'request'
    ).mockResolvedValue({
      kind: 'status',
      status: {
        live: true,
        account: {},
        outputStyle: null,
        fastMode: null,
        sessionId: null,
        workspace: {
          model: 'gpt-test',
          cwd: '/tmp/worktree',
          effort: null,
          fastMode: false,
          permissionMode: 'default'
        },
        context: null,
        usage: null
      }
    })

    await expect(manager.runCommand('ws-status', 'status')).resolves.toMatchObject({
      kind: 'status',
      status: { workspace: { model: 'gpt-test' }, usage }
    })
  })

  it('/init creates an AGENTS.md scaffold once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wooi-init-'))
    try {
      resetState([workspace('ws-init', 'codex', null, root)])
      const manager = new CodexSessionManager(vi.fn(), () => null)

      await expect(manager.runCommand('ws-init', 'init')).resolves.toMatchObject({
        kind: 'init',
        created: true,
        path: join(root, 'AGENTS.md')
      })
      expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toContain('# AGENTS.md')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('/init never overwrites an existing AGENTS.md', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wooi-init-existing-'))
    const path = join(root, 'AGENTS.md')
    try {
      writeFileSync(path, 'keep me\n')
      resetState([workspace('ws-init-existing', 'codex', null, root)])
      const manager = new CodexSessionManager(vi.fn(), () => null)

      await expect(manager.runCommand('ws-init-existing', 'init')).resolves.toEqual({
        kind: 'init',
        created: false,
        path
      })
      expect(readFileSync(path, 'utf8')).toBe('keep me\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
