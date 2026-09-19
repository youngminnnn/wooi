import { randomUUID } from 'node:crypto'
import { IPC } from '@shared/types'
import type { Workspace, WorkspaceTab, WorkspaceTabKind, WorkspaceTabsState } from '@shared/types'
import { getStore } from './store'

type Dispatch = (channel: string, payload: unknown) => void

/**
 * 작업 탭의 고정 id. `TerminalTab` 과 달리 이 탭은 종류마저 고정이라(kind: 'work') 데이터 자체가
 * 하나뿐임을 안다 — 화면이 무엇을 작업 탭으로 볼지 추측할 필요가 없다.
 */
const WORK_TAB_ID = 'work'

/**
 * 워크스페이스별로 기억하는 "최근 닫은 탭" 스택의 상한. reopenTab 으로 되살리는 편의 기능일
 * 뿐이라 넉넉한 상한이면 충분하다 — 무한정 쌓아 둘 이유가 없다.
 */
const CLOSED_STACK_LIMIT = 10

/**
 * 워크스페이스 콘텐츠 영역 맨 위 탭 스트립(대화 + dev 프리뷰 + 웹 + 파일 + 아티팩트 + 스택)의
 * 탭 목록을 관리한다. `TerminalManager`(우하단 터미널)의 탭 구역과 같은 모양이다 — 목록의 단일
 * 진실 원천은 메인 프로세스(workspace 레코드)이고, 변경은 여기서만 일어나 모든 창에 방송된다
 * (작업 패널을 별도 창으로 떼어 낼 수 있어서, 만드는 창과 보는 창이 다를 수 있다).
 *
 * 터미널 탭과 다른 점 하나: **작업 탭(id='work')은 항상 존재하고 항상 index 0** 이다. "첫 탭은
 * 닫을 수 없다" 가 화면이 지키는 규칙이 아니라 여기 정규화가 강제하는 **데이터 불변식**이다 —
 * 화면이 실수로 닫기 버튼을 그려도 데이터는 깨지지 않는다.
 */
export class WorkspaceTabManager {
  /**
   * 워크스페이스별 "최근 닫은 탭" 스택(배열 끝이 가장 최근). reopenTab 이 pop 해 되살린다.
   *
   * **영속하지 않는다.** 앱을 껐다 켜고 되살릴 만한 것이 아니고, 워크스페이스 레코드에 얹으면
   * 옵셔널 필드 하나 늘리는 것치고는 값어치가 없는 마이그레이션 부담만 생긴다 — 메모리에만
   * 두고, 워크스페이스가 사라질 때(disposeWorkspace) 함께 비운다.
   */
  private closedStacks = new Map<string, WorkspaceTab[]>()
  /** Visualization handles are main-memory capabilities, never workspace persistence. */
  private visualizationTabs = new Map<string, WorkspaceTab[]>()
  private activeVisualization = new Map<string, string>()

  constructor(private dispatch: Dispatch) {}

  /**
   * workspace 의 탭 구성을 읽는다. 비어 있거나 작업 탭이 없거나(신규·레거시 workspace) 작업 탭이
   * 맨 앞이 아니거나 활성 탭이 사라졌으면 여기서 정규화해 영속한다(방송은 하지 않는다: 읽기의
   * 부수효과) — 화면은 "탭이 늘 최소 하나(대화), 대화는 늘 index 0" 을 전제로 그릴 수 있다.
   */
  tabs(workspaceId: string): WorkspaceTabsState {
    const ws = getStore()
      .getState()
      .workspaces.find((w) => w.id === workspaceId)
    if (!ws) return { workspaceId, tabs: [], activeId: '' }
    if (
      ws.tabs?.length &&
      ws.tabs[0]?.id === WORK_TAB_ID &&
      ws.tabs.some((t) => t.id === ws.activeTabId)
    ) {
      return this.withVisualizations({ workspaceId, tabs: ws.tabs, activeId: ws.activeTabId as string })
    }
    return this.mutateTabs(workspaceId, () => {}, false)
  }

