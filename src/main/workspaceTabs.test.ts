import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState, Workspace } from '@shared/types'
import { IPC } from '@shared/types'

let userData = ''

vi.mock('electron', () => ({
  app: { getPath: (): string => userData }
}))

const WS_ID = 'ws-1'

async function seedWorkspace(): Promise<void> {
  const { getStore } = await import('./store')
  getStore().update((s: AppState) => {
    s.workspaces = [{ id: WS_ID, worktreePath: '/tmp/ws-1' } as Workspace]
  })
}

beforeAll(() => {
  userData = mkdtempSync(join(tmpdir(), 'wooi-workspacetabs-test-'))
})

afterAll(() => {
  rmSync(userData, { recursive: true, force: true })
})

beforeEach(async () => {
  await seedWorkspace()
})

async function makeManager(dispatch = vi.fn()): Promise<{
  manager: import('./workspaceTabs').WorkspaceTabManager
  dispatch: ReturnType<typeof vi.fn>
}> {
  const { WorkspaceTabManager } = await import('./workspaceTabs')
  return { manager: new WorkspaceTabManager(dispatch), dispatch }
}

describe('WorkspaceTabManager', () => {
  it('탭이 없으면 작업 탭 하나를 만들어 영속하고, index 0 에서 활성으로 잡는다', async () => {
    const { manager } = await makeManager()

    const state = manager.tabs(WS_ID)

    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0]).toMatchObject({ id: 'work', kind: 'work' })
    expect(state.activeId).toBe('work')
    const { getStore } = await import('./store')
    expect(getStore().getState().workspaces[0].tabs).toEqual(state.tabs)
  })

  it('다른 탭을 작업 탭보다 앞에 두려 해도 정규화가 작업 탭을 index 0 으로 되돌린다', async () => {
    const { manager } = await makeManager()
    manager.tabs(WS_ID) // 작업 탭 생성

    const { getStore } = await import('./store')
    getStore().update((s: AppState) => {
      const ws = s.workspaces.find((w) => w.id === WS_ID)!
      // 다른 경로(레거시 데이터 등)로 순서가 흐트러진 상태를 흉내낸다.
      ws.tabs = [
        { id: 'file-1', kind: 'file', target: 'a.ts' },
        { id: 'work', kind: 'work' }
      ]
    })

    const state = manager.tabs(WS_ID)
    expect(state.tabs.map((t) => t.id)).toEqual(['work', 'file-1'])
  })

  it('closeTab(chat) 은 조용히 무시된다', async () => {
    const { manager } = await makeManager()
    manager.tabs(WS_ID)

    const state = manager.closeTab(WS_ID, 'work')

    expect(state.tabs.map((t) => t.id)).toEqual(['work'])
    expect(state.activeId).toBe('work')
  })

  it('탭을 닫으면 이웃이 활성이 된다', async () => {
    const { manager } = await makeManager()
    manager.tabs(WS_ID)
    const a = manager.openTab(WS_ID, { kind: 'file', target: 'a.ts' }).activeId
    const b = manager.openTab(WS_ID, { kind: 'file', target: 'b.ts' }).activeId
    expect(manager.tabs(WS_ID).tabs.map((t) => t.id)).toEqual(['work', a, b])

    // 가운데(a)를 닫으면 오른쪽 이웃(b)이 활성이 된다.
    manager.selectTab(WS_ID, a)
    const state = manager.closeTab(WS_ID, a)

    expect(state.tabs.map((t) => t.id)).toEqual(['work', b])
    expect(state.activeId).toBe(b)
  })

  it('activeTabId 가 사라진 탭을 가리키면 정규화가 작업 탭으로 되돌린다', async () => {
    const { manager } = await makeManager()
    manager.tabs(WS_ID)

    const { getStore } = await import('./store')
    getStore().update((s: AppState) => {
      const ws = s.workspaces.find((w) => w.id === WS_ID)!
      ws.activeTabId = 'nonexistent'
    })

    const state = manager.tabs(WS_ID)
    expect(state.activeId).toBe('work')
  })

  it('같은 kind+target 을 다시 열면 새 탭이 안 생기고 그것이 활성이 된다', async () => {
    const { manager } = await makeManager()
    manager.tabs(WS_ID)

    const first = manager.openTab(WS_ID, { kind: 'file', target: 'a.ts' })
    expect(first.tabs).toHaveLength(2)

    manager.openTab(WS_ID, { kind: 'file', target: 'b.ts' }) // 다른 탭으로 활성 이동
    const again = manager.openTab(WS_ID, { kind: 'file', target: 'a.ts' })

    expect(again.tabs).toHaveLength(3) // a, b 두 개뿐 + chat
    expect(again.activeId).toBe(first.tabs[1].id)
  })

  it('닫은 탭을 reopenTab 으로 되살린다', async () => {
    const { manager } = await makeManager()
    manager.tabs(WS_ID)
    const opened = manager.openTab(WS_ID, { kind: 'web', target: 'https://example.com' })
    const tabId = opened.activeId

    manager.closeTab(WS_ID, tabId)
    expect(manager.tabs(WS_ID).tabs.map((t) => t.id)).toEqual(['work'])

    const revived = manager.reopenTab(WS_ID)
    expect(revived.tabs.map((t) => t.id)).toEqual(['work', tabId])
    expect(revived.activeId).toBe(tabId)
  })

  it('닫은 탭 스택은 상한 10 을 넘으면 오래된 것부터 버린다', async () => {
    const { manager } = await makeManager()
    manager.tabs(WS_ID)

    const closedIds: string[] = []
    for (let i = 0; i < 11; i++) {
      const tabId = manager.openTab(WS_ID, { kind: 'file', target: `f${i}.ts` }).activeId
      manager.closeTab(WS_ID, tabId)
      closedIds.push(tabId)
    }

    // 상한(10)을 넘겨 가장 먼저 닫은 탭(closedIds[0])은 스택에서 버려졌어야 한다.
    for (let i = 0; i < 10; i++) {
      const revived = manager.reopenTab(WS_ID)
      expect(revived.activeId).not.toBe(closedIds[0])
    }
    // 스택이 비었으므로 더 되살릴 것이 없다 — 상태가 그대로 유지된다.
    const before = manager.tabs(WS_ID)
    const after = manager.reopenTab(WS_ID)
    expect(after.tabs).toEqual(before.tabs)
  })

  it('워크스페이스 레코드에 실제로 영속된다', async () => {
    const { manager } = await makeManager()
    manager.openTab(WS_ID, { kind: 'dev', target: 'http://localhost:3100' })

    const { getStore } = await import('./store')
    const persisted = getStore().getState().workspaces[0].tabs
    expect(persisted).toHaveLength(2)
    expect(persisted?.[0].kind).toBe('work')
    expect(persisted?.[1].kind).toBe('dev')
  })

  it('visualization 탭은 선택되지만 workspace 레코드에는 영속하지 않는다', async () => {
    const { manager } = await makeManager()
    const opened = manager.openVisualization(
      WS_ID,
      'wooi-artifact://a/visualization/opaque.html',
      'Chart'
    )
    const tab = opened.tabs.find((item) => item.kind === 'visualization')!
    expect(opened.activeId).toBe(tab.id)

    const { getStore } = await import('./store')
    expect(
      getStore()
        .getState()
        .workspaces[0].tabs?.some((item) => item.kind === 'visualization')
    ).toBe(false)
    expect(manager.tabs(WS_ID).tabs.some((item) => item.id === tab.id)).toBe(true)

    manager.disposeWorkspace(WS_ID)
    expect(manager.tabs(WS_ID).tabs.some((item) => item.id === tab.id)).toBe(false)
  })

  it('background open과 unknown select는 활성 visualization을 유지한다', async () => {
    const { manager } = await makeManager()
    const opened = manager.openVisualization(WS_ID, 'wooi-artifact://a/visualization/opaque.html')
    const activeId = opened.activeId

    expect(
      manager.openTab(WS_ID, { kind: 'file', target: 'README.md', activate: false }).activeId
    ).toBe(activeId)
    expect(manager.selectTab(WS_ID, 'missing-tab').activeId).toBe(activeId)
  })

  it('변경은 evtWorkspaceTabs 로 방송되고, 읽기(정규화)는 방송하지 않는다', async () => {
    const { manager, dispatch } = await makeManager()

    manager.tabs(WS_ID) // 읽기 — 정규화가 일어나도 방송하지 않는다.
    expect(dispatch).not.toHaveBeenCalled()

    manager.openTab(WS_ID, { kind: 'stack', target: WS_ID })
    expect(dispatch).toHaveBeenCalledWith(
      IPC.evtWorkspaceTabs,
      expect.objectContaining({ workspaceId: WS_ID })
    )
  })

  it('disposeWorkspace 는 그 워크스페이스의 닫은 탭 스택만 비운다(탭 목록은 그대로)', async () => {
    const { manager } = await makeManager()
    manager.tabs(WS_ID)
    const tabId = manager.openTab(WS_ID, { kind: 'artifact', target: 'a@1' }).activeId
    manager.closeTab(WS_ID, tabId)

    manager.disposeWorkspace(WS_ID)

    // 닫은 탭 스택이 비었으니 되살릴 것이 없다.
    const before = manager.tabs(WS_ID)
    const after = manager.reopenTab(WS_ID)
    expect(after.tabs).toEqual(before.tabs)
  })
})
