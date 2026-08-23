import { describe, it, expect, beforeEach, vi } from 'vitest'
import { z } from 'zod'
import type { AgentToolDeps } from './registry'
import type { AppSettings, ModelOption, Repo, Workspace } from '@shared/types'
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
vi.mock('../../store', () => ({
  getStore: () => ({
    getState: () => state,
    update: (fn: (draft: typeof state) => void) => fn(state)
  })
}))

const sendMessage = vi.fn()
// 모델 목록은 백엔드에 물어봐야 알 수 있다 — 빈 목록은 "알 수 없다" 라서 검증을 건너뛴다.
const listModels = vi.fn<(backend: string) => Promise<ModelOption[]>>()
const broadcastState = vi.fn()
const deps = { scripts: {}, sendMessage, listModels, broadcastState } as unknown as AgentToolDeps

const repo: Partial<Repo> = { id: 'repo-1', name: 'wooi', path: '/src/wooi', defaultBranch: 'main' }

/** 호출자가 살지 않는, 사용자가 Wooi 에 따로 등록해 둔 리포. */
const otherRepo: Partial<Repo> = {
  id: 'repo-2',
  name: 'oh-my-wooi',
  path: '/src/oh-my-wooi',
  defaultBranch: 'trunk'
}

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
  state.repos = [{ ...repo }, { ...otherRepo }]
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

async function repos_(): Promise<Record<string, unknown>> {
  const { listRepositories } = await import('./workspace')
  return listRepositories(deps, 'ws-caller', {}) as Promise<Record<string, unknown>>
}

async function archive_(
  args: Record<string, unknown>,
  from = 'ws-caller'
): Promise<Record<string, unknown>> {
  const { archiveWorkspaceTool } = await import('./workspace')
  return archiveWorkspaceTool(deps, from, args) as Promise<Record<string, unknown>>
}

async function name_(
  args: Record<string, unknown>,
  from = 'ws-caller'
): Promise<Record<string, unknown>> {
  const { setWorkspaceName } = await import('./workspace')
  return setWorkspaceName(deps, from, args) as Promise<Record<string, unknown>>
}

