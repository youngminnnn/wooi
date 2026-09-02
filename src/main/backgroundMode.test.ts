import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState, Workspace } from '@shared/types'

/**
 * 종료 가드의 판정만 검증한다. Tray·Dock·다이얼로그는 실제로 띄울 수 없으므로 전부 목킹하고,
 * 여기서 확인하는 것은 [[main/backgroundMode]] 가 답해야 하는 질문 하나다 —
 * **언제 종료를 막고 언제 그냥 보내 주는가.** (모킹 방식은 sleepBlocker.test 와 같다.)
 */

const electron = vi.hoisted(() => ({
  quits: 0,
  dockHidden: false,
  trays: 0,
  trayTitle: '',
  dialogResponse: 0,
  dialogChecked: false,
  dialogCalls: 0,
  notifications: [] as string[],
  closedWindows: 0
}))

vi.mock('electron', () => {
  class Tray {
    constructor() {
      electron.trays++
    }
    setTitle(title: string): void {
      electron.trayTitle = title
    }
    setToolTip(): void {}
    setContextMenu(): void {}
    destroy(): void {
      electron.trays--
    }
  }
  class Notification {
    constructor(private options: { body: string }) {}
    static isSupported = (): boolean => true
    show(): void {
      electron.notifications.push(this.options.body)
    }
  }
  return {
    app: {
      quit: () => void electron.quits++,
      getAppPath: () => '/app',
      dock: {
        hide: () => void (electron.dockHidden = true),
        show: () => void (electron.dockHidden = false)
      }
    },
    BrowserWindow: {
      getAllWindows: () => [
        { isDestroyed: () => false, close: () => void electron.closedWindows++ }
      ]
    },
    Menu: { buildFromTemplate: (template: unknown[]) => template },
    Notification,
    Tray,
    dialog: {
      showMessageBox: async () => {
        electron.dialogCalls++
        return { response: electron.dialogResponse, checkboxChecked: electron.dialogChecked }
      }
    },
    nativeImage: {
      createFromPath: () => ({ isEmpty: () => false }),
      createEmpty: () => ({ isEmpty: () => true })
    }
  }
})

const state = vi.hoisted(() => ({ value: null as unknown as AppState }))

vi.mock('./store', () => ({
  getStore: () => ({
    getState: () => state.value,
    update: (mutate: (draft: AppState) => void) => mutate(state.value)
  })
}))

vi.mock('./logger', () => ({
  log: { info: () => {}, warn: () => {}, error: () => {} }
}))

const updater = vi.hoisted(() => ({ installing: false }))
vi.mock('./updater', () => ({ isInstallingUpdate: () => updater.installing }))

const NOW = Date.parse('2026-09-01T00:00:00Z')
const HOUR = 60 * 60 * 1000

function workspace(patch: Partial<Workspace>): Workspace {
  return {
    id: 'ws-1',
    repoId: 'repo-1',
    name: 'ws-1',
    status: 'running',
    archived: false,
    lastActiveAt: NOW,
    ...patch
  } as unknown as Workspace
}

function seed(workspaces: Workspace[], settings: Record<string, unknown> = {}): void {
  state.value = {
    workspaces,
    reviews: [],
    settings: { keepWorkingInBackground: true, confirmSkips: {}, ...settings }
  } as unknown as AppState
}

/** 모듈 상태(가드 표식·Tray)를 매 테스트마다 새로 만든다. */
async function load(): Promise<typeof import('./backgroundMode')> {
  vi.resetModules()
  const mod = await import('./backgroundMode')
  mod.initBackgroundMode({
    showWindow: () => {},
    getWindow: () => null,
    broadcastState: () => {}
  })
  return mod
}

const realPlatform = process.platform

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  // 백그라운드 모드는 darwin 한정이다([[main/backgroundMode]] 헤더). CI 는 리눅스에서 돌므로
  // 판정을 실제로 검증하려면 플랫폼을 고정해야 한다.
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  electron.quits = 0
  electron.dockHidden = false
  electron.trays = 0
  electron.trayTitle = ''
  electron.dialogResponse = 0
  electron.dialogChecked = false
  electron.dialogCalls = 0
  electron.notifications = []
  electron.closedWindows = 0
  updater.installing = false
  seed([workspace({})])
})

afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
})

describe('shouldStayAlive', () => {
  it('업데이트를 설치하는 중이면 막지 않는다', async () => {
    updater.installing = true
    const { shouldStayAlive } = await load()
    expect(shouldStayAlive()).toBe(false)
  })

  it('도는 일이 없으면 막지 않는다', async () => {
    seed([workspace({ status: 'idle' })])
    const { shouldStayAlive } = await load()
    expect(shouldStayAlive()).toBe(false)
  })

  it('설정이 꺼져 있으면 막지 않는다', async () => {
    seed([workspace({})], { keepWorkingInBackground: false })
    const { shouldStayAlive } = await load()
    expect(shouldStayAlive()).toBe(false)
  })

  it('도는 일이 있으면 막는다', async () => {
    const { shouldStayAlive } = await load()
    expect(shouldStayAlive()).toBe(true)
  })

  it('상한을 넘도록 조용한 running 은 세지 않는다', async () => {
    seed([workspace({ lastActiveAt: NOW - 3 * HOUR })])
    const { shouldStayAlive } = await load()
    expect(shouldStayAlive()).toBe(false)
  })

  it('mac 이 아니면 막지 않는다', async () => {
    const { shouldStayAlive } = await load()
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    expect(shouldStayAlive()).toBe(false)
  })

  it('아카이브된 워크스페이스는 세지 않는다', async () => {
    seed([workspace({ archived: true })])
    const { shouldStayAlive } = await load()
    expect(shouldStayAlive()).toBe(false)
  })
})