  /**
   * 탭을 연다. **같은 kind+target 탭이 이미 있으면 새로 만들지 않고 그것을 활성화한다** — 같은
   * 파일·주소를 두 번 열어 탭이 쌓이는 것을 막는다. 새로 만들면 목록 끝에 붙이고 활성 탭으로 잡는다.
   */
  openTab(
    workspaceId: string,
    opts: { kind: WorkspaceTabKind; target?: string; title?: string; activate?: boolean }
  ): WorkspaceTabsState {
    if (opts.kind === 'visualization')
      throw new Error('Use openVisualization for session-only visualization tabs.')
    // 기본은 활성화다(사람이 여는 경우가 대부분이라). 에이전트가 여는 탭만 false 로 온다 —
    // 읽고 있던 대화가 예고 없이 다른 화면으로 갈리면 안 된다. 탭은 생기고, 갈지는 사람이 정한다.
    const activate = opts.activate ?? true
    if (activate) this.activeVisualization.delete(workspaceId)
    return this.mutateTabs(workspaceId, (ws) => {
      const tabs = ws.tabs ?? []
      const existing = tabs.find((t) => t.kind === opts.kind && t.target === opts.target)
      if (existing) {
        if (activate) ws.activeTabId = existing.id
        return
      }
      const tab: WorkspaceTab = { id: randomUUID(), kind: opts.kind }
      if (opts.target !== undefined) tab.target = opts.target
      if (opts.title !== undefined) tab.title = opts.title
      ws.tabs = [...tabs, tab]
      if (activate) ws.activeTabId = tab.id
    })
  }

  /** Add a non-persistent tab for an opaque visualization URL. */
  openVisualization(workspaceId: string, url: string, title?: string): WorkspaceTabsState {
    const base = this.tabs(workspaceId)
    if (!base.tabs.length) return base
    const existing = (this.visualizationTabs.get(workspaceId) ?? []).find((tab) => tab.target === url)
    const tab = existing ?? { id: randomUUID(), kind: 'visualization' as const, target: url, ...(title ? { title } : {}) }
    if (!existing) this.visualizationTabs.set(workspaceId, [...(this.visualizationTabs.get(workspaceId) ?? []), tab])
    this.activeVisualization.set(workspaceId, tab.id)
    const state = this.withVisualizations(this.persistedState(workspaceId))
    this.dispatch(IPC.evtWorkspaceTabs, state)
    return state
  }

  /**
   * 탭을 닫는다. 작업 탭(work)은 **조용히 무시한다** — 데이터 불변식을 어기라는 요청일 뿐
   * 에러가 아니다. 닫은 탭은 되살릴 수 있도록 워크스페이스별 스택에 쌓아 둔다(상한을 넘으면
   * 가장 오래된 것부터 버린다).
   */
  closeTab(workspaceId: string, tabId: string): WorkspaceTabsState {
    if (tabId === WORK_TAB_ID) return this.tabs(workspaceId)
    const visuals = this.visualizationTabs.get(workspaceId) ?? []
    if (visuals.some((tab) => tab.id === tabId)) {
      this.visualizationTabs.set(workspaceId, visuals.filter((tab) => tab.id !== tabId))
      if (this.activeVisualization.get(workspaceId) === tabId) this.activeVisualization.delete(workspaceId)
      const state = this.withVisualizations(this.persistedState(workspaceId))
      this.dispatch(IPC.evtWorkspaceTabs, state)
      return state
    }
    return this.mutateTabs(workspaceId, (ws) => {
      const tabs = ws.tabs ?? []
      const idx = tabs.findIndex((t) => t.id === tabId)
      if (idx < 0) return
      const closed = tabs[idx]
      ws.tabs = tabs.filter((t) => t.id !== tabId)

      const stack = this.closedStacks.get(workspaceId) ?? []
      stack.push(closed)
      if (stack.length > CLOSED_STACK_LIMIT) stack.shift()
      this.closedStacks.set(workspaceId, stack)

      // 닫은 탭을 보고 있었다면 오른쪽(없으면 왼쪽) 이웃으로 옮긴다. 작업 탭은 정규화가 항상
      // index 0 을 지키므로 이웃이 하나도 없는 경우는 없다.
      if (ws.activeTabId === tabId) {
        ws.activeTabId = ws.tabs[Math.min(idx, ws.tabs.length - 1)]?.id
      }
    })
  }

  /**
   * 가장 최근에 닫은 탭을 되살려 목록 끝에 붙이고 활성 탭으로 잡는다. 닫은 탭이 없으면
   * 아무것도 바꾸지 않고 현재 구성을 그대로 돌려준다.
   */
  reopenTab(workspaceId: string): WorkspaceTabsState {
    const stack = this.closedStacks.get(workspaceId)
    const revived = stack?.pop()
    if (!revived) return this.tabs(workspaceId)
    return this.mutateTabs(workspaceId, (ws) => {
      ws.tabs = [...(ws.tabs ?? []), revived]
      ws.activeTabId = revived.id
    })
  }

  /** 탭 이름을 바꾼다. 빈 이름은 지워 기본 이름(화면이 kind·target 에서 만드는 이름)으로 되돌린다. */
  renameTab(workspaceId: string, tabId: string, title: string): WorkspaceTabsState {
    const trimmed = title.trim().slice(0, 40)
    const visual = (this.visualizationTabs.get(workspaceId) ?? []).find((tab) => tab.id === tabId)
    if (visual) {
      if (trimmed) visual.title = trimmed
      else delete visual.title
      const state = this.withVisualizations(this.persistedState(workspaceId))
      this.dispatch(IPC.evtWorkspaceTabs, state)
      return state
    }
    return this.mutateTabs(workspaceId, (ws) => {
      const tab = ws.tabs?.find((t) => t.id === tabId)
      if (!tab) return
      if (trimmed) tab.title = trimmed
      else delete tab.title
    })
  }

