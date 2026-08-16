import { describe, it, expect, beforeEach, vi } from 'vitest'
import { z } from 'zod'
import type { AgentToolDeps } from './registry'
import type { AppSettings, ModelOption, Repo, Workspace } from '@shared/types'
import { AGENT_BACKEND_IDS } from '@shared/types'
import { MAIN_AGENT_BACKEND_IDS, backendMeta } from '../backend'
import { DEFAULT_SETTINGS } from '../../storeSchema'
import { AGENT_TOOLS } from './catalog'

/**
 * 독립 워크스페이스 생성과 아카이브에서 지켜야 할 것들.
 *
 * 두 도구가 한 파일에 있는 이유는 둘 다 **스택의 전제를 벗어난다**는 점을 공유하기 때문이다.
 * 생성은 부모 워크트리 상태와 무관해야 하고(그래서 clean 을 요구하지 않는다), 아카이브는
 * 처음으로 대상을 인자로 받는다(그래서 대상 쪽 방어가 핸들러 안에 있어야 한다).
 * 이 두 성질이 무너지면 각각 "조용히 잘못 갈라진 브랜치" 와 "남의 작업을 지우는 도구" 가 된다.
 */

const clean = vi.hoisted(() => vi.fn())
const create = vi.hoisted(() => vi.fn())
const archive = vi.hoisted(() => vi.fn())
const state = vi.hoisted(() => ({
  workspaces: [] as Partial<Workspace>[],
  repos: [] as Partial<Repo>[],
  settings: {} as AppSettings
}))

vi.mock('../../git', () => ({ isWorktreeClean: clean }))
vi.mock('../../workspaces', () => ({ createWorkspace: create, archiveWorkspace: archive }))
vi.mock('../../store', () => ({ getStore: () => ({ getState: () => state }) }))

const sendMessage = vi.fn()
// 모델 목록은 백엔드에 물어봐야 알 수 있다 — 빈 목록은 "알 수 없다" 라서 검증을 건너뛴다.
const listModels = vi.fn<(backend: string) => Promise<ModelOption[]>>()
const deps = { scripts: {}, sendMessage, listModels } as unknown as AgentToolDeps

const repo: Partial<Repo> = { id: 'repo-1', defaultBranch: 'main' }

const caller: Partial<Workspace> = {
  id: 'ws-caller',
  repoId: 'repo-1',
  branch: 'feat/base',
  baseBranch: 'main',
  name: 'base',
  displayName: null,
  worktreePath: '/tmp/wt',
  parentWorkspaceId: null,
  createdByWorkspaceId: null,
  archived: false,
  status: 'running'
}

/** 호출자의 에이전트가 만든 스택 자식 — 부모 관계와 생성자가 둘 다 있다. */
const child: Partial<Workspace> = {
  id: 'ws-child',
  repoId: 'repo-1',
  branch: 'feat/next',
  baseBranch: 'feat/base',
  name: 'next',
  displayName: null,
  worktreePath: '/tmp/wt-child',
  parentWorkspaceId: 'ws-caller',
  createdByWorkspaceId: 'ws-caller',
  archived: false,
  status: 'idle'
}

/**
 * 호출자의 에이전트가 만든 **독립** 워크스페이스 — 생성자만 있고 부모가 없다.
 * 이 조합이 부모 관계로 판정하던 시절에 빠져나가던 쪽이다.
 */
const independent: Partial<Workspace> = {
  ...child,
  id: 'ws-indep',
  branch: 'feat/other',
  baseBranch: 'main',
  name: 'other',
  worktreePath: '/tmp/wt-indep',
  parentWorkspaceId: null
}

beforeEach(() => {
  vi.clearAllMocks()
  state.workspaces = [{ ...caller }, { ...child }]
  state.repos = [{ ...repo }]
  state.settings = { ...DEFAULT_SETTINGS }
  listModels.mockResolvedValue([{ id: 'claude-opus-5[1m]', label: 'Opus 5' }])
  clean.mockResolvedValue(true)
  create.mockResolvedValue({ workspaceId: 'ws-new', name: 'feat/other', branch: 'feat/other' })
  // 아카이브는 결과 객체를 돌려준다 — 스크립트가 실패했을 때만 내용이 찬다.
  archive.mockResolvedValue({})
})

async function create_(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const { createIndependentWorkspace } = await import('./workspace')
  return createIndependentWorkspace(deps, 'ws-caller', args) as Promise<Record<string, unknown>>
}

async function archive_(
  args: Record<string, unknown>,
  from = 'ws-caller'
): Promise<Record<string, unknown>> {
  const { archiveWorkspaceTool } = await import('./workspace')
  return archiveWorkspaceTool(deps, from, args) as Promise<Record<string, unknown>>
}

