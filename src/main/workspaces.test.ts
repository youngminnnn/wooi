import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from './storeSchema'
import {
  createWorkspace,
  findWorkspaceForPr,
  runArchiveScript,
  shouldSkipPrSetup,
  workspaceForkError
} from './workspaces'
import type { RunOnceResult } from './scripts'
import type { AppState, Repo, Workspace } from '@shared/types'

describe('findWorkspaceForPr', () => {
  const workspace = (id: string, repoId: string, prNumber: number | null, archived: boolean) =>
    ({ id, repoId, prNumber, archived }) as Workspace
  const workspaces = [
    workspace('open', 'repo-1', 7, false),
    workspace('archived', 'repo-1', 8, true),
    workspace('other-repo', 'repo-2', 7, false)
  ]

  it('열린 워크스페이스를 찾는다', () => {
    expect(findWorkspaceForPr(workspaces, 'repo-1', 7)).toMatchObject({
      id: 'open',
      archived: false
    })
  })

  it('아카이브된 워크스페이스도 찾는다', () => {
    expect(findWorkspaceForPr(workspaces, 'repo-1', 8)).toMatchObject({
      id: 'archived',
      archived: true
    })
  })

  it('같은 리포·PR 조합이 없으면 undefined 다', () => {
    expect(findWorkspaceForPr(workspaces, 'repo-1', 9)).toBeUndefined()
  })
})

describe('PR setup auto-run decision', () => {
  it.each([
    ['normal workspace', null, 'me', false],
    ['same-repo PR', { isCrossRepository: false }, 'me', false],
    ['own fork', { isCrossRepository: true, headRepositoryOwner: { login: 'me' } }, 'me', false],
    [
      "someone else's fork",
      { isCrossRepository: true, headRepositoryOwner: { login: 'other' } },
      'me',
      true
    ],
    ['fork with no viewer', { isCrossRepository: true, headRepositoryOwner: 'me' }, null, true]
  ] as const)('%s', (_name, pr, viewer, expected) => {
    expect(shouldSkipPrSetup(pr, viewer)).toBe(expected)
  })
})

const mocks = vi.hoisted(() => ({
  state: null as AppState | null,
  addWorktree: vi.fn(),
  applySnapshot: vi.fn(),
  revParse: vi.fn(),
  snapshotWorkingTree: vi.fn(),
  syncGhMergeBase: vi.fn(async () => undefined),
  transcriptCopy: vi.fn(),
  transcriptUpsert: vi.fn()
}))

vi.mock('./store', () => ({
  getStore: () => ({
    getState: () => mocks.state,
    update: (mutate: (state: AppState) => void) => mutate(mocks.state!)
  })
}))
vi.mock('./git', () => ({
  addWorktree: mocks.addWorktree,
  applySnapshot: mocks.applySnapshot,
  removeWorktree: vi.fn(),
  resolveUniqueWorktree: vi.fn(async (_repo: string, name: string) => ({
    branch: name,
    worktreePath: `/tmp/${name}`
  })),
  revParse: mocks.revParse,
  snapshotWorkingTree: mocks.snapshotWorkingTree,
  syncGhMergeBase: mocks.syncGhMergeBase
}))
vi.mock('./carry', () => ({
  applyCarryExcludes: vi.fn(),
  carryIntoWorktree: vi.fn(() => ({ carried: [], missing: [], failures: [] })),
  detectCarryItems: vi.fn(() => []),
  isAgentContextPath: vi.fn(() => false)
}))
vi.mock('./net', () => ({ findFreePort: vi.fn(async () => 3100) }))
vi.mock('./transcripts', () => ({
  getTranscripts: () => ({ copy: mocks.transcriptCopy, upsert: mocks.transcriptUpsert })
}))

const repo = (): Repo => ({
  id: 'repo-1',
  name: 'repo',
  path: '/tmp/repo',
  defaultBranch: 'main',
  setupScript: '',
  runScripts: [],
  archiveScript: '',
  carryItems: [],
  addedAt: 1
})