describe('create_workspace', () => {
  it('MCP 스키마에서 새 워크스페이스의 agent를 선택할 수 있다', () => {
    const spec = AGENT_TOOLS.find((tool) => tool.name === 'create_workspace')
    expect(spec).toBeDefined()

    const schema = z.object(spec!.inputSchema)
    expect(schema.safeParse({ agentBackend: 'codex' }).success).toBe(true)
    expect(schema.safeParse({ agentBackend: 'unknown' }).success).toBe(false)
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

  // 리포를 지목하지 않는 것이 압도적으로 흔한 경우다. 그때 다른 리포로 새면 사용자는 승인 카드
  // 한 줄로만 알아챌 수 있고, 브랜치는 엉뚱한 코드베이스에 남는다.
  it('repo 를 생략하면 이 워크스페이스의 리포에 만든다', async () => {
    await create_()
    expect(create.mock.calls[0][1]).toMatchObject({ repoId: 'repo-1' })
  })

  it('repo 이름을 주면 사용자가 등록해 둔 그 리포에 만든다', async () => {
    const result = await create_({ repo: 'oh-my-wooi' })

    expect(create.mock.calls[0][1]).toMatchObject({ repoId: 'repo-2' })
    // base 는 **그 리포의** 기본 브랜치다 — 호출자 리포의 것을 흘리면 PR base 를 잘못 읽는다.
    expect(result).toMatchObject({ baseBranch: 'trunk', repo: 'oh-my-wooi' })
  })

  it('사이드바 이름의 대소문자는 따지지 않는다', async () => {
    await create_({ repo: 'Oh-My-Wooi' })
    expect(create.mock.calls[0][1]).toMatchObject({ repoId: 'repo-2' })
  })

  // 리포 이름은 폴더 이름이라 겹칠 수 있다. 경로는 등록 시점에 유일하므로 유일한 탈출구가 된다.
  it('체크아웃 경로로도 지목할 수 있다', async () => {
    await create_({ repo: '/src/oh-my-wooi' })
    expect(create.mock.calls[0][1]).toMatchObject({ repoId: 'repo-2' })
  })

  // 고칠 수 있는 오류로 만든다 — `list_repositories` 로 다시 다녀오라고만 하면, 도구가 이미
  // 아는 답을 얻으러 왕복이 한 번 더 든다.
  it('모르는 리포는 등록된 리포 이름과 함께 거절한다', async () => {
    await expect(create_({ repo: 'not-registered' })).rejects.toThrow(/oh-my-wooi/)
    expect(create).not.toHaveBeenCalled()
  })

  it('같은 이름이 둘이면 만들지 않고 경로로 다시 부르라고 한다', async () => {
    state.repos = [{ ...repo }, { ...otherRepo, name: 'wooi' }]

    await expect(create_({ repo: 'wooi' })).rejects.toThrow(/\/src\/oh-my-wooi/)
    expect(create).not.toHaveBeenCalled()
  })

  // 인계문을 쓴 모델은 자기 리포를 보며 썼다. 그 사실을 새 워크스페이스가 모르면 없는 경로를
  // 찾느라 몇 턴을 쓰고, 그것이 실패가 아니라 자기 착각으로 보인다.
  it('다른 리포에 만들면 인계문이 그 사실부터 말한다', async () => {
    await create_({ repo: 'oh-my-wooi', task: 'Add the settings page.' })

    const [, text] = sendMessage.mock.calls[0]
    expect(text).toContain('oh-my-wooi')
    expect(text).toContain('trunk')
  })

  it('같은 리포면 리포 이야기를 꺼내지 않는다', async () => {
    const result = await create_({ repo: 'wooi', task: 'Add the settings page.' })

    expect(result).not.toHaveProperty('repo')
    const [, text] = sendMessage.mock.calls[0]
    expect(text).not.toContain('repository')
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

/**
 * `create_workspace` 의 `repo` 에 무엇을 적을 수 있는지 알려 주는 유일한 도구다. 여기가 비거나
 * 틀리면 다른 리포에 만드는 길은 "이름을 우연히 맞히는 것" 으로 좁아진다.
 */
describe('list_repositories', () => {
  it('인자를 받지 않고 승인도 묻지 않는다 — 등록된 리포 이름을 읽는 것뿐이다', () => {
    const spec = AGENT_TOOLS.find((tool) => tool.name === 'list_repositories')
    expect(spec).toBeDefined()
    expect(spec!.inputSchema).toEqual({})
    expect(spec!.annotations?.readOnlyHint).toBe(true)
  })

  it('등록된 리포를 전부 주고 자기 리포를 current 로 맨 앞에 둔다', async () => {
    const result = await repos_()

    expect(result.repositories).toEqual([
      expect.objectContaining({
        name: 'wooi',
        path: '/src/wooi',
        defaultBranch: 'main',
        current: true
      }),
      expect.objectContaining({ name: 'oh-my-wooi', defaultBranch: 'trunk' })
    ])
    // 자기 리포에는 current 가 붙고 남의 리포에는 붙지 않아야 한다 — `repo` 를 생략했을 때
    // 어디에 만들어지는지를 이 표시 하나로 읽는다.
    expect((result.repositories as Record<string, unknown>[])[1]).not.toHaveProperty('current')
  })

  // 작업이 하나도 없는 리포야말로 이 도구가 필요한 이유다(peers 로는 보이지 않는다). 그래서
  // 0 이어도 목록에서 빼지 않고, 대신 얼마나 도는 중인지를 센다.
  it('리포마다 열린 워크스페이스 수를 세고, 아카이브된 것은 빼고 센다', async () => {
    state.workspaces = [
      { ...caller },
      { ...child },
      { ...independent, archived: true },
      { ...child, id: 'ws-far', repoId: 'repo-2' }
    ]

    const [own, other] = (await repos_()).repositories as Record<string, unknown>[]

    expect(own.openWorkspaces).toBe(2)
    expect(other.openWorkspaces).toBe(1)
  })

  it('이름이 겹치는 리포에는 경로로 부르라는 표시를 미리 붙인다', async () => {
    state.repos = [{ ...repo }, { ...otherRepo, name: 'wooi' }]

    const listed = (await repos_()).repositories as Record<string, unknown>[]

    expect(listed.every((r) => r.ambiguousName === true)).toBe(true)
    expect(listed.every((r) => typeof r.path === 'string')).toBe(true)
  })

  it('겹치지 않는 이름에는 경고를 붙이지 않는다 — 다 붙으면 경고가 값을 잃는다', async () => {
    const listed = (await repos_()).repositories as Record<string, unknown>[]
    expect(listed.some((r) => 'ambiguousName' in r)).toBe(false)
  })

  it('이 이름을 create_workspace 에 그대로 넘기라고 말해 준다', async () => {
    expect(await repos_()).toMatchObject({ next: expect.stringContaining('create_workspace') })
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

describe('set_workspace_name', () => {
  it('자기 이름은 autoName만 바꾼다', async () => {
    const result = await name_({ name: 'Plan automatic names' })
    expect(state.workspaces[0]).toMatchObject({
      autoName: 'Plan automatic names',
      displayName: null
    })
    expect(result).toMatchObject({
      autoName: 'Plan automatic names',
      displayName: 'Plan automatic names'
    })
    expect(broadcastState).toHaveBeenCalledOnce()
  })

  it('자기가 만든 워크스페이스 이름을 바꾼다', async () => {
    await name_({ workspaceId: 'ws-child', name: 'Child work' })
    expect(state.workspaces[1].autoName).toBe('Child work')
  })

  it('남이 만든 워크스페이스는 거부한다', async () => {
    state.workspaces[1] = { ...child, createdByWorkspaceId: 'someone-else' }
    await expect(name_({ workspaceId: 'ws-child', name: 'No' })).rejects.toThrow(
      /not created by this/
    )
  })

  it('도는 중인 자식도 이름을 바꾼다', async () => {
    state.workspaces[1] = { ...child, status: 'running' }
    await expect(name_({ workspaceId: 'ws-child', name: 'Running child' })).resolves.toMatchObject({
      autoName: 'Running child'
    })
  })

  it('아카이브된 자식은 거부한다', async () => {
    state.workspaces[1] = { ...child, archived: true }
    await expect(name_({ workspaceId: 'ws-child', name: 'Archived' })).rejects.toThrow(
      /already archived/
    )
  })

  it('빈 이름은 autoName을 지운다', async () => {
    state.workspaces[0] = { ...caller, autoName: 'Earlier' }
    await expect(name_({ name: '   ' })).resolves.toMatchObject({
      autoName: null,
      displayName: 'base'
    })
    expect(state.workspaces[0].autoName).toBeNull()
  })

  it('사람 이름은 건드리지 않고 우선순위 note를 돌려준다', async () => {
    state.workspaces[1] = { ...child, displayName: 'Human name' }
    const result = await name_({ workspaceId: 'ws-child', name: 'Agent name' })
    expect(state.workspaces[1].displayName).toBe('Human name')
    expect(state.workspaces[1].autoName).toBe('Agent name')
    expect(result).toMatchObject({
      displayName: 'Human name',
      note: expect.stringContaining('user')
    })
  })

  it('자기 id를 명시해도 self 경로로 처리한다', async () => {
    await expect(name_({ workspaceId: 'ws-caller', name: 'Explicit self' })).resolves.toMatchObject(
      {
        autoName: 'Explicit self'
      }
    )
  })
})
