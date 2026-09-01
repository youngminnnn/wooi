import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { emptyView } from './lib/review'
import { app, workspace } from './test/fixtures'
import { dispatch, fakeApi, resetStore, startStoreSubscriptions, useStore } from './test/harness'

beforeAll(async () => {
  await startStoreSubscriptions()
})

beforeEach(() => {
  resetStore()
})

describe('렌더러 스토어 계약', () => {
  it('연속 텍스트 델타를 묶고 다음 상태 이벤트보다 먼저 반영한다', () => {
    const ws = workspace({ status: 'running' })
    useStore.setState({ app: app([ws]) })

    dispatch('onChat', {
      workspaceId: ws.id,
      event: { type: 'delta', id: 'answer', itemType: 'assistant', text: 'hello ' }
    })
    dispatch('onChat', {
      workspaceId: ws.id,
      event: { type: 'delta', id: 'answer', itemType: 'assistant', text: 'world' }
    })
    expect(useStore.getState().transcripts[ws.id]).toBeUndefined()

    dispatch('onChat', { workspaceId: ws.id, event: { type: 'status', status: 'idle' } })
    expect(useStore.getState().transcripts[ws.id]?.[0]).toMatchObject({
      id: 'answer',
      text: 'hello world',
      streaming: true
    })
  })

  it('git 상태가 같으면 store 참조를 유지하고 전체 조회에 lightweight 힌트를 보낸다', async () => {
    const ws = workspace()
    const status = {
      branch: 'main',
      ahead: 0,
      behind: 0,
      changedFiles: 0,
      conflicted: false,
      rebasing: false
    }
    fakeApi.override('git.status', () => status)
    useStore.setState({ app: app([ws]) })

    await useStore.getState().refreshAllGit()
    const first = useStore.getState().gitStatus
    await useStore.getState().refreshAllGit()

    expect(useStore.getState().gitStatus).toBe(first)
    expect(fakeApi.called('git.status').map((call) => call.args)).toEqual([
      [ws.id, false],
      [ws.id, false]
    ])
  })

  it('실행 중 방송에는 대기 메시지를 보내지 않고 idle 방송에서만 순서대로 보낸다', () => {
    const ws = workspace({ status: 'running' })
    useStore.setState({ app: app([ws]), messageQueue: { [ws.id]: [{ text: 'next' }] } })

    dispatch('onChat', { workspaceId: ws.id, event: { type: 'status', status: 'running' } })
    expect(fakeApi.called('chat.send')).toHaveLength(0)
    expect(useStore.getState().messageQueue[ws.id]).toHaveLength(1)

    dispatch('onChat', { workspaceId: ws.id, event: { type: 'status', status: 'idle' } })
    expect(fakeApi.called('chat.send').map((call) => call.args.slice(0, 2))).toEqual([
      [ws.id, 'next']
    ])
  })

  it('idle에서 에이전트 행만 지우고 백그라운드 셸 행은 유지한다', () => {
    const ws = workspace({ status: 'running' })
    const shell = {
      taskId: 'shell',
      taskType: 'local_bash',
      agentType: 'Bash',
      description: 'server',
      startedAt: 1
    }
    const agent = { taskId: 'agent', agentType: 'Explore', description: 'inspect', startedAt: 1 }
    useStore.setState({ app: app([ws]), runningAgents: { [ws.id]: [shell, agent] } })

    dispatch('onChat', { workspaceId: ws.id, event: { type: 'status', status: 'idle' } })

    expect(useStore.getState().runningAgents[ws.id]).toEqual([shell])
  })

  it('아카이브가 끝나기 전에 다른 워크스페이스를 고르면 그 선택을 유지한다', async () => {
    const first = workspace()
    const second = workspace({ id: 'workspace-2', name: 'other' })
    let finish!: () => void
    fakeApi.override('workspace.archive', () => new Promise<void>((resolve) => (finish = resolve)))
    useStore.setState({ app: app([first, second]), selectedWorkspaceId: first.id })

    const archiving = useStore.getState().archiveWorkspace(first.id)
    useStore.setState({ selectedWorkspaceId: second.id })
    finish()
    await archiving

    expect(useStore.getState().selectedWorkspaceId).toBe(second.id)
  })

  it('작업 패널 열림 상태를 워크스페이스마다 따로 기억한다', () => {
    const first = workspace()
    const second = workspace({ id: 'workspace-2' })
    useStore.setState({ app: app([first, second]), selectedWorkspaceId: first.id })

    useStore.getState().toggleRightPanel()
    useStore.setState({ selectedWorkspaceId: second.id })
    useStore.getState().toggleRightPanel()
    useStore.getState().toggleRightPanel()

    expect(useStore.getState().rightPanelOpen).toEqual({ [first.id]: false, [second.id]: true })
  })

  it('파일 봤음 낙관적 표시를 main 저장 실패 시 이전 값으로 되돌린다', async () => {
    const file = {
      path: 'src/a.ts',
      oldPath: null,
      status: 'modified' as const,
      additions: 1,
      deletions: 0,
      binary: false,
      hunks: []
    }
    const view = {
      ...emptyView(),
      loaded: true,
      diffs: [{ prNumber: 42, diff: { files: [file] } }]
    }
    let finish!: (value: { error: string }) => void
    fakeApi.override('review.setFileViewed', () => new Promise((resolve) => (finish = resolve)))
    useStore.setState({ reviewViews: { review: view } })

    const saving = useStore.getState().toggleFileViewed('review', file.path)
    expect(Object.values(useStore.getState().reviewViews.review.viewed)[0]).toBeTruthy()
    finish({ error: 'disk full' })
    await saving

    expect(useStore.getState().reviewViews.review.viewed).toEqual({})
  })
})