  /** 보고 있는 탭을 바꾼다(모르는 id 는 무시). */
  selectTab(workspaceId: string, tabId: string): WorkspaceTabsState {
    if ((this.visualizationTabs.get(workspaceId) ?? []).some((tab) => tab.id === tabId)) {
      this.activeVisualization.set(workspaceId, tabId)
      const state = this.withVisualizations(this.persistedState(workspaceId))
      this.dispatch(IPC.evtWorkspaceTabs, state)
      return state
    }
    if (!this.persistedState(workspaceId).tabs.some((tab) => tab.id === tabId)) {
      return this.tabs(workspaceId)
    }
    this.activeVisualization.delete(workspaceId)
    return this.mutateTabs(workspaceId, (ws) => {
      if (ws.tabs?.some((t) => t.id === tabId)) ws.activeTabId = tabId
    })
  }

  /**
   * 탭 목록을 바꾸고(그리고 언제나 정규화하고) 결과를 방송한다.
   * 정규화 = 작업 탭을 항상 index 0 에 두고(없으면 만들고, 다른 자리에 있으면 앞으로 옮기고),
   * 활성 탭이 목록에 없으면 작업 탭으로 되돌린다.
   */
  private mutateTabs(
    workspaceId: string,
    mutate: (ws: Workspace) => void,
    broadcast = true
  ): WorkspaceTabsState {
    let state: WorkspaceTabsState = { workspaceId, tabs: [], activeId: '' }
    getStore().update((s) => {
      const ws = s.workspaces.find((w) => w.id === workspaceId)
      if (!ws) return
      mutate(ws)

      // A legacy/crashed renderer must not smuggle session-only visualization handles into persistence.
      let tabs = (ws.tabs ?? []).filter((tab) => tab.kind !== 'visualization')
      const workIdx = tabs.findIndex((t) => t.id === WORK_TAB_ID)
      if (workIdx < 0) {
        tabs = [{ id: WORK_TAB_ID, kind: 'work' }, ...tabs]
      } else if (workIdx > 0) {
        const work = tabs[workIdx]
        tabs = [work, ...tabs.filter((t) => t.id !== WORK_TAB_ID)]
      }
      ws.tabs = tabs
      if (!ws.tabs.some((t) => t.id === ws.activeTabId)) ws.activeTabId = WORK_TAB_ID

      state = {
        workspaceId,
        tabs: structuredClone(ws.tabs),
        activeId: ws.activeTabId as string
      }
    })
    state = this.withVisualizations(state)
    if (broadcast && state.tabs.length) this.dispatch(IPC.evtWorkspaceTabs, state)
    return state
  }

  /**
   * 워크스페이스가 사라질 때(아카이브·삭제) 이 매니저가 들고 있는 메모리 상태를 정리한다.
   *
   * 여기서 지우는 것은 **닫은 탭 스택뿐**이다 — 탭 목록(ws.tabs) 자체는 store(workspace 레코드)가
   * 소유한다. 아카이브는 그 레코드를 지우지 않으므로(worktree 만 없앤다) 탭 구성이 남아 있어야
   * 복원 후에도 같은 탭을 다시 볼 수 있고, 삭제는 워크스페이스 레코드 자체가 함께 사라지므로
   * 여기서 따로 지울 것이 없다. 닫은 탭 스택만 워크스페이스 id 를 키로 메모리에 남으므로,
   * 정리하지 않으면 아카이브·삭제를 반복할 때마다 조용히 새는 맵이 된다.
   */
  disposeWorkspace(workspaceId: string): void {
    this.closedStacks.delete(workspaceId)
    this.visualizationTabs.delete(workspaceId)
    this.activeVisualization.delete(workspaceId)
  }

  private persistedState(workspaceId: string): WorkspaceTabsState {
    const ws = getStore().getState().workspaces.find((w) => w.id === workspaceId)
    if (!ws) return { workspaceId, tabs: [], activeId: '' }
    return { workspaceId, tabs: structuredClone(ws.tabs ?? []), activeId: ws.activeTabId ?? WORK_TAB_ID }
  }

  private withVisualizations(state: WorkspaceTabsState): WorkspaceTabsState {
    const visualizations = this.visualizationTabs.get(state.workspaceId) ?? []
    const active = this.activeVisualization.get(state.workspaceId)
    return {
      ...state,
      tabs: [...state.tabs, ...visualizations],
      activeId: active && visualizations.some((tab) => tab.id === active) ? active : state.activeId
    }
  }
}
