import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AgentToolDeps } from './registry'
import type { Workspace } from '@shared/types'

/**
 * 스택 인계에서 지켜야 할 것들.
 *
 * 방향이 비대칭이라는 점이 핵심이다 — 부모는 자식을 **깨우고**(사용자가 방금 그 도구 호출을
 * 승인했다), 자식은 부모에게 **기록만 남긴다**(부모는 사람과 대화 중일 수 있고, 승인하지 않은
 * 턴 비용이 자식 때문에 생기면 안 된다). 이 비대칭이 무너지면 기능의 안전성이 사라진다.
 */

const clean = vi.hoisted(() => vi.fn())
const summarize = vi.hoisted(() => vi.fn())
const create = vi.hoisted(() => vi.fn())
const state = vi.hoisted(() => ({ workspaces: [] as Partial<Workspace>[] }))
const update = vi.hoisted(() =>
  vi.fn((fn: (st: { workspaces: Partial<Workspace>[] }) => void) => fn(state))
)

vi.mock('../../git', () => ({ isWorktreeClean: clean, summarizeBranch: summarize }))
vi.mock('../../workspaces', () => ({ createWorkspace: create }))
vi.mock('../../store', () => ({ getStore: () => ({ getState: () => state, update }) }))

const sendMessage = vi.fn()
const postToTranscript = vi.fn()
const broadcastState = vi.fn()
const deps = {
  scripts: {},
  broadcastState,
  sendMessage,
  postToTranscript
} as unknown as AgentToolDeps

const parent: Partial<Workspace> = {
  id: 'ws-parent',
  repoId: 'repo-1',
  branch: 'feat/base',
  baseBranch: 'main',
  name: 'base',
  worktreePath: '/tmp/wt',
  parentWorkspaceId: null,
  archived: false
}

const child: Partial<Workspace> = {
  id: 'ws-child',
  repoId: 'repo-1',
  branch: 'feat/next',
  name: 'next',
  worktreePath: '/tmp/wt-child',
  parentWorkspaceId: 'ws-parent',
  // 대상을 받는 도구의 권한 근거는 부모 관계가 아니라 생성자다([[agent/tools/target]]).
  createdByWorkspaceId: 'ws-parent',
  archived: false,
  status: 'idle',
  prNumber: null
}

beforeEach(() => {
  vi.clearAllMocks()
  state.workspaces = [{ ...parent }]
  clean.mockResolvedValue(true)
  summarize.mockResolvedValue(null)
  create.mockResolvedValue({ workspaceId: 'ws-new', name: 'feat/next', branch: 'feat/next' })
})

async function create_(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const { createStackedWorkspace } = await import('./stackedWorkspace')
  return createStackedWorkspace(deps, 'ws-parent', args) as Promise<Record<string, unknown>>
}

async function report(
  args: Record<string, unknown>,
  from = 'ws-child'
): Promise<Record<string, unknown>> {
  const { reportToParent } = await import('./stackedWorkspace')
  return reportToParent(deps, from, args) as Promise<Record<string, unknown>>
}

async function check(from = 'ws-parent'): Promise<Record<string, unknown>> {
  const { checkStackedWork } = await import('./stackedWorkspace')
  return checkStackedWork(deps, from, {}) as Promise<Record<string, unknown>>
}

async function notify(
  args: Record<string, unknown>,
  from = 'ws-parent'
): Promise<Record<string, unknown>> {
  const { notifyChild } = await import('./stackedWorkspace')
  return notifyChild(deps, from, args) as Promise<Record<string, unknown>>
}