describe('나란히 편 두 칸', () => {
  const parent = workspace({ id: 'parent', name: 'parent' })
  const child = workspace({ id: 'child', name: 'child', parentWorkspaceId: 'parent' })
  const loner = workspace({ id: 'loner', name: 'loner' })

  const stackApp = (): void => {
    useStore.setState({ app: app([parent, child, loner]), selectedWorkspaceId: parent.id })
  }

  it('⌘+클릭으로 같은 스택의 층을 옆에 세우고 포커스를 그쪽에 준다', () => {
    stackApp()
    useStore.getState().openSplitPane({ kind: 'workspace', workspaceId: child.id })

    const s = useStore.getState()
    expect(s.splitPane).toEqual({ kind: 'workspace', workspaceId: child.id })
    expect(s.splitFocus).toBe('split')
    // 주 칸은 그대로다 — 옆에 세우는 것이지 옮겨 가는 것이 아니다.
    expect(s.selectedWorkspaceId).toBe(parent.id)
  })

  it('스택이 다른 워크스페이스는 세우지 않고 이유를 알려 준다', () => {
    stackApp()
    useStore.getState().openSplitPane({ kind: 'workspace', workspaceId: loner.id })

    const s = useStore.getState()
    expect(s.splitPane).toBeNull()
    expect(s.toasts.map((t) => t.kind)).toEqual(['info'])
  })

  it('분할 중 사이드바 선택은 포커스된 칸만 갈아 끼운다 — 주 칸은 건드리지 않는다', async () => {
    stackApp()
    const grandchild = workspace({ id: 'gc', name: 'gc', parentWorkspaceId: 'child' })
    useStore.setState({ app: app([parent, child, grandchild, loner]) })
    useStore.getState().openSplitPane({ kind: 'workspace', workspaceId: child.id })

    await useStore.getState().selectWorkspace(grandchild.id)

    const s = useStore.getState()
    expect(s.selectedWorkspaceId).toBe(parent.id)
    expect(s.splitPane).toEqual({ kind: 'workspace', workspaceId: grandchild.id })
  })

  it('포커스가 주 칸이면 주 칸이 바뀌고 짝은 남는다', async () => {
    stackApp()
    const grandchild = workspace({ id: 'gc', name: 'gc', parentWorkspaceId: 'child' })
    useStore.setState({ app: app([parent, child, grandchild, loner]) })
    useStore.getState().openSplitPane({ kind: 'workspace', workspaceId: child.id })
    useStore.getState().focusPane('main')

    await useStore.getState().selectWorkspace(grandchild.id)

    const s = useStore.getState()
    expect(s.selectedWorkspaceId).toBe(grandchild.id)
    expect(s.splitPane).toEqual({ kind: 'workspace', workspaceId: child.id })
  })

  it('짝이 깨지는 것을 고르면 분할을 접고 고른 것만 남긴다', async () => {
    stackApp()
    useStore.getState().openSplitPane({ kind: 'workspace', workspaceId: child.id })

    await useStore.getState().selectWorkspace(loner.id)

    const s = useStore.getState()
    expect(s.splitPane).toBeNull()
    expect(s.splitFocus).toBe('main')
    expect(s.selectedWorkspaceId).toBe(loner.id)
  })

  it('오른쪽 칸을 닫으면 주 칸만 남는다', () => {
    stackApp()
    useStore.getState().openSplitPane({ kind: 'workspace', workspaceId: child.id })

    useStore.getState().closeFocusedPane()

    const s = useStore.getState()
    expect(s.splitPane).toBeNull()
    expect(s.selectedWorkspaceId).toBe(parent.id)
  })

  it('주 칸을 닫으면 오른쪽이 그 자리로 올라온다', async () => {
    stackApp()
    useStore.getState().openSplitPane({ kind: 'workspace', workspaceId: child.id })
    useStore.getState().focusPane('main')

    useStore.getState().closeFocusedPane()
    await Promise.resolve()

    const s = useStore.getState()
    expect(s.splitPane).toBeNull()
    expect(s.selectedWorkspaceId).toBe(child.id)
  })

  it('전체 화면 스택 뷰를 열면 분할은 접힌다 — 한 화면을 통째로 쓰는 축 옆에는 자리가 없다', () => {
    stackApp()
    useStore.getState().openSplitPane({ kind: 'workspace', workspaceId: child.id })

    useStore.getState().openStackView(parent.id)

    expect(useStore.getState().splitPane).toBeNull()
    expect(useStore.getState().activeStackWorkspaceId).toBe(parent.id)
  })

  it('Overview 로 나가면 분할도 함께 접는다', async () => {
    stackApp()
    useStore.getState().openSplitPane({ kind: 'workspace', workspaceId: child.id })

    await useStore.getState().selectWorkspace(null)

    expect(useStore.getState().splitPane).toBeNull()
  })

  it('아카이브된 워크스페이스는 옆에 세우지 않는다 — 대조할 워크트리가 없다', () => {
    const gone = { ...child, archived: true }
    useStore.setState({ app: app([parent, gone, loner]), selectedWorkspaceId: parent.id })

    useStore.getState().openSplitPane({ kind: 'workspace', workspaceId: gone.id })

    expect(useStore.getState().splitPane).toBeNull()
    expect(useStore.getState().toasts).toHaveLength(1)
  })

  it('오른쪽 칸의 워크스페이스가 사라지면 다음 상태 방송에서 칸을 접는다', () => {
    stackApp()
    useStore.getState().openSplitPane({ kind: 'workspace', workspaceId: child.id })

    dispatch('onState', app([parent, { ...child, archived: true }, loner]))

    expect(useStore.getState().splitPane).toBeNull()
    expect(useStore.getState().splitFocus).toBe('main')
  })
})