describe('create_workspace', () => {
  it('MCP 스키마에서 새 워크스페이스의 agent를 선택할 수 있다', () => {
    const spec = AGENT_TOOLS.find((tool) => tool.name === 'create_workspace')
    expect(spec).toBeDefined()

    const schema = z.object(spec!.inputSchema)
    expect(schema.safeParse({ agentBackend: 'codex' }).success).toBe(true)
    expect(schema.safeParse({ agentBackend: 'unknown' }).success).toBe(false)
  })

  // teammate 전용 백엔드를 메인 자리에 앉히면 그 워크스페이스는 첫 턴에 죽는다(createBackend 가
  // throw 한다). 등록된 백엔드 전체가 아니라 **메인이 될 수 있는 것만** 후보라는 것을 못 박는다.
  //
  // 지금은 세 백엔드가 모두 메인이 될 수 있어 아래 루프의 거절 분기가 비어 있다. 그래서 후보
  // 목록이 `capabilities.mainAgent` 에서 **파생된다**는 것을 따로 단언한다 — teammate 전용이
  // 다시 생기는 순간 그 백엔드가 자동으로 검사 대상에 들어온다. 거절 경로 자체는 목록에 없는
  // 값으로 늘 함께 확인한다.
  it('워크스페이스를 구동할 수 없는 백엔드는 고를 수 없다', async () => {
    expect(MAIN_AGENT_BACKEND_IDS).toEqual(
      AGENT_BACKEND_IDS.filter((id) => backendMeta(id).capabilities.mainAgent)
    )

    const spec = AGENT_TOOLS.find((tool) => tool.name === 'create_workspace')
    const schema = z.object(spec!.inputSchema)
    for (const id of AGENT_BACKEND_IDS) {
      const canDrive = backendMeta(id).capabilities.mainAgent
      // 스키마는 메인이 될 수 있는 것만 모델에게 보여 준다.
      expect(schema.safeParse({ agentBackend: id }).success).toBe(canDrive)
      if (canDrive) continue
      // 스키마를 우회해 들어와도 도구가 사람이 읽는 오류로 끊는다.
      await expect(create_({ agentBackend: id })).rejects.toThrow(/cannot run a workspace/i)
    }
    // 후보가 전부 메인이어도 그 거절 경로가 살아 있는지는 확인해 둔다.
    await expect(create_({ agentBackend: 'not-an-agent' })).rejects.toThrow(
      /cannot run a workspace/i
    )
    expect(create).not.toHaveBeenCalled()
  })

  it('부모를 넘기지 않는다 — 이것이 스택과 갈리는 지점 전부다', async () => {
    await create_({ name: 'feat/other' })

    expect(create).toHaveBeenCalledWith(deps, {
      repoId: 'repo-1',
      createdByWorkspaceId: 'ws-caller',
      name: 'feat/other'
    })
    expect(create.mock.calls[0][1]).not.toHaveProperty('parentWorkspaceId')
  })

  it('선택한 agent를 새 워크스페이스에 넘긴다', async () => {
    await create_({ agentBackend: 'codex' })

    expect(create).toHaveBeenCalledWith(deps, expect.objectContaining({ agentBackend: 'codex' }))
  })

  it('agent를 생략하면 Wooi 기본값을 쓰도록 넘기지 않는다', async () => {
    await create_()

    expect(create.mock.calls[0][1]).not.toHaveProperty('agentBackend')
  })

  it('MCP 스키마에서 모델과 effort 도 고를 수 있다', () => {
    const spec = AGENT_TOOLS.find((tool) => tool.name === 'create_workspace')
    const schema = z.object(spec!.inputSchema)

    expect(schema.safeParse({ model: 'claude-opus-5[1m]', effort: 'high' }).success).toBe(true)
    // effort 는 백엔드 메타가 아는 값만 받는다 — 오타를 새 워크스페이스까지 가져가지 않는다.
    expect(schema.safeParse({ effort: 'very-high' }).success).toBe(false)
  })

  it('선택한 모델과 effort 를 새 워크스페이스에 넘긴다', async () => {
    await create_({ model: 'claude-opus-5[1m]', effort: 'high' })

    expect(create).toHaveBeenCalledWith(
      deps,
      expect.objectContaining({ model: 'claude-opus-5[1m]', effort: 'high' })
    )
  })

  it('모델·effort 를 생략하면 백엔드 기본값을 쓰도록 넘기지 않는다', async () => {
    await create_()

    expect(create.mock.calls[0][1]).not.toHaveProperty('model')
    expect(create.mock.calls[0][1]).not.toHaveProperty('effort')
  })

  // 잘못된 모델은 생성을 막지 않고 저장된다 — 사고는 화면도 가져가지 않는 새 워크스페이스의
  // 첫 턴에서야 터진다. 도구 오류로 돌려주면 모델이 같은 턴 안에서 고쳐 다시 부를 수 있다.
  it('그 agent 가 주지 않는 모델은 고를 수 있는 값과 함께 거절한다', async () => {
    await expect(create_({ model: 'gpt-9' })).rejects.toThrow('claude-opus-5[1m]')
    expect(create).not.toHaveBeenCalled()
  })

  it('그 agent 가 모르는 effort 도 거절한다', async () => {
    // 'minimal' 은 Codex 쪽 단계다. 검증은 **고른 agent** 의 목록으로 한다.
    await expect(create_({ effort: 'minimal' })).rejects.toThrow('Claude Code')
    expect(create).not.toHaveBeenCalled()
  })

  // 목록을 못 얻는 이유는 여럿이다(CLI 미설치·조회 실패). 그때 거절하면 사용자가 정당하게
  // 고른 모델까지 막힌다 — 모르는 것은 모르는 대로 두고 값을 그대로 넘긴다.
  it('모델 목록을 못 얻으면 검증 없이 그대로 넘긴다', async () => {
    listModels.mockResolvedValue([])

    await create_({ model: 'some-new-model' })

    expect(create).toHaveBeenCalledWith(deps, expect.objectContaining({ model: 'some-new-model' }))
  })

  // 부모가 없어도 "내가 만들었다" 는 남아야 한다. 이게 없으면 자기가 만든 워크스페이스를
  // 나중에 아카이브할 근거가 사라진다.
  it('부모는 없어도 생성자는 남긴다', async () => {
    await create_()
    expect(create.mock.calls[0][1]).toMatchObject({ createdByWorkspaceId: 'ws-caller' })
  })

  it('리포 기본 브랜치에서 갈라진다고 알려 준다', async () => {
    await expect(create_()).resolves.toMatchObject({
      workspaceId: 'ws-new',
      branch: 'feat/other',
      baseBranch: 'main'
    })
  })

  it('미커밋 변경이 있어도 만든다 — 새 브랜치는 이 워크트리에서 갈라지지 않는다', async () => {
    clean.mockResolvedValue(false)

    await expect(create_()).resolves.toMatchObject({ workspaceId: 'ws-new' })
    expect(create).toHaveBeenCalled()
    // 검사 자체를 하지 않아야 한다. 물어보고 무시하면 나중에 누가 그 값을 쓰게 된다.
    expect(clean).not.toHaveBeenCalled()
  })

  it('이름을 안 주면 Wooi 가 짓도록 넘기지 않는다', async () => {
    await create_({ name: '   ' })
    expect(create.mock.calls[0][1]).not.toHaveProperty('name')
  })

  it('task 를 주면 새 워크스페이스로 보내 바로 일을 시작시킨다', async () => {
    await create_({ task: 'Add the settings page.' })

    expect(sendMessage).toHaveBeenCalledTimes(1)
    const [target, text] = sendMessage.mock.calls[0]
    expect(target).toBe('ws-new')
    expect(text).toContain('Add the settings page.')
    // 어디서 갈라졌는지는 알아야 PR base 를 이해한다.
    expect(text).toContain('main')
  })

  it('보고 규약을 넣지 않는다 — 부모가 없어 report_to_parent 는 항상 실패한다', async () => {
    await create_({ task: 'Add the settings page.' })

    const [, text] = sendMessage.mock.calls[0]
    expect(text).not.toContain('report_to_parent')
    // 대신 결과가 사용자에게 가야 한다는 것은 말해 준다.
    expect(text).toMatch(/user/)
  })

  it('부르는 쪽에도 보고가 오지 않는다는 것을 알려 준다', async () => {
    const result = await create_({ task: 'Add the settings page.' })
    expect(result.next).toContain('check_stacked_work')
  })

  it('task 가 없으면 아무것도 보내지 않고 그 사실을 알려 준다', async () => {
    const result = await create_({ task: ' \n ' })

    expect(sendMessage).not.toHaveBeenCalled()
    expect(result.started).toBe(false)
    expect(result.note).toMatch(/idle/)
  })

  it('생성 실패는 도구 오류로 올린다', async () => {
    create.mockResolvedValue({ error: 'branch already exists' })
    await expect(create_()).rejects.toThrow('branch already exists')
  })

  it('전달 실패는 생성을 막지 않지만 결과에 남긴다', async () => {
    create.mockResolvedValue({
      workspaceId: 'ws-new',
      branch: 'feat/other',
      carryFailures: [{ path: '.env', reason: 'missing', agentContext: false }]
    })

    await expect(create_()).resolves.toMatchObject({ carryFailures: ['.env: missing'] })
  })

  it('사라진 워크스페이스면 던진다', async () => {
    state.workspaces = []
    await expect(create_()).rejects.toThrow(/no longer exists/)
  })
})

