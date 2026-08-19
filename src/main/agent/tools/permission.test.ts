import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PermissionRequest, Repo, Workspace } from '@shared/types'

// 카드 문구가 PR base 를 앱과 **같은 규칙**으로 구하므로 store 를 들여다본다([[agent/tools/pullRequest]]).
const state = vi.hoisted(() => ({
  workspaces: [] as Partial<Workspace>[],
  repos: [] as Partial<Repo>[]
}))
vi.mock('../../store', () => ({ getStore: () => ({ getState: () => state, update: vi.fn() }) }))

import {
  cancelToolPermissions,
  ensureToolApproved,
  initToolPermission,
  resolveToolPermission
} from './permission'

/**
 * Codex 의 app-server 는 MCP 도구에 대해 승인을 물어보지 않는다 — 이 문지기가 그 자리를 대신한다.
 * 여기가 뚫리면 워크스페이스 생성(브랜치 + 워크트리 + 리포의 셋업 스크립트 실행)이 사용자
 * 확인 없이 나간다.
 */

const cards: PermissionRequest[] = []

beforeEach(() => {
  cards.length = 0
  cancelToolPermissions()
  initToolPermission({ dispatch: (r) => cards.push(r) })
  state.workspaces = [{ id: 'ws-parent', branch: 'feat/base' }]
  state.repos = [
    {
      id: 'repo-1',
      name: 'wooi',
      path: '/src/wooi',
      defaultBranch: 'main',
      setupScript: 'npm install',
      runScripts: [{ id: 'dev-1', name: 'Dev', command: 'npm run dev', autoStart: false }]
    },
    { id: 'repo-2', name: 'oh-my-wooi', path: '/src/oh-my-wooi', defaultBranch: 'trunk' }
  ]
})

function workspace(over: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    repoId: 'repo-1',
    branch: 'feat/next',
    baseBranch: 'main',
    parentWorkspaceId: null,
    permissionMode: 'default',
    ...over
  } as Workspace
}

/** 카드가 뜨면 그 결정으로 답한다(렌더러 역할). */
function answer(behavior: 'allow' | 'deny'): void {
  const card = cards[cards.length - 1]
  resolveToolPermission(card.requestId, { behavior })
}