describe('create_stacked_workspace', () => {
  it('호출한 워크스페이스를 부모로 넘긴다(모델이 지목할 수 없다)', async () => {
    await create_({ name: 'feat/next' })

    expect(create).toHaveBeenCalledWith(deps, {
      repoId: 'repo-1',
      parentWorkspaceId: 'ws-parent',
      createdByWorkspaceId: 'ws-parent',
      name: 'feat/next'
    })
  })

  // 부모 관계와 생성자는 다른 질문이다 — 사람이 UI 에서 만든 스택 자식은 부모가 있어도 생성자가
  // 없다. 여기서 생성자를 빠뜨리면 에이전트가 자기가 만든 자식조차 아카이브하지 못한다.
  it('생성자를 부모 관계와 따로 남긴다', async () => {
    await create_()
    expect(create.mock.calls[0][1]).toMatchObject({ createdByWorkspaceId: 'ws-parent' })
  })

  it('이름을 안 주면 Wooi 가 짓도록 넘기지 않는다', async () => {
    await create_({})
    expect(create).toHaveBeenCalledWith(deps, {
      repoId: 'repo-1',
      parentWorkspaceId: 'ws-parent',
      createdByWorkspaceId: 'ws-parent'
    })
  })

  it('공백뿐인 이름도 안 준 것으로 본다', async () => {
    await create_({ name: '   ' })
    expect(create.mock.calls[0][1]).not.toHaveProperty('name')
  })

  it('새 브랜치가 갈라진 base 를 알려 준다', async () => {
    await expect(create_()).resolves.toMatchObject({
      workspaceId: 'ws-new',
      branch: 'feat/next',
      baseBranch: 'feat/base'
    })
  })

  it('미커밋 변경이 있으면 거부하고 워크스페이스를 만들지 않는다', async () => {
    clean.mockResolvedValue(false)

    await expect(create_()).rejects.toThrow(/uncommitted changes/)
    expect(create).not.toHaveBeenCalled()
  })

  it('아카이브된 워크스페이스 위에는 쌓지 않는다', async () => {
    state.workspaces = [{ ...parent, archived: true }]

    await expect(create_()).rejects.toThrow(/archived/)
    expect(create).not.toHaveBeenCalled()
  })

  it('사라진 워크스페이스면 던진다', async () => {
    state.workspaces = []
    await expect(create_()).rejects.toThrow(/no longer exists/)
  })

  it('생성 실패는 도구 오류로 올린다', async () => {
    create.mockResolvedValue({ error: 'branch already exists' })
    await expect(create_()).rejects.toThrow('branch already exists')
  })

  it('전달 실패는 생성을 막지 않지만 결과에 남긴다', async () => {
    create.mockResolvedValue({
      workspaceId: 'ws-new',
      branch: 'feat/next',
      carryFailures: [{ path: '.env', reason: 'missing', agentContext: false }]
    })

    await expect(create_()).resolves.toMatchObject({
      workspaceId: 'ws-new',
      carryFailures: ['.env: missing']
    })
  })
})

