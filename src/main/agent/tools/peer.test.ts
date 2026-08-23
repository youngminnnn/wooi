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

async function sendExternal(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { sendToWorkspaceExternal } = await import('./peer')
  return sendToWorkspaceExternal(deps, args) as Promise<Record<string, unknown>>
}

async function status(messageId?: string, workspaceId = 'ws-me'): Promise<Record<string, unknown>> {
  const { checkMessageStatus } = await import('./peer')
  return checkMessageStatus(deps, workspaceId, messageId ? { messageId } : {}) as Promise<
    Record<string, unknown>
  >
}

describe('list_workspace_peers', () => {
  it('외부 호출자에게는 자기 자신이 없으므로 열린 workspace를 모두 보여 준다', async () => {
    state.workspaces.push(ws({ id: 'ws-other', archived: true }))
    const { listWorkspacePeersExternal } = await import('./peer')
    const out = (await listWorkspacePeersExternal()) as Record<string, unknown>
    expect((out.peers as Array<Record<string, unknown>>).map((p) => p.workspaceId)).toEqual([
      'ws-me'
    ])
  })
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
      ws({ id: 'ws-default' }),
      ws({ id: 'ws-shut', peerInbound: 'hold' }),
      ws({ id: 'ws-blocked', peerInbound: 'refuse' })
    )

    const peers = (await list()).peers as Array<Record<string, unknown>>
    expect(peers.find((p) => p.workspaceId === 'ws-default')?.delivery).toBe('immediate')
    expect(peers.find((p) => p.workspaceId === 'ws-shut')?.delivery).toBe('needs approval')
    expect(peers.find((p) => p.workspaceId === 'ws-blocked')?.delivery).toBe('blocked')
  })

  it('자기 자신과 아카이브된 워크스페이스는 빼놓는다', async () => {
    state.workspaces.push(ws({ id: 'ws-gone', archived: true }))
    const peers = (await list()).peers as Array<Record<string, unknown>>
    expect(peers).toHaveLength(0)
  })
})

