import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AgentToolDeps } from './registry'
import type { Repo, Workspace } from '@shared/types'

/**
 * 스크립트 도구에서 지켜야 할 것.
 *
 * 가장 중요한 것은 **출력 상한**이다. dev 로그는 길이 제한이 없고 실패한 빌드는 수천 줄이 나온다 —
 * 상한이 새면 읽기 한 번이 컨텍스트를 통째로 먹는다. 그래서 모델이 준 tailLines 를 믿지 않고,
 * 잘렸다는 사실은 반드시 결과에 남긴다.
 */

const waitForPortFree = vi.hoisted(() => vi.fn())
const state = vi.hoisted(() => ({
  workspaces: [] as Partial<Workspace>[],
  repos: [] as Partial<Repo>[]
}))

vi.mock('../../net', () => ({ waitForPortFree }))
vi.mock('../../store', () => ({ getStore: () => ({ getState: () => state, update: vi.fn() }) }))
vi.mock('../../workspaces', () => ({
  scriptEnvFor: () => ({ PORT: '3100' })
}))

const run = vi.fn()
const stop = vi.fn()
const getOutput = vi.fn()
const getStatus = vi.fn()
const deps = {
  scripts: { run, stop, getOutput, getStatus }
} as unknown as AgentToolDeps

const repo: Partial<Repo> = {
  id: 'repo-1',
  setupScript: 'npm install',
  runScripts: [{ id: 'dev-1', name: 'Dev', command: 'npm run dev', autoStart: false }]
}

const ws: Partial<Workspace> = {
  id: 'ws-1',
  repoId: 'repo-1',
  worktreePath: '/tmp/wt',
  ports: { 'dev-1': 3100 },
  archived: false
}

/** 지정한 종류만 running 으로 만든다. */
function statusIs(
  scriptId: 'setup' | 'dev-1',
  running: boolean,
  exitCode: number | null = null
): void {
  getStatus.mockReturnValue([
    { scriptId, state: running ? 'running' : 'exited', exitCode },
    { scriptId: scriptId === 'dev-1' ? 'setup' : 'dev-1', state: 'idle', exitCode: null }
  ])
}

beforeEach(() => {
  vi.clearAllMocks()
  state.workspaces = [{ ...ws }]
  state.repos = [{ ...repo }]
  getStatus.mockReturnValue([
    { scriptId: 'setup', state: 'idle', exitCode: null },
    { scriptId: 'dev-1', state: 'idle', exitCode: null }
  ])
  getOutput.mockReturnValue('')
  waitForPortFree.mockResolvedValue(true)
})

async function call(
  name: 'runScript' | 'stopScript' | 'readScriptOutput',
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const mod = await import('./script')
  return mod[name](deps, 'ws-1', args) as Promise<Record<string, unknown>>
}

describe('run_script', () => {
  it('리포에 설정된 명령을 워크트리에서 돌린다', async () => {
    await expect(call('runScript', { name: 'dev' })).resolves.toMatchObject({
      name: 'Dev',
      command: 'npm run dev',
      restarted: false
    })

    expect(run).toHaveBeenCalledWith('ws-1', 'dev-1', 'npm run dev', '/tmp/wt', { PORT: '3100' })
  })

  it('설정되지 않은 스크립트는 거절한다 — 명령을 지어내면 안 된다', async () => {
    state.repos = [
      { ...repo, runScripts: [{ id: 'dev-1', name: 'Dev', command: '   ', autoStart: false }] }
    ]

    await expect(call('runScript', { name: 'Dev' })).rejects.toThrow(/no Dev script configured/)
    expect(run).not.toHaveBeenCalled()
  })

  it('이미 돌고 있으면 재시작임을 결과 문장으로 알린다', async () => {
    statusIs('dev-1', true)

    const result = await call('runScript', { name: 'DEV' })

    expect(result.restarted).toBe(true)
    expect(result.result).toMatch(/started it again/)
    expect(run).toHaveBeenCalled()
  })

  it('dev 재시작은 포트가 풀릴 때까지 기다린다', async () => {
    statusIs('dev-1', true)

    await call('runScript', { name: 'Dev' })

    expect(stop).toHaveBeenCalledWith('ws-1', 'dev-1')
    expect(waitForPortFree).toHaveBeenCalledWith(3100, 1500)
  })

  it('모르는 kind 는 거절한다', async () => {
    await expect(call('runScript', { name: 'build' })).rejects.toThrow(/"setup", "Dev"/)
    expect(run).not.toHaveBeenCalled()
  })

  it('예약 이름 setup 은 계속 실행한다', async () => {
    await expect(call('runScript', { name: 'setup' })).resolves.toMatchObject({
      name: 'setup',
      command: 'npm install'
    })
    expect(run).toHaveBeenCalledWith('ws-1', 'setup', 'npm install', '/tmp/wt', { PORT: '3100' })
  })
})

