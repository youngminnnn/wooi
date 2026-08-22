import type { AppState, GitStatus, PrState, PrStatus, Repo, Workspace } from '@shared/types'

export function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'workspace-1',
    repoId: 'repo-1',
    agentBackend: 'claude',
    name: 'sunny-bison',
    displayName: null,
    branch: 'feat/test',
    baseBranch: 'main',
    parentWorkspaceId: null,
    createdByWorkspaceId: null,
    prNumber: null,
    worktreePath: '/tmp/sunny-bison',
    ports: {},
    setupState: 'idle',
    sessionId: null,
    permissionMode: 'default',
    status: 'idle',
    model: null,
    effort: null,
    fastMode: null,
    lastModel: null,
    fastModeState: null,
    fastModeReason: null,
    archived: false,
    createdAt: 1,
    lastActiveAt: 1,
    ...overrides
  }
}

export function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    name: 'Wooi',
    path: '/tmp/wooi',
    defaultBranch: 'main',
    setupScript: '',
    runScripts: [],
    archiveScript: '',
    carryItems: [],
    ...overrides
  } as Repo
}

export function app(workspaces: Workspace[]): AppState {
  return {
    repos: [repo()],
    workspaces,
    fanoutGroups: [],
    reviews: [],
    settings: { defaultRightPanelOpen: true }
  } as unknown as AppState
}

export function git(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: 'feat/test',
    ahead: 1,
    behind: 0,
    changedFiles: 0,
    conflicted: false,
    ...overrides
  }
}

export function pr(state: PrState, overrides: Partial<PrStatus> = {}): PrStatus {
  return {
    number: 42,
    url: 'https://example.test/pr/42',
    title: 'Renderer tests',
    state,
    label:
      state === 'merged'
        ? 'Merged'
        : state === 'ci_failed'
          ? 'Checks failed'
          : state === 'ci_pending'
            ? 'Checks pending'
            : 'Open',
    needsBaseUpdate: false,
    ...overrides
  }
}