describe('send_to_workspace', () => {
  it('메시지 id를 돌려주고 즉시 전달 결말을 조회한다', async () => {
    state.workspaces.push(ws({ id: 'ws-them' }))
    const out = await send({ targetWorkspaceId: 'ws-them', message: 'heads up' })
    expect(out.messageId).toMatch(/^pm-[0-9a-z]+-[0-9a-f]{8}$/)
    await expect(status(out.messageId as string)).resolves.toMatchObject({
      status: 'delivered',
      final: true,
      messageId: out.messageId
    })
  })

  it('승인 대기와 승인 뒤 전달을 같은 id로 기록한다', async () => {
    state.workspaces.push(ws({ id: 'ws-them', peerInbound: 'hold' }))
    const out = await send({ targetWorkspaceId: 'ws-them', message: 'heads up' })
    const pending = state.workspaces.find((w) => w.id === 'ws-them')?.peerInbox?.[0]
    expect(pending?.id).toBe(out.messageId)
    await expect(status(out.messageId as string)).resolves.toMatchObject({
      status: 'waiting-for-user-approval',
      final: false
    })
    const { deliverApprovedPeerMessage } = await import('./peer')
    deliverApprovedPeerMessage(deps, 'ws-them', pending!)
    await expect(status(out.messageId as string)).resolves.toMatchObject({
      status: 'delivered-after-user-approval',
      final: true
    })
  })

  it('사용자 거절은 뒤늦은 상태 전이로 덮어쓰지 않는다', async () => {
    state.workspaces.push(ws({ id: 'ws-them', peerInbound: 'hold' }))
    const out = await send({ targetWorkspaceId: 'ws-them', message: 'heads up' })
    const { resolvePeerMessage } = await import('./peerLedger')
    resolvePeerMessage('ws-me', out.messageId as string, 'declined-by-user')
    resolvePeerMessage('ws-me', out.messageId as string, 'delivered-after-user-approval')
    expect((await status(out.messageId as string)).status).toBe('declined-by-user')
  })

  it('보관 기한이 지난 id와 새 미등록 id를 구분한다', async () => {
    const oldId = `pm-${(Date.now() - 8 * 24 * 60 * 60 * 1000).toString(36)}-12345678`
    const freshId = `pm-${Date.now().toString(36)}-87654321`
    expect((await status(oldId)).status).toBe('unknown-expired')
    expect((await status(freshId)).status).toBe('unknown-no-such-message')
  })

  it('발신 기록 50건 상한에서 가장 오래된 것만 만료된다', async () => {
    state.workspaces.push(ws({ id: 'ws-them' }))
    const ids: string[] = []
    let tick = Date.now()
    const now = vi.spyOn(Date, 'now').mockImplementation(() => tick++)
    for (let i = 0; i < 51; i += 1) {
      const out = await send({ targetWorkspaceId: 'ws-them', message: `message ${i}` })
      ids.push(out.messageId as string)
    }
    now.mockRestore()
    expect((await status(ids[0])).status).toBe('unknown-expired')
    expect((await status(ids.at(-1)!)).status).toBe('delivered')
  })

  it('running 버퍼는 flush 뒤 전달되고 reset이면 같은 id로 승인 대기에 돌아간다', async () => {
    state.workspaces.push(ws({ id: 'ws-them', status: 'running' }))
    const first = await send({ targetWorkspaceId: 'ws-them', message: 'first' })
    expect((await status(first.messageId as string)).status).toBe('waiting-for-target-turn-to-end')
    const { flushBufferedPeerMessages, resetPeerSession } = await import('./peer')
    expect(flushBufferedPeerMessages('ws-them')).toBe(true)
    expect((await status(first.messageId as string)).status).toBe('delivered')

    const second = await send({ targetWorkspaceId: 'ws-them', message: 'second' })
    resetPeerSession('ws-them')
    expect((await status(second.messageId as string)).status).toBe(
      'returned-waiting-for-user-approval'
    )
    expect(state.workspaces.find((w) => w.id === 'ws-them')?.peerInbox?.[0]?.id).toBe(
      second.messageId
    )
  })

  it('되돌릴 워크스페이스가 사라졌으면 승인 대기가 아니라 유실로 기록한다', async () => {
    state.workspaces.push(ws({ id: 'ws-them', status: 'running' }))
    const out = await send({ targetWorkspaceId: 'ws-them', message: 'heads up' })
    // 대상이 사라진 뒤의 park 는 되돌릴 자리가 없다. 그때 "승인 대기" 로 남기면 발신자는
    // 오지 않을 결말을 영영 기다린다.
    state.workspaces = state.workspaces.filter((w) => w.id !== 'ws-them')
    const { resetPeerSession } = await import('./peer')
    resetPeerSession('ws-them')
    await expect(status(out.messageId as string)).resolves.toMatchObject({
      status: 'dropped-target-workspace-gone',
      final: true
    })
  })

  it('중복 폐기도 id와 조회 가능한 결말을 돌려준다', async () => {
    state.workspaces.push(ws({ id: 'ws-them' }))
    await send({ targetWorkspaceId: 'ws-them', message: 'same' })
    const duplicate = await send({ targetWorkspaceId: 'ws-them', message: 'same' })
    expect(duplicate.messageId).toMatch(/^pm-/)
    expect((await status(duplicate.messageId as string)).status).toBe('not-delivered-duplicate')
  })

  it('다른 워크스페이스의 발신 기록은 조회할 수 없다', async () => {
    state.workspaces.push(ws({ id: 'ws-other' }), ws({ id: 'ws-them' }))
    const { recordPeerSend, newPeerMessageId } = await import('./peerLedger')
    const id = newPeerMessageId()
    recordPeerSend('ws-other', {
      id,
      toWorkspaceId: 'ws-them',
      toName: 'them',
      excerpt: 'secret',
      outcome: 'delivered',
      at: Date.now(),
      outcomeAt: Date.now()
    })
    expect((await status(id)).status).toBe('unknown-no-such-message')
  })

  it('승인 대기함 상한은 가장 오래된 메시지를 dropped로 기록한다', async () => {
    state.workspaces.push(ws({ id: 'ws-them', peerInbound: 'hold' }))
    const ids: string[] = []
    for (let i = 0; i <= MAX_PEER_INBOX; i += 1) {
      const out = await send({ targetWorkspaceId: 'ws-them', message: `held ${i}` })
      ids.push(out.messageId as string)
    }
    expect((await status(ids[0])).status).toBe('dropped-target-inbox-full')
    expect((await status(ids.at(-1)!)).status).toBe('waiting-for-user-approval')
  })

  it('외부 발신은 id만 돌려주고 어느 워크스페이스에도 기록하지 않는다', async () => {
    state.workspaces.push(ws({ id: 'ws-them' }))
    const out = await sendExternal({ targetWorkspaceId: 'ws-them', message: 'outside' })
    expect(out.messageId).toMatch(/^pm-/)
    expect(state.workspaces.every((w) => !w.peerSent?.length)).toBe(true)
  })
  it('외부 메시지는 refuse 대상에 전달되지 않는다', async () => {
    state.workspaces.push(ws({ id: 'ws-them', peerInbound: 'refuse' }))
    await expect(
      sendExternal({ targetWorkspaceId: 'ws-them', message: 'heads up' })
    ).rejects.toThrow(/not accepting messages/)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('외부 메시지는 hold 대상에서 승인 대기하며 모델에 닿지 않는다', async () => {
    state.workspaces.push(ws({ id: 'ws-them', peerInbound: 'hold' }))
    const out = await sendExternal({ targetWorkspaceId: 'ws-them', message: 'heads up' })
    expect(out.delivered).toBe(false)
    expect(sendMessage).not.toHaveBeenCalled()
    expect(state.workspaces.find((w) => w.id === 'ws-them')?.peerInbox).toHaveLength(1)
    expect(state.workspaces.find((w) => w.id === 'ws-them')?.peerInbox?.[0]).toMatchObject({
      fromWorkspaceId: null,
      fromName: 'Outside Claude Code session'
    })
  })

  it.each([null, undefined])(
    '외부 메시지는 createdByWorkspaceId=%s여도 생성자 예외로 hold를 뚫지 않는다',
    async (createdByWorkspaceId) => {
      state.workspaces.push(ws({ id: 'ws-them', peerInbound: 'hold', createdByWorkspaceId }))
      const out = await sendExternal({ targetWorkspaceId: 'ws-them', message: 'heads up' })
      expect(out.delivered).toBe(false)
      expect(sendMessage).not.toHaveBeenCalled()
    }
  )

  it('외부 메시지는 accept 대상에 바깥 세션 출처 전문과 함께 전달된다', async () => {
    state.workspaces.push(ws({ id: 'ws-them', peerInbound: 'accept' }))
    const out = await sendExternal({ targetWorkspaceId: 'ws-them', message: 'heads up' })
    expect(out.delivered).toBe(true)
    expect(sendMessage).toHaveBeenCalledWith(
      'ws-them',
      expect.stringContaining('From an outside Claude Code session, not the user'),
      expect.anything()
    )
  })
  it('정책이 없으면 큐를 거치지 않고 바로 전달한다', async () => {
    state.workspaces.push(ws({ id: 'ws-them', branch: 'feat/them' }))

    const out = await send({
      targetWorkspaceId: 'ws-them',
      message: 'the schema column is tenant_id'
    })

    expect(out.delivered).toBe(true)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(state.workspaces.find((w) => w.id === 'ws-them')?.peerInbox ?? []).toHaveLength(0)
  })

  it('accept 로 열어 둔 대상에게는 바로 전달한다', async () => {
    state.workspaces.push(ws({ id: 'ws-them', peerInbound: 'accept' }))

    const out = await send({ targetWorkspaceId: 'ws-them', message: 'heads up' })

    expect(out.delivered).toBe(true)
    expect(sendMessage).toHaveBeenCalledWith(
      'ws-them',
      expect.stringContaining('heads up'),
      expect.anything()
    )
    expect(state.workspaces.find((w) => w.id === 'ws-them')?.peerInbox ?? []).toHaveLength(0)
  })

  it('전달 옵션에 화면용 peer 출처와 모델용 완성 문장을 함께 싣는다', async () => {
    state.workspaces.push(ws({ id: 'ws-far', repoId: 'repo-2', branch: 'fix/consumer' }))

    await send({ targetWorkspaceId: 'ws-far', message: 'the API contract changed' })

    const [target, text, options] = sendMessage.mock.calls[0]
    expect(target).toBe('ws-far')
    expect(text).toContain('not the user')
    expect(options).toEqual({
      origin: {
        kind: 'peer',
        messages: [
          {
            fromName: 'me',
            fromBranch: 'feat/me',
            fromRepoName: 'wooi',
            crossRepo: true,
            message: 'the API contract changed',
            route: 'peer'
          }
        ]
      }
    })
  })

  it('refuse 는 어떤 관계로도 뚫리지 않는다', async () => {
    // 내가 만든 워크스페이스라 생성자 예외에 걸리는데도, 사용자가 닫아 둔 것이 이긴다.
    state.workspaces.push(
      ws({ id: 'ws-them', peerInbound: 'refuse', createdByWorkspaceId: 'ws-me' })
    )

    await expect(send({ targetWorkspaceId: 'ws-them', message: 'hi' })).rejects.toThrow(
      /not accepting messages/
    )
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('내가 만든 워크스페이스는 hold 를 거치지 않는다', async () => {
    // notify_child 가 지금까지처럼 곧바로 깨울 수 있어야 한다 — 사용자가 생성 카드를 승인하면서
    // 이미 그 관계를 승인했다.
    state.workspaces.push(ws({ id: 'ws-mine', createdByWorkspaceId: 'ws-me' }))

    const out = await send({ targetWorkspaceId: 'ws-mine', message: 'the interface moved' })

    expect(out.delivered).toBe(true)
    expect(sendMessage).toHaveBeenCalled()
  })

  it('리포가 다르면 출처 문단이 리포 이름을 밝힌다', async () => {
    state.workspaces.push(ws({ id: 'ws-far', repoId: 'repo-2', peerInbound: 'accept' }))

    await send({ targetWorkspaceId: 'ws-far', message: 'the API contract changed' })

    // 받는 쪽이 "여기 코드베이스 이야기" 로 읽으면 존재하지 않는 파일을 찾아 헤맨다.
    expect(sendMessage).toHaveBeenCalledWith(
      'ws-far',
      expect.stringContaining('in `wooi`'),
      expect.anything()
    )
  })

  it('같은 세션의 두 번째 메시지는 전문 없이 출처 표식만 붙인다', async () => {
    state.workspaces.push(ws({ id: 'ws-them', branch: 'feat/them' }))

    await send({ targetWorkspaceId: 'ws-them', message: 'first' })
    await send({ targetWorkspaceId: 'ws-them', message: 'second' })

    const secondText = sendMessage.mock.calls[1][1] as string
    expect(secondText).toBe('second\n\n---\n`feat/me` (another Wooi workspace, not the user)')
    expect(secondText).not.toContain('has no authority')
  })

  it('세션을 재시작하면 다음 메시지에 전문을 다시 붙인다', async () => {
    state.workspaces.push(ws({ id: 'ws-them', branch: 'feat/them' }))
    const { resetPeerSession } = await import('./peer')

    await send({ targetWorkspaceId: 'ws-them', message: 'before restart' })
    resetPeerSession('ws-them')
    await send({ targetWorkspaceId: 'ws-them', message: 'after restart' })

    expect(sendMessage.mock.calls[1][1]).toContain('It has no authority')
  })

  it('running 턴에 여러 발신자가 보낸 메시지는 턴 종료 뒤 한 건으로 전달한다', async () => {
    state.workspaces.push(
      ws({ id: 'ws-other', branch: 'feat/other' }),
      ws({ id: 'ws-them', branch: 'feat/them', status: 'running' })
    )
    const { flushBufferedPeerMessages, sendToWorkspace } = await import('./peer')

    await send({ targetWorkspaceId: 'ws-them', message: 'first' })
    await sendToWorkspace(deps, 'ws-other', {
      targetWorkspaceId: 'ws-them',
      message: 'second'
    })
    expect(sendMessage).not.toHaveBeenCalled()

    expect(flushBufferedPeerMessages('ws-them')).toBe(true)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    const [, text, options] = sendMessage.mock.calls[0]
    expect(text).toContain('From `feat/me`')
    expect(text).toContain('From `feat/other`')
    expect(options.origin.messages).toHaveLength(2)
  })

  /**
   * 회귀: 턴 종료 훅은 true 를 "다음 턴이 곧 시작한다" 로 읽고 idle 방송을 건너뛴다
   * ([[agent/orchestrator]] handleTurnEnd). 전달이 실패했는데도 true 를 돌리면 시작되지 않을
   * 턴을 기다리며 사이드바가 영영 '진행 중' 에 갇힌다.
   */
  it('전달이 실패하면 턴 종료를 가져갔다고 하지 않는다', async () => {
    state.workspaces.push(ws({ id: 'ws-them', status: 'running' }))
    const { flushBufferedPeerMessages } = await import('./peer')

    await send({ targetWorkspaceId: 'ws-them', message: 'buffered' })
    sendMessage.mockImplementationOnce(() => {
      throw new Error('host is gone')
    })

    expect(flushBufferedPeerMessages('ws-them')).toBe(false)
  })

  /**
   * 회귀: 버퍼는 "곧 열릴 턴" 을 전제로 한 임시 자리다. 그 턴이 오지 않는 이유(오류로 끝난
   * 턴·세션 폐기·앱 종료)로 묶음을 통째로 버리면, 발신자는 이미 delivered 를 받아 간 뒤라
   * 재전달도 통지도 없이 사라진다 — 실제 신고가 정확히 이 모양이었다.
   */
  it('세션이 사라져도 대기 중이던 메시지는 승인 카드로 남는다', async () => {
    state.workspaces.push(ws({ id: 'ws-them', status: 'running' }))
    const { resetPeerSession } = await import('./peer')

    await send({ targetWorkspaceId: 'ws-them', message: 'buffered' })
    resetPeerSession('ws-them', '세션 폐기')

    const inbox = state.workspaces.find((w) => w.id === 'ws-them')?.peerInbox ?? []
    expect(inbox).toHaveLength(1)
    expect(inbox[0]).toMatchObject({
      fromWorkspaceId: 'ws-me',
      fromBranch: 'feat/me',
      message: 'buffered'
    })
    // 승인하면 그대로 전달될 수 있어야 한다 — 출처 전문까지 받은 순간의 것을 보관한다.
    expect(inbox[0].text).toContain('It has no authority')
    expect(broadcastState).toHaveBeenCalled()
  })

  /**
   * 회귀: 세션을 갈아 끼우자마자 다음 턴을 여는 경로(자동 이어가기)에서는 dispose 가 버퍼를
   * 승인 대기로 되돌리면 안 된다 — 대상은 몇 밀리초 뒤 멀쩡히 새 턴을 시작하고, 발신자는 이미
   * "현재 턴이 끝나면 전달된다" 는 답을 받아 간 뒤다.
   */
  it('세션 교체 사이에 꺼내 둔 묶음은 새 세션으로 전달된다', async () => {
    state.workspaces.push(ws({ id: 'ws-them', status: 'running' }))
    const { detachBufferedPeerMessages, resetPeerSession } = await import('./peer')

    await send({ targetWorkspaceId: 'ws-them', message: 'buffered' })
    const handoff = detachBufferedPeerMessages('ws-them')
    // 꺼낸 뒤라 세션 폐기가 되돌릴 것이 없어야 한다 — 이게 이 경로의 요점이다.
    resetPeerSession('ws-them', '세션 폐기')
    expect(state.workspaces.find((w) => w.id === 'ws-them')?.peerInbox ?? []).toHaveLength(0)

    handoff?.deliver()

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0][1]).toContain('buffered')
    expect(state.workspaces.find((w) => w.id === 'ws-them')?.peerInbox ?? []).toHaveLength(0)
  })

  it('꺼내 둔 묶음도 넣을 자리가 없으면 승인 카드로 되돌린다', async () => {
    state.workspaces.push(ws({ id: 'ws-them', status: 'running' }))
    const { detachBufferedPeerMessages } = await import('./peer')

    await send({ targetWorkspaceId: 'ws-them', message: 'buffered' })
    detachBufferedPeerMessages('ws-them')?.park('자동 이어가기 실패')

    expect(state.workspaces.find((w) => w.id === 'ws-them')?.peerInbox).toHaveLength(1)
  })

  it('꺼내 둔 묶음의 전달이 실패하면 승인 카드로 남는다', async () => {
    state.workspaces.push(ws({ id: 'ws-them', status: 'running' }))
    const { detachBufferedPeerMessages } = await import('./peer')

    await send({ targetWorkspaceId: 'ws-them', message: 'buffered' })
    sendMessage.mockImplementationOnce(() => {
      throw new Error('host is gone')
    })
    detachBufferedPeerMessages('ws-them')?.deliver()

    expect(state.workspaces.find((w) => w.id === 'ws-them')?.peerInbox).toHaveLength(1)
  })

  it('앱 단위 정리에서도 대기 중이던 메시지를 버리지 않는다', async () => {
    state.workspaces.push(ws({ id: 'ws-them', status: 'running' }))
    const { resetAllPeerSessions } = await import('./peer')

    await send({ targetWorkspaceId: 'ws-them', message: 'buffered' })
    resetAllPeerSessions('모든 세션 폐기')

    expect(state.workspaces.find((w) => w.id === 'ws-them')?.peerInbox).toHaveLength(1)
  })

  it('전달에 실패한 묶음도 승인 카드로 남는다', async () => {
    state.workspaces.push(ws({ id: 'ws-them', status: 'running' }))
    const { flushBufferedPeerMessages } = await import('./peer')

    await send({ targetWorkspaceId: 'ws-them', message: 'buffered' })
    sendMessage.mockImplementationOnce(() => {
      throw new Error('host is gone')
    })
    flushBufferedPeerMessages('ws-them')

    expect(state.workspaces.find((w) => w.id === 'ws-them')?.peerInbox).toHaveLength(1)
  })

  it('idle 대상은 버퍼를 거치지 않고 즉시 전달한다', async () => {
    state.workspaces.push(ws({ id: 'ws-them', status: 'idle' }))

    await send({ targetWorkspaceId: 'ws-them', message: 'now' })

    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it('같은 문장을 잇달아 보내면 두 번째는 버린다', async () => {
    state.workspaces.push(ws({ id: 'ws-them', peerInbound: 'accept' }))

    await send({ targetWorkspaceId: 'ws-them', message: 'same' })
    const second = await send({ targetWorkspaceId: 'ws-them', message: 'same' })

    // 서로 알리다 무한히 깨우는 고리를 여기서 끊는다. 던지지 않는 것이 중요하다 —
    // 던지면 모델이 "실패했으니 다시" 로 읽고 정확히 그 반복을 만든다.
    expect(second).toMatchObject({ delivered: false, duplicate: true })
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  /**
   * 회귀: 승인 대기로 잡힌 것까지 지문을 남기면, 60초 안의 재시도가 "저쪽이 이미 받았다" 는
   * 거짓 답을 듣는다. 대상은 아무것도 받지 못한 채인데 발신 모델은 그것을 성공으로 요약한다.
   */
  it('승인 대기로 잡힌 메시지는 중복 창을 만들지 않는다', async () => {
    state.workspaces.push(ws({ id: 'ws-them', peerInbound: 'hold' }))

    const first = await send({ targetWorkspaceId: 'ws-them', message: 'same' })
    const second = await send({ targetWorkspaceId: 'ws-them', message: 'same' })

    expect(first.delivered).toBe(false)
    expect(second.duplicate).toBeUndefined()
    expect(state.workspaces.find((w) => w.id === 'ws-them')?.peerInbox).toHaveLength(2)
  })

  it('배달되지 않은 결과는 status 한 줄로 못 박는다', async () => {
    state.workspaces.push(ws({ id: 'ws-held', peerInbound: 'hold' }), ws({ id: 'ws-open' }))

    const held = await send({ targetWorkspaceId: 'ws-held', message: 'hi' })
    const open = await send({ targetWorkspaceId: 'ws-open', message: 'hi' })

    // 압축은 note 부터 잘라 낸다. 잘린 자리에서 실패가 "보냈다" 로 요약되지 않으려면 짧은
    // 필드가 스스로 말해야 한다.
    expect(held.status).toBe('NOT-DELIVERED-waiting-for-user-approval')
    expect(open.status).toBe('delivered')
  })

  it('대기열이 상한을 넘으면 가장 오래된 것부터 버린다', async () => {
    state.workspaces.push(ws({ id: 'ws-them', peerInbound: 'hold' }))

    for (let i = 0; i <= MAX_PEER_INBOX; i++) {
      await send({ targetWorkspaceId: 'ws-them', message: `message ${i}` })
    }

    const inbox = state.workspaces.find((w) => w.id === 'ws-them')?.peerInbox ?? []
    expect(inbox).toHaveLength(MAX_PEER_INBOX)
    expect(inbox[0].message).toBe('message 1')
    expect(inbox.at(-1)?.message).toBe(`message ${MAX_PEER_INBOX}`)
  })

  it('자기 자신·없는 id·아카이브된 대상은 거절한다', async () => {
    state.workspaces.push(ws({ id: 'ws-gone', archived: true }))

    await expect(send({ targetWorkspaceId: 'ws-me', message: 'hi' })).rejects.toThrow(
      /is the recipient, not you/
    )
    await expect(send({ targetWorkspaceId: 'ws-nope', message: 'hi' })).rejects.toThrow(/No Wooi/)
    await expect(send({ targetWorkspaceId: 'ws-gone', message: 'hi' })).rejects.toThrow(/archived/)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('자기 자신을 지목하면 무엇이 틀렸는지 말해 준다', async () => {
    // Codex 재개 스레드가 실제로 이렇게 실패했다 — 대화 기록에 남은 옛 지침("네 id 를 넘겨라")을
    // 따라 대상 자리에 자기 id 를 적었다. 그래서 "틀렸다" 가 아니라 "그 규칙이 낡았다" 를 말한다.
    await expect(send({ targetWorkspaceId: 'ws-me', message: 'hi' })).rejects.toThrow(
      /Wooi already knows who is calling/
    )
  })

  it('빈 메시지는 보내지 않는다', async () => {
    state.workspaces.push(ws({ id: 'ws-them', peerInbound: 'accept' }))
    await expect(send({ targetWorkspaceId: 'ws-them', message: '   ' })).rejects.toThrow(/empty/)
  })
})