describe('create_stacked_workspace 의 작업 인계', () => {
  it('task 를 주면 새 워크스페이스로 보내 바로 일을 시작시킨다', async () => {
    await create_({ task: 'Add the login form.' })

    expect(sendMessage).toHaveBeenCalledTimes(1)
    const [target, text] = sendMessage.mock.calls[0]
    expect(target).toBe('ws-new')
    expect(text).toContain('Add the login form.')
  })

  it('보고 규약을 앱이 붙인다 — 부모 모델이 빠뜨려도 고리가 끊기지 않게', async () => {
    await create_({ task: 'Add the login form.' })

    const [, text] = sendMessage.mock.calls[0]
    expect(text).toContain('report_to_parent')
    // 자식은 자기가 어디에 쌓였는지도 알아야 PR base 를 이해한다.
    expect(text).toContain('feat/base')
  })

  it('보고 의무를 이 작업 하나로 묶는다', async () => {
    // "끝나면 보고하라" 만 남기면 이 문장이 자식 맥락에 영원히 살아, 인계가 끝난 뒤 사용자와
    // 나누는 평범한 대화의 매 턴 끝마다 보고가 나간다.
    await create_({ task: 'Add the login form.' })

    const [, text] = sendMessage.mock.calls[0]
    expect(text).toContain('once')
    expect(text).toContain('closes the handoff')
  })

  it('task 가 없으면 아무것도 보내지 않고 그 사실을 알려 준다', async () => {
    const result = await create_({})

    expect(sendMessage).not.toHaveBeenCalled()
    expect(result.started).toBe(false)
    expect(result.note).toMatch(/idle/)
  })

  it('공백뿐인 task 는 안 준 것으로 본다', async () => {
    await create_({ task: '  \n ' })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('부모에게 보고가 저절로 오지 않는다는 것을 결과로 알려 준다', async () => {
    // 상시 안내에서 뺀 절반이다 — 여기서마저 빠지면 부모는 오지 않을 보고를 기다린다.
    const result = await create_({ task: 'Add the login form.' })
    expect(result.next).toContain('check_stacked_work')
  })
})

describe('물려받은 코드 요약', () => {
  it('부모 브랜치가 이미 담고 있는 커밋과 파일을 인계문에 붙인다', async () => {
    summarize.mockResolvedValue({
      commits: ['d86b7e2 feat: 계산 엔진 구현'],
      files: ['src/calc.js (+82 −4)'],
      omittedCommits: 0,
      omittedFiles: 0
    })

    await create_({ task: 'Turn it into a CLI.' })

    // 요약은 **부모** 워크트리에서, 부모의 base 기준으로 읽어야 한다. 갓 만들어진 자식에는
    // 아직 아무 커밋도 없다.
    expect(summarize).toHaveBeenCalledWith('/tmp/wt', 'main')
    const [, text] = sendMessage.mock.calls[0]
    expect(text).toContain('d86b7e2 feat: 계산 엔진 구현')
    expect(text).toContain('src/calc.js (+82 −4)')
  })

  it('잘린 항목이 있으면 몇 개가 빠졌는지 밝힌다', async () => {
    summarize.mockResolvedValue({
      commits: ['abc1234 refactor: 정리'],
      files: ['src/a.ts (+10 −2)'],
      omittedCommits: 3,
      omittedFiles: 120
    })

    await create_({ task: 'Next piece.' })

    const [, text] = sendMessage.mock.calls[0]
    expect(text).toContain('3 older commits')
    expect(text).toContain('120 more files')
  })

  it('요약에 실패해도 인계는 그대로 이뤄진다', async () => {
    // 요약은 자식을 빠르게 만들 뿐이다 — 없다고 인계가 틀리지는 않으므로 막아서는 안 된다.
    summarize.mockRejectedValue(new Error('git exploded'))

    await create_({ task: 'Next piece.' })

    expect(sendMessage).toHaveBeenCalledTimes(1)
    const [, text] = sendMessage.mock.calls[0]
    expect(text).toContain('Next piece.')
    expect(text).not.toContain('already contains')
  })
})

describe('report_to_parent', () => {
  beforeEach(() => {
    state.workspaces = [{ ...parent }, { ...child }]
  })

  it('보고를 자기 레코드에 남긴다(부모에 쌓지 않는다)', async () => {
    await report({ summary: 'Added the form.' })

    const self = state.workspaces.find((w) => w.id === 'ws-child')
    expect(self?.handoff).toMatchObject({ status: 'done', summary: 'Added the form.' })
  })

  it('부모 대화에 카드를 남기되 부모 세션을 깨우지 않는다', async () => {
    await report({ summary: 'Added the form.' })

    expect(postToTranscript).toHaveBeenCalledTimes(1)
    const [target, item] = postToTranscript.mock.calls[0]
    expect(target).toBe('ws-parent')
    expect(item).toMatchObject({
      type: 'handoff',
      childWorkspaceId: 'ws-child',
      childBranch: 'feat/next',
      summary: 'Added the form.'
    })
    // 이것이 이 기능의 안전 규약이다 — 자식이 부모의 턴을 시작시키지 않는다.
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('blocked 를 그대로 싣는다 — 부모가 취할 행동이 갈리는 지점이다', async () => {
    await report({ summary: 'Need a decision on the schema.', status: 'blocked' })

    const self = state.workspaces.find((w) => w.id === 'ws-child')
    expect(self?.handoff?.status).toBe('blocked')
    expect(postToTranscript.mock.calls[0][1]).toMatchObject({ status: 'blocked' })
  })

  it('모르는 status 는 done 으로 접는다', async () => {
    await report({ summary: 'x', status: 'halfway' })
    expect(state.workspaces.find((w) => w.id === 'ws-child')?.handoff?.status).toBe('done')
  })

  it('다시 보고하면 덮어쓴다', async () => {
    await report({ summary: 'first' })
    await report({ summary: 'second' })

    expect(state.workspaces.find((w) => w.id === 'ws-child')?.handoff?.summary).toBe('second')
  })

  it('최초 1회 보고가 인계를 닫는다고 알려 준다', async () => {
    // 의무가 계속 살아 있으면 자식은 인계가 끝난 뒤에도 매 턴 끝마다 보고하고, 부모에는 같은
    // 카드가, 사용자에게는 승인 카드가 계속 쌓인다.
    const result = await report({ summary: 'Added the form.' })
    expect(result.note).toMatch(/closes the handoff/)
  })

  it('두 번째부터는 덮어썼다고만 말한다 — 다시 의무를 지우지 않는다', async () => {
    await report({ summary: 'first' })
    const result = await report({ summary: 'second' })

    expect(result.note).toMatch(/replaced your earlier report/)
    expect(result.note).not.toMatch(/closes the handoff/)
  })

  it('빈 요약은 거부한다 — 알림만 뜨고 내용이 없으면 부모가 할 수 있는 게 없다', async () => {
    await expect(report({ summary: '   ' })).rejects.toThrow(/empty/)
    expect(postToTranscript).not.toHaveBeenCalled()
  })

  it('스택 뿌리에서는 보고할 곳이 없다', async () => {
    await expect(report({ summary: 'x' }, 'ws-parent')).rejects.toThrow(/not stacked/)
  })

  it('부모가 사라졌으면 던진다', async () => {
    state.workspaces = [{ ...child }]
    await expect(report({ summary: 'x' })).rejects.toThrow(/parent workspace no longer exists/)
  })
})

describe('notify_child', () => {
  beforeEach(() => {
    state.workspaces = [{ ...parent }, { ...child }]
  })

  it('자식을 깨운다 — 부모 → 자식 방향은 기록이 아니라 메시지다', async () => {
    await notify({ workspaceId: 'ws-child', message: 'I moved the auth helper to src/auth.ts.' })

    expect(sendMessage).toHaveBeenCalledTimes(1)
    const [target, text] = sendMessage.mock.calls[0]
    expect(target).toBe('ws-child')
    expect(text).toContain('I moved the auth helper to src/auth.ts.')
  })

  it('부모에게서 온 말이라는 것을 자식이 알 수 있게 한다', async () => {
    // 자식 쪽에는 사용자 메시지로 도착한다. 출처를 밝히지 않으면 자식은 사람이 시킨 새 작업으로
    // 읽고, 하던 일을 버린다.
    await notify({ workspaceId: 'ws-child', message: 'Schema changed.' })

    const [, text] = sendMessage.mock.calls[0]
    expect(text).toContain('feat/base')
    expect(text).toContain('not from the user')
  })

  it('도는 중이면 현재 턴 뒤에 읽힌다고 알려 준다', async () => {
    state.workspaces = [{ ...parent }, { ...child, status: 'running' }]

    const result = await notify({ workspaceId: 'ws-child', message: 'Schema changed.' })
    expect(result.note).toMatch(/current turn ends/)
    // 도는 중이라고 막지는 않는다 — 낡은 전제로 일하는 중일 때가 바로 알려야 할 때다.
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it('자기가 만들지 않은 워크스페이스는 거부한다 — 대상 경계는 target.ts 가 정한다', async () => {
    // 가드를 이 도구가 다시 발명하지 않는다는 것이 요점이다. 사람이 UI 에서 만든 스택 자식은
    // 부모가 있어도 생성자가 없으므로 여기서 걸린다.
    state.workspaces = [{ ...parent }, { ...child, createdByWorkspaceId: null }]

    await expect(notify({ workspaceId: 'ws-child', message: 'hi' })).rejects.toThrow(
      /not created by this workspace/
    )
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('내가 만들었어도 내 위에 쌓인 게 아니면 거부한다', async () => {
    // 권한이 아니라 문장의 참이다 — 통지문은 "네 아래 브랜치에서 온 소식" 이라고 말하는데,
    // 독립 워크스페이스(create_workspace)에 그 문장을 보내면 거짓말이 된다.
    state.workspaces = [
      { ...parent },
      { ...child, id: 'ws-solo', parentWorkspaceId: null, createdByWorkspaceId: 'ws-parent' }
    ]

    await expect(notify({ workspaceId: 'ws-solo', message: 'hi' })).rejects.toThrow(
      /not stacked on this workspace/
    )
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('모르는 id 는 거부한다', async () => {
    await expect(notify({ workspaceId: 'ws-nope', message: 'hi' })).rejects.toThrow(
      /No Wooi workspace has the id/
    )
  })

  it('아카이브된 자식에는 보내지 않는다 — worktree 도 세션도 없다', async () => {
    state.workspaces = [{ ...parent }, { ...child, archived: true }]

    await expect(notify({ workspaceId: 'ws-child', message: 'hi' })).rejects.toThrow(/archived/)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('빈 메시지는 거부한다 — 자식의 턴만 쓰고 아무것도 전하지 못한다', async () => {
    await expect(notify({ workspaceId: 'ws-child', message: '  \n ' })).rejects.toThrow(/empty/)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('부모가 사라졌으면 던진다', async () => {
    state.workspaces = [{ ...child }]
    await expect(notify({ workspaceId: 'ws-child', message: 'hi' })).rejects.toThrow(
      /no longer exists/
    )
  })
})

describe('check_stacked_work', () => {
  it('자식들의 상태와 마지막 보고를 돌려준다', async () => {
    state.workspaces = [
      { ...parent },
      { ...child, status: 'running' },
      {
        ...child,
        id: 'ws-child-2',
        branch: 'feat/other',
        handoff: { status: 'done', summary: 'shipped', at: 1 }
      }
    ]

    const result = (await check()) as { children: Array<Record<string, unknown>> }

    expect(result.children).toHaveLength(2)
    expect(result.children[0]).toMatchObject({ branch: 'feat/next', running: true, report: null })
    expect(result.children[1]).toMatchObject({
      branch: 'feat/other',
      running: false,
      report: { status: 'done', summary: 'shipped' }
    })
  })

  it('지목할 수 있는 자식인지 함께 알려 준다', async () => {
    // 모델이 자식의 id 를 보는 곳이 여기다. 무엇을 지목할 수 있는지도 여기서 읽히지 않으면
    // notify_child 를 불러 보고 거절당하는 것으로만 알게 된다.
    state.workspaces = [
      { ...parent },
      { ...child },
      { ...child, id: 'ws-by-human', branch: 'feat/human', createdByWorkspaceId: null }
    ]

    const result = (await check()) as { children: Array<Record<string, unknown>> }

    expect(result.children[0]).toMatchObject({ branch: 'feat/next', createdByYou: true })
    expect(result.children[1]).toMatchObject({ branch: 'feat/human', createdByYou: false })
  })

  it('손자(자식의 자식)는 세지 않는다 — 직계만 본다', async () => {
    state.workspaces = [
      { ...parent },
      { ...child },
      { ...child, id: 'ws-grandchild', parentWorkspaceId: 'ws-child' }
    ]

    const result = (await check()) as { children: unknown[] }
    expect(result.children).toHaveLength(1)
  })

  it('자식이 없으면 그렇다고 말해 준다', async () => {
    state.workspaces = [{ ...parent }]

    await expect(check()).resolves.toMatchObject({ children: [], note: expect.any(String) })
  })
})
