import type { WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_TOOL_IMAGE_KEY } from '@shared/agentToolContent'
import type { PreviewIssue } from '@shared/previewIssues'
import type { Repo, Workspace } from '@shared/types'
import type { AgentToolDeps } from './registry'

/**
 * 이 테스트가 지키려는 것.
 *
 * open_preview 는 "왜 열 수 없는지" 를 세 갈래(스크립트 없음 / 안 돌고 있음 / 주소를 모름)로
 * 나눠 말해야 모델이 다음 행동을 고를 수 있다 — 그래서 사유 문장을 두껍게 본다. capture_preview 와
 * read_preview_issues 는 각각 이미지 인코딩 계약(agentToolContent 의 `_image` 키)과 상한(개수·
 * 바이트)이 실제로 지켜지는지를 본다.
 */

const state = vi.hoisted(() => ({
  workspaces: [] as Partial<Workspace>[],
  repos: [] as Partial<Repo>[]
}))

const captureForAgent = vi.fn()
const previewGuestFor = vi.fn()
const previewIssuesList = vi.fn()
const requestPreviewOpen = vi.fn()

vi.mock('../../store', () => ({ getStore: () => ({ getState: () => state }) }))
vi.mock('../../preview', () => ({
  captureForAgent: (...args: unknown[]) => captureForAgent(...args),
  previewGuestFor: (...args: unknown[]) => previewGuestFor(...args),
  previewIssues: () => ({ list: previewIssuesList }),
  requestPreviewOpen: (...args: unknown[]) => requestPreviewOpen(...args)
}))

const getOutput = vi.fn()
const deps = {
  scripts: { getOutput, getStatus: vi.fn() }
} as unknown as AgentToolDeps

const repo: Partial<Repo> = {
  id: 'repo-1',
  runScripts: [{ id: 'dev-1', name: 'Dev', command: 'npm run dev', autoStart: false }]
}

const ws: Partial<Workspace> = {
  id: 'ws-1',
  repoId: 'repo-1',
  worktreePath: '/tmp/wt',
  ports: {},
  archived: false,
  previewUrl: null
}

function makeGuest(): WebContents {
  return {
    loadURL: vi.fn(),
    getURL: vi.fn(),
    isLoading: vi.fn(() => false)
  } as unknown as WebContents
}

/** 지정한 스크립트만 running 으로 만든다. */
function running(scriptId: string): void {
  ;(deps.scripts.getStatus as ReturnType<typeof vi.fn>).mockReturnValue([
    { scriptId, state: 'running', exitCode: null }
  ])
}

function notRunning(): void {
  ;(deps.scripts.getStatus as ReturnType<typeof vi.fn>).mockReturnValue([
    { scriptId: 'dev-1', state: 'idle', exitCode: null }
  ])
}

beforeEach(() => {
  vi.clearAllMocks()
  state.workspaces = [{ ...ws, ports: {} }]
  state.repos = [{ ...repo }]
  getOutput.mockReturnValue('')
  notRunning()
  previewIssuesList.mockReturnValue([])
  previewGuestFor.mockReturnValue(null)
})

async function call(
  name: 'openPreview' | 'capturePreview' | 'readPreviewIssues',
  args: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const mod = await import('./preview')
  return mod[name](deps, 'ws-1', args) as Promise<Record<string, unknown>>
}

