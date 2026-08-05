import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { connect } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Workspace } from '@shared/types'

/**
 * Codex 경로에서 workspaceId 는 **모델이 말한 값**이다(전송 계층이 맥락을 실어 주지 못한다).
 * 그래서 이 검증이 그 경로의 안전 장치 전부다 — 여기가 느슨하면 모델이 남의 워크스페이스에
 * 브랜치를 만들 수 있다.
 */

const state = vi.hoisted(() => ({ workspaces: [] as Partial<Workspace>[] }))
const run = vi.hoisted(() => vi.fn())
const approve = vi.hoisted(() => vi.fn())

vi.mock('../../store', () => ({ getStore: () => ({ getState: () => state }) }))
vi.mock('./registry', () => ({ runAgentTool: run }))
// 승인 규칙 자체는 permission.test 가 다룬다. 여기서는 소켓이 **실행 전에 반드시 거친다**는
// 것만 본다 — 그 순서가 어긋나면 카드가 뜨기도 전에 브랜치가 생긴다.
vi.mock('./permission', () => ({ ensureToolApproved: approve }))

let dir: string

beforeEach(async () => {
  vi.clearAllMocks()
  run.mockResolvedValue({ ok: true })
  approve.mockResolvedValue(undefined)
  dir = mkdtempSync(join(tmpdir(), 'wooi-sock-'))
  const { startToolSocket } = await import('./socket')
  startToolSocket(dir)
  // listen 은 비동기다 — 첫 연결 전에 바인드가 끝나야 한다.
  await new Promise((r) => setTimeout(r, 50))
})

afterEach(async () => {
  const { stopToolSocket } = await import('./socket')
  stopToolSocket(dir)
  rmSync(dir, { recursive: true, force: true })
})

/** shim 이 하듯 한 줄 보내고 한 줄 받는다. */
async function call(payload: unknown): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const { toolSocketPath } = await import('./socket')
  return new Promise((resolve, reject) => {
    const socket = connect(toolSocketPath(dir))
    let buf = ''
    socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'))
    socket.on('data', (c) => (buf += c.toString()))
    socket.on('error', reject)
    socket.on('close', () => resolve(JSON.parse(buf.split('\n')[0])))
  })
}

const running: Partial<Workspace> = { id: 'ws-1', archived: false, status: 'running' }

describe('도구 소켓', () => {
  it('턴이 도는 워크스페이스의 호출은 실행부로 넘긴다', async () => {
    state.workspaces = [running]

    const res = await call({ workspaceId: 'ws-1', tool: 'check_stacked_work', args: {} })

    expect(res).toEqual({ ok: true, data: { ok: true } })
    expect(run).toHaveBeenCalledWith('ws-1', 'check_stacked_work', {})
  })

  it('없는 워크스페이스를 주장하면 거절한다', async () => {
    state.workspaces = [running]

    const res = await call({ workspaceId: 'ws-nope', tool: 'check_stacked_work', args: {} })

    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/Unknown Wooi workspace/)
    expect(run).not.toHaveBeenCalled()
  })

  it('턴이 돌지 않는 워크스페이스를 주장하면 거절한다', async () => {
    // 이것이 핵심 방어선이다 — 도구는 에이전트가 도는 중에만 불릴 수 있으므로 정상 호출은 항상
    // 통과하고, 엉뚱한 id 는 그 워크스페이스가 마침 동시에 돌고 있지 않는 한 여기서 걸린다.
    state.workspaces = [running, { id: 'ws-2', archived: false, status: 'idle' }]

    const res = await call({ workspaceId: 'ws-2', tool: 'create_stacked_workspace', args: {} })

    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not running a turn/)
    expect(run).not.toHaveBeenCalled()
  })

  it('아카이브된 워크스페이스는 거절한다', async () => {
    state.workspaces = [{ id: 'ws-3', archived: true, status: 'running' }]

    const res = await call({ workspaceId: 'ws-3', tool: 'check_stacked_work', args: {} })

    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/archived/)
  })

  it('실행부가 던진 오류를 그대로 돌려준다', async () => {
    state.workspaces = [running]
    run.mockRejectedValue(new Error('commit first'))

    await expect(call({ workspaceId: 'ws-1', tool: 'x', args: {} })).resolves.toEqual({
      ok: false,
      error: 'commit first'
    })
  })

  it('깨진 줄에도 응답한다 — 답이 없으면 shim 이 매달린다', async () => {
    const res = await call('not json')
    expect(res.ok).toBe(false)
  })

  it('실행 전에 승인 문지기를 거친다', async () => {
    state.workspaces = [running]

    await call({ workspaceId: 'ws-1', tool: 'create_stacked_workspace', args: { name: 'x' } })

    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ws-1' }),
      'create_stacked_workspace',
      { name: 'x' }
    )
  })

  it('승인이 거부되면 도구를 실행하지 않는다', async () => {
    state.workspaces = [running]
    approve.mockRejectedValue(new Error('The user declined this action.'))

    const res = await call({ workspaceId: 'ws-1', tool: 'create_stacked_workspace', args: {} })

    expect(res).toEqual({ ok: false, error: 'The user declined this action.' })
    expect(run).not.toHaveBeenCalled()
  })
})
