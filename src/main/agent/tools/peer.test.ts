import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MAX_PEER_INBOX } from '@shared/types'
import type { Repo, Workspace } from '@shared/types'
import type { AgentToolDeps } from './registry'

/**
 * peer 메시지에서 지켜야 할 것들.
 *
 * 핵심은 경계가 **수신 쪽에** 있다는 것이다. 발신은 리포까지 가로질러 열려 있으므로, 안전은
 * 전적으로 "대상이 받겠다고 했는가" 하나에 걸린다 — 그 판정이 무너지면 남의 워크스페이스에서
 * 승인 없는 턴 비용이 난다.
 */

const state = vi.hoisted(() => ({
  workspaces: [] as Partial<Workspace>[],
  repos: [] as Partial<Repo>[]
}))
const update = vi.hoisted(() => vi.fn((fn: (st: typeof state) => void) => fn(state)))

vi.mock('../../store', () => ({ getStore: () => ({ getState: () => state, update }) }))

const sendMessage = vi.fn()
const broadcastState = vi.fn()
const deps = { sendMessage, broadcastState } as unknown as AgentToolDeps

function ws(over: Partial<Workspace>): Partial<Workspace> {
  return {
    repoId: 'repo-1',
    branch: 'feat/x',
    name: 'x',
    archived: false,
    status: 'idle',
    parentWorkspaceId: null,
    createdByWorkspaceId: null,
    displayName: null,
    lastActiveAt: 0,
    ...over
  }
}

const me = ws({ id: 'ws-me', branch: 'feat/me', name: 'me' })

beforeEach(async () => {
  vi.clearAllMocks()
  state.repos = [
    { id: 'repo-1', name: 'wooi' },
    { id: 'repo-2', name: 'other-app' }
  ]
  state.workspaces = [{ ...me }]
  const { resetPeerRateLimitForTest } = await import('./peer')
  resetPeerRateLimitForTest()
})

async function send(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { sendToWorkspace } = await import('./peer')
  return sendToWorkspace(deps, 'ws-me', args) as Promise<Record<string, unknown>>
}

async function list(): Promise<Record<string, unknown>> {
  const { listWorkspacePeers } = await import('./peer')
  return listWorkspacePeers(deps, 'ws-me', {}) as Promise<Record<string, unknown>>
}

describe('list_workspace_peers', () => {
  it('리포를 가로질러 보되, 같은 리포를 먼저 놓는다', async () => {
    state.workspaces.push(
      ws({ id: 'ws-far', repoId: 'repo-2', branch: 'fix/far', lastActiveAt: 99 }),
      ws({ id: 'ws-near', repoId: 'repo-1', branch: 'fix/near', lastActiveAt: 1 })
    )

    const out = await list()
    const peers = out.peers as Array<Record<string, unknown>>

    // 다른 리포 쪽이 훨씬 최근인데도 같은 리포가 먼저다 — 상한에 걸려 잘리는 쪽은 항상
    // 덜 관련된 쪽이어야 한다.
    expect(peers.map((p) => p.workspaceId)).toEqual(['ws-near', 'ws-far'])
    expect(peers[0].crossRepo).toBeUndefined()
    expect(peers[1]).toMatchObject({ crossRepo: true, repo: 'other-app' })
  })

  it('보내기 전에 즉시 전달인지 승인 대기인지 알려 준다', async () => {
    state.workspaces.push(
      ws({ id: 'ws-open', peerInbound: 'accept' }),
      ws({ id: 'ws-shut' }) // 기본값 = hold
    )

    const peers = (await list()).peers as Array<Record<string, unknown>>
    expect(peers.find((p) => p.workspaceId === 'ws-open')?.delivery).toBe('immediate')
    expect(peers.find((p) => p.workspaceId === 'ws-shut')?.delivery).toBe('needs approval')
  })

  it('자기 자신과 아카이브된 워크스페이스는 빼놓는다', async () => {
    state.workspaces.push(ws({ id: 'ws-gone', archived: true }))
    const peers = (await list()).peers as Array<Record<string, unknown>>
    expect(peers).toHaveLength(0)
  })
})