describe('open_preview', () => {
  it('run 스크립트가 설정돼 있지 않으면 거절한다', async () => {
    state.repos = [{ ...repo, runScripts: [] }]

    await expect(call('openPreview')).rejects.toThrow(/no run script configured/)
  })

  it('설정은 됐지만 아무것도 안 돌고 있으면 run_script 로 안내한다', async () => {
    await expect(call('openPreview')).rejects.toThrow(/run_script/)
    await expect(call('openPreview')).rejects.toThrow(/"Dev"/)
  })

  it('돌고는 있는데 주소도 포트도 없으면 read_script_output 으로 안내한다', async () => {
    running('dev-1')
    getOutput.mockReturnValue('installing dependencies...\n')

    await expect(call('openPreview')).rejects.toThrow(/read_script_output/)
  })

  it('돌고 있고 로그에 주소가 있으면 그 주소를 연다', async () => {
    running('dev-1')
    getOutput.mockReturnValue('  ➜  Local:   http://localhost:5173/\n')
    const guest = makeGuest()
    previewGuestFor.mockReturnValue(guest)

    const result = await call('openPreview')

    expect(requestPreviewOpen).toHaveBeenCalledWith('ws-1', '')
    expect(guest.loadURL).toHaveBeenCalledWith('http://localhost:5173/')
    expect(result.url).toBe('http://localhost:5173/')
  })

  it('path 를 주면 그 경로로 연다', async () => {
    running('dev-1')
    getOutput.mockReturnValue('  ➜  Local:   http://localhost:5173/\n')
    const guest = makeGuest()
    previewGuestFor.mockReturnValue(guest)

    await call('openPreview', { path: '/settings' })

    expect(guest.loadURL).toHaveBeenCalledWith('http://localhost:5173/settings')
  })

  it('로그에 주소가 없어도 Wooi 가 배정한 포트가 있으면 그 포트를 연다', async () => {
    running('dev-1')
    state.workspaces = [{ ...ws, ports: { 'dev-1': 3100 } }]
    getOutput.mockReturnValue('starting...\n')
    const guest = makeGuest()
    previewGuestFor.mockReturnValue(guest)

    await call('openPreview')

    expect(guest.loadURL).toHaveBeenCalledWith('http://localhost:3100/')
  })

  it('아무 스크립트도 안 돌지만 previewUrl 이 있으면 그 origin 을 쓴다', async () => {
    state.workspaces = [{ ...ws, previewUrl: 'http://localhost:4000/x' }]
    const guest = makeGuest()
    previewGuestFor.mockReturnValue(guest)

    const result = await call('openPreview')

    expect(guest.loadURL).toHaveBeenCalledWith('http://localhost:4000/')
    expect(result.url).toBe('http://localhost:4000/')
  })

  it('다른 origin 을 가리키는 path 는 거절한다', async () => {
    running('dev-1')
    getOutput.mockReturnValue('  ➜  Local:   http://localhost:5173/\n')
    const guest = makeGuest()
    previewGuestFor.mockReturnValue(guest)

    await expect(call('openPreview', { path: 'http://evil.example.com/' })).rejects.toThrow(
      /dev server/
    )
    expect(guest.loadURL).not.toHaveBeenCalled()
  })

  describe('Preview 패널이 안 뜨면', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('10 초를 기다리다 포기하고 던진다', async () => {
      running('dev-1')
      getOutput.mockReturnValue('  ➜  Local:   http://localhost:5173/\n')
      previewGuestFor.mockReturnValue(null)

      const pending = call('openPreview')
      const assertion = expect(pending).rejects.toThrow(/open on screen/)
      await vi.advanceTimersByTimeAsync(10_000)
      await assertion
    })
  })

  it('loadURL 이 ERR_ABORTED 로 실패하면 한 번 더 시도한다', async () => {
    running('dev-1')
    getOutput.mockReturnValue('  ➜  Local:   http://localhost:5173/\n')
    const guest = makeGuest()
    ;(guest.loadURL as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('ERR_ABORTED (-3) loading http://localhost:5173/'))
      .mockResolvedValueOnce(undefined)
    previewGuestFor.mockReturnValue(guest)

    await expect(call('openPreview')).resolves.toMatchObject({ url: 'http://localhost:5173/' })
    expect(guest.loadURL).toHaveBeenCalledTimes(2)
  })

  it('loadURL 이 다른 이유로 실패하면 그 사유가 던진 문장에 남는다', async () => {
    running('dev-1')
    getOutput.mockReturnValue('  ➜  Local:   http://localhost:5173/\n')
    const guest = makeGuest()
    ;(guest.loadURL as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('ERR_CONNECTION_REFUSED')
    )
    previewGuestFor.mockReturnValue(guest)

    await expect(call('openPreview')).rejects.toThrow(/ERR_CONNECTION_REFUSED/)
  })
})