describe('enterBackground', () => {
  it('확인을 건너뛰기로 했으면 곧바로 메뉴 막대로 넘어간다', async () => {
    seed([workspace({})], { confirmSkips: { keepWorkingInBackground: true } })
    const { enterBackground, isStayingAlive } = await load()
    enterBackground()
    expect(electron.dialogCalls).toBe(0)
    expect(isStayingAlive()).toBe(true)
    expect(electron.trays).toBe(1)
    expect(electron.dockHidden).toBe(true)
    expect(electron.closedWindows).toBe(1)
    expect(electron.trayTitle).toBe('1')
  })

  it('"그래도 종료" 를 고르면 막은 종료를 다시 태운다', async () => {
    electron.dialogResponse = 1
    const { enterBackground, isStayingAlive, shouldStayAlive } = await load()
    enterBackground()
    await vi.runAllTimersAsync()
    expect(electron.quits).toBe(1)
    expect(isStayingAlive()).toBe(false)
    // 두 번째 종료는 같은 가드에 다시 걸리지 않아야 한다 — 걸리면 앱이 영영 안 꺼진다.
    expect(shouldStayAlive()).toBe(false)
  })

  it('"그래도 종료" + 다시 묻지 않기는 설정을 끈다', async () => {
    electron.dialogResponse = 1
    electron.dialogChecked = true
    const { enterBackground } = await load()
    enterBackground()
    await vi.runAllTimersAsync()
    expect(state.value.settings.keepWorkingInBackground).toBe(false)
  })

  it('"계속" + 다시 묻지 않기는 확인만 건너뛴다', async () => {
    electron.dialogChecked = true
    const { enterBackground } = await load()
    enterBackground()
    await vi.runAllTimersAsync()
    expect(state.value.settings.keepWorkingInBackground).toBe(true)
    expect(state.value.settings.confirmSkips?.keepWorkingInBackground).toBe(true)
  })
})

describe('noteWorkDrained', () => {
  it('백그라운드로 넘어간 뒤 일이 다 끝나면 앱을 종료한다', async () => {
    seed([workspace({})], { confirmSkips: { keepWorkingInBackground: true } })
    const { enterBackground, noteWorkDrained } = await load()
    enterBackground()

    // 아직 도는 중 — 끄지 않고 개수만 다시 그린다.
    noteWorkDrained()
    expect(electron.quits).toBe(0)

    seed([workspace({ status: 'idle' })], { confirmSkips: { keepWorkingInBackground: true } })
    noteWorkDrained()
    await vi.runAllTimersAsync()
    expect(electron.notifications).toHaveLength(1)
    expect(electron.quits).toBe(1)
    expect(electron.trays).toBe(0)
    expect(electron.dockHidden).toBe(false)
  })

  it('백그라운드가 아니면 아무것도 하지 않는다', async () => {
    const { noteWorkDrained } = await load()
    seed([workspace({ status: 'idle' })])
    noteWorkDrained()
    expect(electron.quits).toBe(0)
  })

  it('창을 되살린 뒤에는 일이 끝나도 사용자 앞에서 꺼지지 않는다', async () => {
    seed([workspace({})], { confirmSkips: { keepWorkingInBackground: true } })
    const { enterBackground, noteWorkDrained, revealWindow, isStayingAlive } = await load()
    enterBackground()
    revealWindow()
    expect(isStayingAlive()).toBe(false)
    expect(electron.trays).toBe(0)
    expect(electron.dockHidden).toBe(false)

    seed([workspace({ status: 'idle' })], { confirmSkips: { keepWorkingInBackground: true } })
    noteWorkDrained()
    await vi.runAllTimersAsync()
    expect(electron.quits).toBe(0)
  })
})

describe('tray asset', () => {
  /**
   * 경로 **해석**은 여기서 못 잡는다 — 앱을 어떻게 띄웠는지에 달려 있어서 실제로 띄워 보고서야
   * 드러났다(e2e 에서 `out/main/build/...` 로 빗나가 빈 이미지가 로드됐다). 유닛 테스트가 지킬
   * 수 있는 것은 자산 쪽이다: 파일이 사라지거나 패키징 목록에서 빠지면 Tray 는 아무 경고 없이
   * 빈 아이콘으로 뜬다.
   */
  it('메뉴 막대 아이콘이 레포에 있고 비어 있지 않다', () => {
    const icon = readFileSync(new URL('../../build/trayTemplate.png', import.meta.url))
    expect(icon.byteLength).toBeGreaterThan(100)
    expect(icon.subarray(1, 4).toString()).toBe('PNG')
  })

  it('패키징 목록이 두 배율을 모두 담는다', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    ) as { build: { files: string[] } }
    expect(pkg.build.files).toContain('build/trayTemplate.png')
    expect(pkg.build.files).toContain('build/trayTemplate@2x.png')
  })
})