describe('stop_script', () => {
  it('돌고 있으면 멈춘다', async () => {
    statusIs('dev-1', true)

    await expect(call('stopScript', { name: 'dev' })).resolves.toMatchObject({ stopped: true })
    expect(stop).toHaveBeenCalledWith('ws-1', 'dev-1')
  })

  it('안 돌고 있었으면 그렇다고 말해 준다', async () => {
    await expect(call('stopScript', { name: 'dev' })).resolves.toMatchObject({
      stopped: false,
      result: expect.stringMatching(/not running/)
    })
  })
})

describe('read_script_output', () => {
  it('기본은 마지막 200 줄이다', async () => {
    getOutput.mockReturnValue(Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n'))

    const result = await call('readScriptOutput', { kind: 'dev' })

    expect(result.lines).toBe(200)
    expect(result.totalLines).toBe(300)
    expect(result.truncated).toBe(true)
    // 끝을 남긴다 — 에러는 뒤에 있다.
    expect(String(result.output).endsWith('line 299')).toBe(true)
    expect(String(result.output).startsWith('line 100')).toBe(true)
  })

  it('모델이 더 큰 값을 줘도 500 줄로 하드 클램프한다', async () => {
    getOutput.mockReturnValue(Array.from({ length: 5000 }, (_, i) => `l${i}`).join('\n'))

    const result = await call('readScriptOutput', { kind: 'dev', tailLines: 99999 })

    expect(result.lines).toBe(500)
    expect(result.truncated).toBe(true)
  })

  it('줄이 짧아도 바이트 상한이 먼저 걸린다', async () => {
    // 500 줄 × 200 바이트 = 100KB. 줄 수 상한만으로는 못 막는다.
    getOutput.mockReturnValue(Array.from({ length: 500 }, () => 'x'.repeat(200)).join('\n'))

    const result = await call('readScriptOutput', { kind: 'dev', tailLines: 500 })

    expect(Buffer.byteLength(String(result.output), 'utf8')).toBeLessThanOrEqual(8 * 1024)
    expect(result.truncated).toBe(true)
  })

  it('긴 줄 하나뿐이어도 상한 안으로 잘라 돌려준다', async () => {
    getOutput.mockReturnValue('y'.repeat(200_000))

    const result = await call('readScriptOutput', { kind: 'dev' })

    expect(Buffer.byteLength(String(result.output), 'utf8')).toBeLessThanOrEqual(8 * 1024)
    expect(result.truncated).toBe(true)
  })

  it('상한 안이면 자르지 않고 truncated 도 세우지 않는다', async () => {
    getOutput.mockReturnValue('build ok\nready in 300ms')

    const result = await call('readScriptOutput', { kind: 'dev' })

    expect(result.output).toBe('build ok\nready in 300ms')
    expect(result.totalLines).toBe(2)
    expect(result).not.toHaveProperty('truncated')
  })

  it('상태를 함께 준다 — "로그가 비었다" 와 "아직 시작 안 했다" 는 다르다', async () => {
    statusIs('dev-1', false, 1)

    await expect(call('readScriptOutput', { kind: 'dev' })).resolves.toMatchObject({
      running: false,
      exitCode: 1,
      output: '',
      totalLines: 0
    })
  })

  it('읽기는 승인을 묻지 않는 도구다(카탈로그 계약)', async () => {
    const { isReadOnlyToolName } = await import('./catalog')

    expect(isReadOnlyToolName('read_script_output')).toBe(true)
    expect(isReadOnlyToolName('run_script')).toBe(false)
    expect(isReadOnlyToolName('stop_script')).toBe(false)
  })
})