describe('archive_workspace', () => {
  it('자식을 아카이브하고 되돌릴 수 있다는 것을 알려 준다', async () => {
    const result = await archive_({ workspaceId: 'ws-child' })

    expect(archive).toHaveBeenCalledWith(deps, 'ws-child')
    expect(result.archived).toMatchObject({
      workspaceId: 'ws-child',
      name: 'next',
      branch: 'feat/next'
    })
    expect(result.note).toMatch(/branch/)
  })

  it('자기 자신은 거부한다 — 이 호출이 이 호출을 낸 세션을 죽인다', async () => {
    await expect(archive_({ workspaceId: 'ws-caller' })).rejects.toThrow(
      /cannot archive the workspace you are running in/
    )
    expect(archive).not.toHaveBeenCalled()
  })

  // 이번 변경의 요점. 부모 관계로 판정하던 시절에는 이 워크스페이스가 빠져나갔다 —
  // 자기가 만들어 놓고 자기가 치우지 못했다.
  it('부모가 없어도 자기가 만든 워크스페이스면 아카이브한다', async () => {
    state.workspaces = [{ ...caller }, { ...independent }]

    await expect(archive_({ workspaceId: 'ws-indep' })).resolves.toMatchObject({
      archived: { workspaceId: 'ws-indep' }
    })
    expect(archive).toHaveBeenCalledWith(deps, 'ws-indep')
  })

  it('남의 워크스페이스는 거부한다 — 자기가 만든 것만 지목할 수 있다', async () => {
    state.workspaces = [{ ...caller }, { ...child, createdByWorkspaceId: 'ws-someone-else' }]

    await expect(archive_({ workspaceId: 'ws-child' })).rejects.toThrow(/not created by this/)
    expect(archive).not.toHaveBeenCalled()
  })

  // 반대 방향의 사고다. 사람이 UI 에서 스택을 만들면 부모는 있어도 생성자는 없다 —
  // 부모 관계로 판정하면 에이전트가 사람의 워크스페이스를 지우게 된다.
  it('사람이 만든 스택 자식은 부모가 자기여도 거부한다', async () => {
    state.workspaces = [{ ...caller }, { ...child, createdByWorkspaceId: null }]

    await expect(archive_({ workspaceId: 'ws-child' })).rejects.toThrow(/not created by this/)
    expect(archive).not.toHaveBeenCalled()
  })

  it('손자(자식이 만든 워크스페이스)도 거부한다', async () => {
    state.workspaces = [
      { ...caller },
      { ...child },
      {
        ...child,
        id: 'ws-grandchild',
        parentWorkspaceId: 'ws-child',
        createdByWorkspaceId: 'ws-child'
      }
    ]

    await expect(archive_({ workspaceId: 'ws-grandchild' })).rejects.toThrow(/not created by this/)
  })

  it('자기를 만든 워크스페이스는 거꾸로 지우지 못한다', async () => {
    await expect(archive_({ workspaceId: 'ws-caller' }, 'ws-child')).rejects.toThrow(
      /not created by this/
    )
    expect(archive).not.toHaveBeenCalled()
  })

  it('도는 중인 자식은 거부한다 — 남의 턴을 죽이는 일이다', async () => {
    state.workspaces = [{ ...caller }, { ...child, status: 'running' }]

    await expect(archive_({ workspaceId: 'ws-child' })).rejects.toThrow(/running a turn/)
    expect(archive).not.toHaveBeenCalled()
  })

  it('미커밋 변경이 있는 자식은 거부한다 — 언아카이브로 돌아오지 않는다', async () => {
    clean.mockResolvedValue(false)

    await expect(archive_({ workspaceId: 'ws-child' })).rejects.toThrow(/uncommitted changes/)
    expect(archive).not.toHaveBeenCalled()
    // 대상의 워크트리를 봐야 한다 — 호출자 것을 보면 엉뚱한 판단이 된다.
    expect(clean).toHaveBeenCalledWith('/tmp/wt-child')
  })

  it('이미 아카이브된 자식은 거부한다', async () => {
    state.workspaces = [{ ...caller }, { ...child, archived: true }]

    await expect(archive_({ workspaceId: 'ws-child' })).rejects.toThrow(/already archived/)
    expect(archive).not.toHaveBeenCalled()
  })

  it('모르는 id 는 거부한다', async () => {
    await expect(archive_({ workspaceId: 'ws-nope' })).rejects.toThrow(/No Wooi workspace/)
  })

  it('id 를 빠뜨리면 거부한다', async () => {
    await expect(archive_({})).rejects.toThrow(/No workspace id/)
    expect(archive).not.toHaveBeenCalled()
  })
})
