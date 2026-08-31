import { BrowserWindow, screen } from 'electron'
import { IPC, PANE_KINDS } from '@shared/types'
import type { PaneKind, PaneState, WindowBounds } from '@shared/types'
import { getStore } from './store'
import { log } from './logger'
import {
  applyNavigationGuards,
  loadRenderer,
  rendererWebPreferences,
  windowBackgroundColor
} from './windows'

type Dispatch = (channel: string, payload: unknown) => void

/** 패널 종류별 기본 창 크기 — 파일/터미널은 세로가, 스크립트 로그는 가로가 아쉬운 패널이다. */
const DEFAULT_SIZE: Record<PaneKind, { width: number; height: number }> = {
  work: { width: 760, height: 920 },
  scripts: { width: 900, height: 520 },
  // 현황판은 카드가 격자로 깔리므로 가로가 넉넉해야 한 줄에 여러 장이 들어간다.
  overview: { width: 1040, height: 760 }
}

const MIN_SIZE: Record<PaneKind, { width: number; height: number }> = {
  work: { width: 420, height: 360 },
  scripts: { width: 420, height: 240 },
  overview: { width: 520, height: 400 }
}

const TITLE: Record<PaneKind, string> = {
  work: 'Work panel — Wooi',
  scripts: 'Project scripts — Wooi',
  overview: 'Overview — Wooi'
}

/**
 * 저장해 둔 자리가 지금 연결된 디스플레이 안에 있는지. 보조 모니터에 두고 닫은 뒤 그 모니터를
 * 뽑으면 좌표가 화면 밖을 가리켜 창이 보이지 않는 곳에 뜬다 — 그때는 기본 위치로 폴백한다.
 */
function onScreen(bounds: WindowBounds): boolean {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea
    return (
      bounds.x < a.x + a.width &&
      bounds.x + bounds.width > a.x &&
      bounds.y < a.y + a.height &&
      bounds.y + bounds.height > a.y
    )
  })
}

/**
 * 메인 창에서 떼어 낸 패널 창(work / scripts)의 수명 관리.
 *
 * 패널은 **복제가 아니라 이동**이다 — 터미널 PTY 나 스크립트 프로세스는 워크스페이스당 하나뿐이라
 * 두 창에 동시에 그리면 입력이 갈라진다. 그래서 분리하면 메인 창은 인라인 패널을 접고, 창을 닫으면
 * 그대로 되돌아온다(렌더러가 evtPaneState 를 보고 판단한다).
 *
 * 예외는 `overview` 다 — 현황판은 읽기 전용 보드라 갈라질 상태가 없다. 여기서는 **복제**가 맞고
 * (보조 모니터에 현황판을 띄워 둔 채 메인 창에서 계속 일한다), 메인 창은 아무것도 접지 않는다.
 *
 * 창이 보여 줄 워크스페이스는 메인 창의 선택을 그대로 따라간다 — 사용자가 사이드바에서 세션을
 * 바꾸면 보조 모니터의 패널도 같이 따라가야 "옆 화면에 띄워 둔 작업 패널" 로 쓸 수 있다.
 */
export class PaneWindows {
  private wins = new Map<PaneKind, BrowserWindow>()
  /** 분리한 창들이 따라갈 워크스페이스(메인 창의 선택). */
  private workspaceId: string | null = null

  constructor(private dispatch: Dispatch) {}

  state(): PaneState {
    return {
      work: this.isOpen('work'),
      scripts: this.isOpen('scripts'),
      overview: this.isOpen('overview')
    }
  }

  private isOpen(kind: PaneKind): boolean {
    const win = this.wins.get(kind)
    return !!win && !win.isDestroyed()
  }

  /** 메인 창의 선택이 바뀌었다 — 떠 있는 패널 창들을 같은 워크스페이스로 옮긴다. */
  setWorkspace(workspaceId: string | null): void {
    this.workspaceId = workspaceId
    this.dispatch(IPC.evtPaneWorkspace, workspaceId)
  }

  open(kind: PaneKind, workspaceId: string | null): void {
    if (workspaceId !== null) this.workspaceId = workspaceId
    const existing = this.wins.get(kind)
    if (existing && !existing.isDestroyed()) {
      // 이미 떠 있으면 새로 만들지 않고 앞으로 가져온다. 다른 모니터에 있으면 그 자리 그대로.
      this.setWorkspace(this.workspaceId)
      existing.show()
      existing.focus()
      return
    }

    const saved = getStore().getState().settings.paneWindowBounds?.[kind]
    const size = saved && onScreen(saved) ? saved : DEFAULT_SIZE[kind]

    const win = new BrowserWindow({
      ...size,
      ...(saved && onScreen(saved) ? { x: saved.x, y: saved.y } : {}),
      minWidth: MIN_SIZE[kind].width,
      minHeight: MIN_SIZE[kind].height,
      show: false,
      title: TITLE[kind],
      backgroundColor: windowBackgroundColor(),
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 12, y: 12 },
      webPreferences: rendererWebPreferences()
    })

    win.on('ready-to-show', () => win.show())
    applyNavigationGuards(win)

    win.webContents.on('did-fail-load', (_e, code, desc) => {
      log.error(`pane(${kind}) renderer load failed: ${code} ${desc}`)
    })

    // 창을 닫는 순간의 자리를 기억해 둔다 — 다음에 열 때 같은 모니터·같은 크기로 뜬다.
    win.on('close', () => this.rememberBounds(kind, win))
    win.on('closed', () => {
      if (this.wins.get(kind) === win) this.wins.delete(kind)
      // 닫힘을 방송해야 메인 창이 인라인 패널을 되돌린다(창을 잃어버리지 않게 하는 핵심).
      this.dispatch(IPC.evtPaneState, this.state())
    })

    this.wins.set(kind, win)
    loadRenderer(win, { pane: kind, ...(this.workspaceId ? { ws: this.workspaceId } : {}) })
    this.dispatch(IPC.evtPaneState, this.state())
  }

  close(kind: PaneKind): void {
    const win = this.wins.get(kind)
    if (win && !win.isDestroyed()) win.close()
  }

  focus(kind: PaneKind): void {
    const win = this.wins.get(kind)
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  /** 메인 창이 닫히면 위성인 패널 창도 함께 정리한다(주인 없는 창이 떠 있지 않게). */
  closeAll(): void {
    for (const kind of PANE_KINDS) this.close(kind)
  }

  private rememberBounds(kind: PaneKind, win: BrowserWindow): void {
    if (win.isDestroyed()) return
    const { x, y, width, height } = win.getBounds()
    try {
      getStore().update((s) => {
        s.settings.paneWindowBounds = {
          ...s.settings.paneWindowBounds,
          [kind]: { x, y, width, height }
        }
      })
    } catch (err) {
      // 자리 기억은 편의 기능일 뿐 — 실패해도 창을 닫는 흐름을 막지 않는다.
      log.error(`pane(${kind}) bounds 저장 실패`, err)
    }
  }
}