describe('send_to_workspace', () => {
  it('기본값(hold)이면 전달하지 않고 대기열에 넣는다', async () => {
    state.workspaces.push(ws({ id: 'ws-them', branch: 'feat/them' }))

    const out = await send({ workspaceId: 'ws-them', message: 'the schema column is tenant_id' })

    // 이것이 이 기능의 안전 계약이다 — 승인 전에는 남의 워크스페이스에서 턴이 시작되지 않는다.
    expect(sendMessage).not.toHaveBeenCalled()
    expect(out.delivered).toBe(false)

    const inbox = state.workspaces.find((w) => w.id === 'ws-them')?.peerInbox ?? []
    expect(inbox).toHaveLength(1)
    expect(inbox[0]).toMatchObject({
      fromWorkspaceId: 'ws-me',
      fromBranch: 'feat/me',
      fromRepoName: 'wooi',
      crossRepo: false,
      message: 'the schema column is tenant_id'
    })
    // 카드가 보여 줄 원문과, 승인 시 실제로 갈 문장은 다르다 — 후자에는 출처 문단이 씌워져 있다.
    expect(inbox[0].text).toContain('the schema column is tenant_id')
    expect(inbox[0].text).toContain('not from the user')
    expect(broadcastState).toHaveBeenCalled()
  })

  it('accept 로 열어 둔 대상에게는 바로 전달한다', async () => {
    state.workspaces.push(ws({ id: 'ws-them', peerInbound: 'accept' }))

    const out = await send({ workspaceId: 'ws-them', message: 'heads up' })

    expect(out.delivered).toBe(true)
    expect(sendMessage).toHaveBeenCalledWith('ws-them', expect.stringContaining('heads up'))
    expect(state.workspaces.find((w) => w.id === 'ws-them')?.peerInbox ?? []).toHaveLength(0)
  })

  it('refuse 는 어떤 관계로도 뚫리지 않는다', async () => {
    // 내가 만든 워크스페이스라 생성자 예외에 걸리는데도, 사용자가 닫아 둔 것이 이긴다.
    state.workspaces.push(
      ws({ id: 'ws-them', peerInbound: 'refuse', createdByWorkspaceId: 'ws-me' })
    )

    await expect(send({ workspaceId: 'ws-them', message: 'hi' })).rejects.toThrow(
      /not accepting messages/
    )
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('내가 만든 워크스페이스는 hold 를 거치지 않는다', async () => {
    // notify_child 가 지금까지처럼 곧바로 깨울 수 있어야 한다 — 사용자가 생성 카드를 승인하면서
    // 이미 그 관계를 승인했다.
    state.workspaces.push(ws({ id: 'ws-mine', createdByWorkspaceId: 'ws-me' }))

    const out = await send({ workspaceId: 'ws-mine', message: 'the interface moved' })

    expect(out.delivered).toBe(true)
    expect(sendMessage).toHaveBeenCalled()
  })

  it('리포가 다르면 출처 문단이 리포 이름을 밝힌다', async () => {
    state.workspaces.push(ws({ id: 'ws-far', repoId: 'repo-2', peerInbound: 'accept' }))

    await send({ workspaceId: 'ws-far', message: 'the API contract changed' })

    // 받는 쪽이 "여기 코드베이스 이야기" 로 읽으면 존재하지 않는 파일을 찾아 헤맨다.
    expect(sendMessage).toHaveBeenCalledWith('ws-far', expect.stringContaining('wooi repository'))
  })

  it('같은 문장을 잇달아 보내면 두 번째는 버린다', async () => {
    state.workspaces.push(ws({ id: 'ws-them', peerInbound: 'accept' }))

    await send({ workspaceId: 'ws-them', message: 'same' })
    const second = await send({ workspaceId: 'ws-them', message: 'same' })

    // 서로 알리다 무한히 깨우는 고리를 여기서 끊는다. 던지지 않는 것이 중요하다 —
    // 던지면 모델이 "실패했으니 다시" 로 읽고 정확히 그 반복을 만든다.
    expect(second).toMatchObject({ delivered: false, duplicate: true })
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it('대기열이 상한을 넘으면 가장 오래된 것부터 버린다', async () => {
    state.workspaces.push(ws({ id: 'ws-them' }))

    for (let i = 0; i <= MAX_PEER_INBOX; i++) {
      await send({ workspaceId: 'ws-them', message: `message ${i}` })
    }

    const inbox = state.workspaces.find((w) => w.id === 'ws-them')?.peerInbox ?? []
    expect(inbox).toHaveLength(MAX_PEER_INBOX)
    expect(inbox[0].message).toBe('message 1')
    expect(inbox.at(-1)?.message).toBe(`message ${MAX_PEER_INBOX}`)
  })

  it('자기 자신·없는 id·아카이브된 대상은 거절한다', async () => {
    state.workspaces.push(ws({ id: 'ws-gone', archived: true }))

    await expect(send({ workspaceId: 'ws-me', message: 'hi' })).rejects.toThrow(/this workspace/)
    await expect(send({ workspaceId: 'ws-nope', message: 'hi' })).rejects.toThrow(/No Wooi/)
    await expect(send({ workspaceId: 'ws-gone', message: 'hi' })).rejects.toThrow(/archived/)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('빈 메시지는 보내지 않는다', async () => {
    state.workspaces.push(ws({ id: 'ws-them', peerInbound: 'accept' }))
    await expect(send({ workspaceId: 'ws-them', message: '   ' })).rejects.toThrow(/empty/)
  })
})