const source = (overrides: Partial<Workspace> = {}): Workspace =>
  ({
    id: 'source',
    repoId: 'repo-1',
    agentBackend: 'claude',
    multiAgent: true,
    name: 'source',
    displayName: null,
    branch: 'feat/source',
    baseBranch: 'feat/parent',
    parentWorkspaceId: 'parent',
    createdByWorkspaceId: null,
    prNumber: null,
    worktreePath: '/tmp/source',
    ports: {},
    setupState: 'idle',
    sessionId: 'session-source',
    permissionMode: 'bypassPermissions',
    status: 'idle',
    model: 'claude-opus-4-1',
    effort: 'high',
    fastMode: true,
    lastModel: null,
    fastModeState: null,
    fastModeReason: null,
    archived: false,
    createdAt: 1,
    lastActiveAt: 1,
    ...overrides
  }) as Workspace

describe('createWorkspace fork 기반', () => {
  const deps = () => ({
    scripts: { run: vi.fn() } as never,
    broadcastState: vi.fn(),
    forkAgentSession: vi.fn<() => Promise<string | null>>(async () => 'session-fork')
  })

  it('원본과 같은 stack 위치와 설정을 물려받되 독립 브랜치로 만든다', async () => {
    const original = source()
    mocks.state = {
      repos: [repo()],
      workspaces: [original],
      fanoutGroups: [],
      reviews: [],
      settings: structuredClone(DEFAULT_SETTINGS)
    }
    mocks.revParse.mockResolvedValue('abc123')
    mocks.snapshotWorkingTree.mockResolvedValue(null)

    const result = await createWorkspace(deps(), {
      repoId: 'repo-1',
      name: 'fork',
      forkFromWorkspaceId: original.id
    })
    const fork = mocks.state.workspaces.find((w) => w.id === result.workspaceId)!

    expect(fork.baseBranch).toBe(original.baseBranch)
    expect(fork.baseBranch).not.toBe(original.branch)
    expect(fork.parentWorkspaceId).toBe(original.parentWorkspaceId)
    expect(fork.forkedFromWorkspaceId).toBe(original.id)
    expect(fork).toMatchObject({
      agentBackend: original.agentBackend,
      permissionMode: original.permissionMode,
      model: original.model,
      effort: original.effort,
      fastMode: original.fastMode,
      multiAgent: original.multiAgent,
      displayName: null,
      sessionId: 'session-fork'
    })
    expect(mocks.addWorktree).toHaveBeenCalledWith(
      '/tmp/repo',
      'fork',
      original.baseBranch,
      '/tmp/fork',
      'abc123'
    )
    expect(mocks.transcriptCopy).toHaveBeenCalledWith(original.id, fork.id)
    expect(fork.sessionId).toBe('session-fork')
    expect(fork.sessionId).not.toBe(original.sessionId)
  })

  it('Codex 는 기록만 복사하고 새 thread 로 시작한다고 분기본에 알린다', async () => {
    const original = source({ agentBackend: 'codex' })
    mocks.state = {
      repos: [repo()],
      workspaces: [original],
      fanoutGroups: [],
      reviews: [],
      settings: structuredClone(DEFAULT_SETTINGS)
    }
    mocks.revParse.mockResolvedValue('abc123')
    mocks.snapshotWorkingTree.mockResolvedValue(null)
    const createDeps = deps()
    createDeps.forkAgentSession.mockResolvedValue(null)

    const result = await createWorkspace(createDeps, {
      repoId: 'repo-1',
      name: 'codex-fork',
      forkFromWorkspaceId: original.id
    })
    const fork = mocks.state.workspaces.find((w) => w.id === result.workspaceId)!

    expect(fork.sessionId).toBeNull()
    expect(mocks.transcriptUpsert).toHaveBeenCalledWith(
      fork.id,
      expect.objectContaining({
        type: 'system',
        text: expect.stringContaining('fresh Codex session')
      })
    )
  })

  it('백엔드가 원본 session id 를 돌려주면 공유하지 않고 승계 실패를 기록한다', async () => {
    const original = source()
    mocks.state = {
      repos: [repo()],
      workspaces: [original],
      fanoutGroups: [],
      reviews: [],
      settings: structuredClone(DEFAULT_SETTINGS)
    }
    mocks.revParse.mockResolvedValue('abc123')
    mocks.snapshotWorkingTree.mockResolvedValue(null)
    const createDeps = deps()
    createDeps.forkAgentSession.mockResolvedValue(original.sessionId)

    const result = await createWorkspace(createDeps, {
      repoId: 'repo-1',
      name: 'unsafe-fork',
      forkFromWorkspaceId: original.id
    })
    const fork = mocks.state.workspaces.find((w) => w.id === result.workspaceId)!

    expect(fork.sessionId).toBeNull()
    expect(fork.sessionId).not.toBe(original.sessionId)
    expect(mocks.transcriptUpsert).toHaveBeenCalledWith(
      fork.id,
      expect.objectContaining({
        type: 'system',
        text: expect.stringContaining('could not be carried over')
      })
    )
  })

  it.each([
    ['missing', []],
    ['archived', [source({ archived: true })]]
  ])('%s 원본이면 throw 대신 오류 결과를 돌려준다', async (_case, workspaces) => {
    mocks.state = {
      repos: [repo()],
      workspaces,
      fanoutGroups: [],
      reviews: [],
      settings: structuredClone(DEFAULT_SETTINGS)
    }

    await expect(
      createWorkspace(deps(), {
        repoId: 'repo-1',
        name: 'fork',
        forkFromWorkspaceId: 'source'
      })
    ).resolves.toEqual({ error: 'Source workspace not found (or archived).' })
  })
})