describe('capture_preview', () => {
  it('guest 가 없으면 open_preview 를 먼저 부르라고 한다', async () => {
    previewGuestFor.mockReturnValue(null)

    await expect(call('capturePreview')).rejects.toThrow(/open_preview/)
  })

  it('아직 페이지를 로드하지 않았으면(about:blank) 던진다', async () => {
    const guest = makeGuest()
    ;(guest.getURL as ReturnType<typeof vi.fn>).mockReturnValue('about:blank')
    previewGuestFor.mockReturnValue(guest)

    await expect(call('capturePreview')).rejects.toThrow(/open_preview/)
  })

  it('정상 경로 — url·width·height 와 _image 블록을 돌려주고 scaledDown 은 없다', async () => {
    const guest = makeGuest()
    ;(guest.getURL as ReturnType<typeof vi.fn>).mockReturnValue('http://localhost:5173/')
    previewGuestFor.mockReturnValue(guest)
    captureForAgent.mockResolvedValue({
      capture: { dataBase64: 'AAAA', width: 800, height: 600 }
    })

    const result = await call('capturePreview')

    expect(result.url).toBe('http://localhost:5173/')
    expect(result.width).toBe(800)
    expect(result.height).toBe(600)
    expect(result[AGENT_TOOL_IMAGE_KEY]).toEqual({ dataBase64: 'AAAA', mediaType: 'image/png' })
    expect(result).not.toHaveProperty('scaledDown')
  })

  it('스케일이 줄었으면 scaledDown 과 원래 크기를 note 에 남긴다', async () => {
    const guest = makeGuest()
    ;(guest.getURL as ReturnType<typeof vi.fn>).mockReturnValue('http://localhost:5173/')
    previewGuestFor.mockReturnValue(guest)
    captureForAgent.mockResolvedValue({
      capture: {
        dataBase64: 'AAAA',
        width: 1200,
        height: 900,
        scaledFrom: { width: 2400, height: 1800 }
      }
    })

    const result = await call('capturePreview')

    expect(result.scaledDown).toBe(true)
    expect(String(result.note)).toContain('2400×1800')
  })

  it('captureForAgent 가 에러를 주면 그 문장으로 던진다', async () => {
    const guest = makeGuest()
    ;(guest.getURL as ReturnType<typeof vi.fn>).mockReturnValue('http://localhost:5173/')
    previewGuestFor.mockReturnValue(guest)
    captureForAgent.mockResolvedValue({ error: 'window is being destroyed' })

    await expect(call('capturePreview')).rejects.toThrow(/window is being destroyed/)
  })
})

describe('read_preview_issues', () => {
  const issue = (over: Partial<PreviewIssue> = {}): PreviewIssue => ({
    id: 'x',
    kind: 'console',
    level: 'error',
    text: 'boom',
    ts: 1,
    count: 1,
    ...over
  })

  it('수집된 것도 guest 도 없으면 빈 상태와 open_preview 안내를 돌려준다', async () => {
    previewIssuesList.mockReturnValue([])
    previewGuestFor.mockReturnValue(null)

    const result = await call('readPreviewIssues')

    expect(result.previewOpen).toBe(false)
    expect(result.total).toBe(0)
    expect(result.issues).toEqual([])
    expect(String(result.result)).toContain('open_preview')
  })

  it('에러가 경고보다 먼저 나온다', async () => {
    previewIssuesList.mockReturnValue([
      issue({ id: 'w', level: 'warning', text: 'warn', ts: 1 }),
      issue({ id: 'e', level: 'error', text: 'err', ts: 2 })
    ])

    const result = await call('readPreviewIssues')

    expect((result.issues as PreviewIssue[])[0].level).toBe('error')
  })

  it('errors/warnings 개수가 맞고 항목에 count 가 실린다', async () => {
    previewIssuesList.mockReturnValue([
      issue({ id: 'e1', level: 'error', count: 3 }),
      issue({ id: 'e2', level: 'error', count: 1 }),
      issue({ id: 'w1', level: 'warning', count: 2 })
    ])

    const result = await call('readPreviewIssues')

    expect(result.errors).toBe(2)
    expect(result.warnings).toBe(1)
    expect((result.issues as PreviewIssue[]).find((i) => i.text === 'boom')?.count).toBeDefined()
  })

  it('개수 상한 — 60 건을 주면 50 개만, total 은 60, truncated 는 true', async () => {
    previewIssuesList.mockReturnValue(
      Array.from({ length: 60 }, (_, i) => issue({ id: `e${i}`, ts: i }))
    )

    const result = await call('readPreviewIssues')

    expect((result.issues as PreviewIssue[]).length).toBe(50)
    expect(result.total).toBe(60)
    expect(result.truncated).toBe(true)
  })

  it('바이트 상한 — 첫 건은 넘어도 담고, 그다음부터는 상한을 지켜 자른다', async () => {
    const big = 'x'.repeat(20 * 1024)
    previewIssuesList.mockReturnValue(
      Array.from({ length: 5 }, (_, i) => issue({ id: `e${i}`, text: big, ts: i }))
    )

    const result = await call('readPreviewIssues')

    expect((result.issues as PreviewIssue[]).length).toBe(1)
    expect(result.truncated).toBe(true)
  })
})