describe('ensureToolApproved', () => {
  it('상태를 바꾸는 도구는 카드를 띄우고 승인까지 기다린다', async () => {
    const pending = ensureToolApproved(workspace(), 'create_stacked_workspace', {
      name: 'feat/x'
    })
    await vi.waitFor(() => expect(cards).toHaveLength(1))

    expect(cards[0].toolName).toBe('mcp__wooi__create_stacked_workspace')
    expect(cards[0].workspaceId).toBe('ws-1')
    // 셋업 스크립트가 돈다는 사실은 승인 전에 보여야 한다.
    expect(cards[0].title).toMatch(/setup script/)
    expect(cards[0].input).toEqual({ name: 'feat/x' })

    answer('allow')
    await expect(pending).resolves.toBeUndefined()
  })

  it('거부하면 던져서 도구가 실행되지 않게 한다', async () => {
    const pending = ensureToolApproved(workspace(), 'create_stacked_workspace', {})
    await vi.waitFor(() => expect(cards).toHaveLength(1))
    answer('deny')

    await expect(pending).rejects.toThrow(/declined/)
  })

  it('PR 카드는 앱이 정한 base 를 보여 준다 — 사용자가 판단하는 지점이다', async () => {
    const pending = ensureToolApproved(
      workspace({ parentWorkspaceId: 'ws-parent' }),
      'open_pull_request',
      { title: 'Add the form', body: 'x' }
    )
    await vi.waitFor(() => expect(cards).toHaveLength(1))

    expect(cards[0].title).toContain('`feat/base`')
    expect(cards[0].title).toContain('`feat/next`')

    answer('allow')
    await expect(pending).resolves.toBeUndefined()
  })

  it('스택이 아니면 카드에도 리포 기본 브랜치가 뜬다', async () => {
    const pending = ensureToolApproved(workspace(), 'open_pull_request', { title: 't', body: 'b' })
    await vi.waitFor(() => expect(cards).toHaveLength(1))

    expect(cards[0].title).toContain('`main`')

    answer('allow')
    await expect(pending).resolves.toBeUndefined()
  })

  // create_workspace 는 다른 리포에도 만들 수 있다. 새 워크스페이스는 화면을 가져가지 않으므로
  // 사용자가 "엉뚱한 코드베이스에 만들려 한다" 를 알아챌 수 있는 자리는 이 카드 한 줄뿐이다.
  it('다른 리포에 만들려 하면 카드가 그 리포와 base 를 말한다', async () => {
    const pending = ensureToolApproved(workspace(), 'create_workspace', { repo: 'oh-my-wooi' })
    await vi.waitFor(() => expect(cards).toHaveLength(1))

    expect(cards[0].title).toContain('`oh-my-wooi`')
    expect(cards[0].title).toContain('`trunk`')

    answer('allow')
    await expect(pending).resolves.toBeUndefined()
  })

  it('자기 리포면 리포 이름을 적지 않는다 — 매번 적으면 나가는 호출이 묻힌다', async () => {
    const pending = ensureToolApproved(workspace(), 'create_workspace', {})
    await vi.waitFor(() => expect(cards).toHaveLength(1))

    // 문장이 늘 말하는 "the repository's setup script" 말고, **리포를 지목하는** 구절이 없어야 한다.
    expect(cards[0].title).not.toContain('`wooi`')
    expect(cards[0].title).toContain('`main`')

    answer('allow')
    await expect(pending).resolves.toBeUndefined()
  })

  it('스크립트 카드는 실제로 돌아갈 명령을 보여 준다', async () => {
    const pending = ensureToolApproved(workspace(), 'run_script', { kind: 'dev' })
    await vi.waitFor(() => expect(cards).toHaveLength(1))

    expect(cards[0].title).toContain('`npm run dev`')

    answer('allow')
    await expect(pending).resolves.toBeUndefined()
  })

  it('스크립트 출력 읽기는 묻지 않는다 — 매번 카드가 뜨면 검증 루프를 못 쓴다', async () => {
    await expect(
      ensureToolApproved(workspace(), 'read_script_output', { kind: 'dev' })
    ).resolves.toBeUndefined()
    expect(cards).toHaveLength(0)
  })

  it('읽기 전용 도구는 묻지 않는다', async () => {
    await expect(ensureToolApproved(workspace(), 'check_stacked_work', {})).resolves.toBeUndefined()
    expect(cards).toHaveLength(0)
  })

  it('fullAccess 는 사용자가 고른 "묻지 마" 모드이므로 그대로 통과시킨다', async () => {
    await expect(
      ensureToolApproved(
        workspace({ permissionMode: 'fullAccess' }),
        'create_stacked_workspace',
        {}
      )
    ).resolves.toBeUndefined()
    expect(cards).toHaveLength(0)
  })

  /**
   * 자동 모드의 식별자는 백엔드마다 다르다 — Claude 는 'auto', Codex 는 'default'(라벨 "Auto").
   * 그런데 Claude 의 'default' 는 정반대로 "매번 묻는" 모드다. 문자열 하나로 판단하면 반드시
   * 한쪽이 틀리므로, 백엔드 메타(autonomousPermissionMode)를 거치는지 양쪽으로 확인한다.
   */
  it('자동 모드에서는 팀 전환을 묻지 않는다 — 사용자가 방금 말로 시킨 일이다', async () => {
    for (const ws of [
      workspace({ agentBackend: 'claude', permissionMode: 'auto' }),
      workspace({ agentBackend: 'codex', permissionMode: 'default' })
    ]) {
      cards.length = 0
      await expect(
        ensureToolApproved(ws, 'switch_to_agent_team', { reason: 'Codex should review this.' })
      ).resolves.toBeUndefined()
      expect(cards).toHaveLength(0)
    }
  })

  it('Claude 의 default 는 자동 모드가 아니므로 팀 전환도 묻는다', async () => {
    // 두 백엔드가 'default' 식별자를 공유하는 데서 오는 함정이다. 여기가 통과되면 "매번 묻는"
    // 모드를 고른 사용자가 카드 없이 팀 전환을 당한다.
    const pending = ensureToolApproved(
      workspace({ agentBackend: 'claude', permissionMode: 'default' }),
      'switch_to_agent_team',
      { reason: 'Codex should review this.' }
    )
    expect(cards).toHaveLength(1)
    resolveToolPermission(cards[0].requestId, { behavior: 'allow' })
    await expect(pending).resolves.toBeUndefined()
  })

  it('자동 모드라도 워크트리 밖으로 나가는 도구는 묻는다', async () => {
    // 자동 모드가 약속한 것은 "이 작업 공간 안에서 알아서 하라" 다. 브랜치·워크트리를 만들고
    // 리포의 셋업 스크립트를 돌리는 일까지 조용히 통과시키면 그 약속을 넘어선다.
    const pending = ensureToolApproved(
      workspace({ agentBackend: 'claude', permissionMode: 'auto' }),
      'create_stacked_workspace',
      {}
    )
    expect(cards).toHaveLength(1)
    resolveToolPermission(cards[0].requestId, { behavior: 'allow' })
    await expect(pending).resolves.toBeUndefined()
  })

  it('readOnly·plan 모드에서도 상태를 바꾸는 도구는 반드시 묻는다', async () => {
    for (const mode of ['readOnly', 'plan'] as const) {
      cards.length = 0
      const pending = ensureToolApproved(
        workspace({ permissionMode: mode }),
        'create_stacked_workspace',
        {}
      )
      await vi.waitFor(() => expect(cards).toHaveLength(1))
      answer('deny')
      await expect(pending).rejects.toThrow()
    }
  })
})

describe('resolveToolPermission', () => {
  it('남의 requestId 는 조용히 무시한다 — 응답은 백엔드들에도 함께 방송된다', () => {
    expect(() => resolveToolPermission('not-ours', { behavior: 'allow' })).not.toThrow()
  })

  it('같은 요청에 두 번 답해도 터지지 않는다', async () => {
    const pending = ensureToolApproved(workspace(), 'create_stacked_workspace', {})
    await vi.waitFor(() => expect(cards).toHaveLength(1))
    answer('allow')
    expect(() => answer('deny')).not.toThrow()
    await expect(pending).resolves.toBeUndefined()
  })
})

describe('cancelToolPermissions', () => {
  it('매달린 요청을 거부로 확정한다 — 답할 창이 사라지면 영영 기다린다', async () => {
    const pending = ensureToolApproved(workspace(), 'create_stacked_workspace', {})
    await vi.waitFor(() => expect(cards).toHaveLength(1))

    cancelToolPermissions()

    await expect(pending).rejects.toThrow(/declined/)
  })
})