describe('workspaceForkError', () => {
  it('세션이 없으면 fork 를 거부한다', () => {
    expect(workspaceForkError({ sessionId: null, status: 'idle' })).toBe(
      'No conversation to fork yet.'
    )
  })

  it('턴이 실행 중이면 fork 를 거부한다', () => {
    expect(workspaceForkError({ sessionId: 'session', status: 'running' })).toBe(
      'Wait for the current turn to finish.'
    )
  })
})

/**
 * 아카이브 스크립트 실패는 아카이브를 멈추지 않는다 — 멈추면 worktree 만 남아 상태가 더
 * 나빠진다. 대신 실패를 **위로 올려야** 하고, 그 결과를 여기서 잃으면 사용자는 정리되지 않은
 * 컨테이너를 한참 뒤에나 발견한다.
 */
describe('runArchiveScript', () => {
  const scripts = (result: RunOnceResult): { runOnce: () => Promise<RunOnceResult> } => ({
    runOnce: vi.fn().mockResolvedValue(result)
  })

  it('성공하면 알릴 것이 없다', async () => {
    const deps = scripts({ code: 0, timedOut: false, output: 'done\n' })

    await expect(runArchiveScript(deps, 'docker compose down', '/tmp/wt')).resolves.toBeUndefined()
  })

  it('빈 명령은 아예 실행하지 않는다', async () => {
    const deps = scripts({ code: 0, timedOut: false, output: '' })

    await expect(runArchiveScript(deps, '   ', '/tmp/wt')).resolves.toBeUndefined()
    expect(deps.runOnce).not.toHaveBeenCalled()
  })

  it('실패하면 명령·코드·출력을 그대로 실어 올린다', async () => {
    const deps = scripts({ code: 1, timedOut: false, output: 'boom\n' })

    await expect(runArchiveScript(deps, 'exit 1', '/tmp/wt')).resolves.toEqual({
      command: 'exit 1',
      code: 1,
      timedOut: false,
      output: 'boom\n'
    })
  })

  // 타임아웃은 코드가 없어 "성공도 실패도 아닌" 모양이 된다 — 실패로 취급하지 않으면 조용히 샌다.
  it('타임아웃도 실패로 올린다', async () => {
    const deps = scripts({ code: null, timedOut: true, output: '' })

    await expect(runArchiveScript(deps, 'sleep 999', '/tmp/wt')).resolves.toMatchObject({
      code: null,
      timedOut: true
    })
  })
})
