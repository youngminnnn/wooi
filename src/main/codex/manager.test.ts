import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState, ModelOption, Workspace } from '@shared/types'
import { DEFAULT_SETTINGS, EMPTY_STATE } from '../storeSchema'

const state = vi.hoisted(() => ({ value: null as AppState | null }))
const update = vi.hoisted(() =>
  vi.fn((mutate: (value: AppState) => void) => mutate(state.value as AppState))
)
const info = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  Notification: class {},
  utilityProcess: { fork: vi.fn() }
}))
vi.mock('../store', () => ({
  getStore: () => ({ getState: () => state.value, update })
}))
vi.mock('../logger', () => ({ log: { error: vi.fn(), info } }))
vi.mock('../rateLimitResume', () => ({
  RATE_LIMIT_CONTINUATION: '',
  RateLimitResumeCoordinator: class {
    restore(): void {}
  }
}))

import { CodexSessionManager } from './manager'

function workspace(id: string, agentBackend: 'codex' | 'claude', model: string | null): Workspace {
  return {
    id,
    agentBackend,
    model,
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
