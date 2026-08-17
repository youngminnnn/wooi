import { create } from 'zustand'
import type { RemoteState } from '@shared/remote'
import type { StoredPairing } from '../storage/secure'
import type { RemoteCommandChannel } from '../relay/client'
import { createDemoSession } from './demo'
import type { UnpairOutcome } from './unpair'

export type ConnectionStatus = 'offline' | 'connecting' | 'online'

/**
 * 랩탑이 자리를 비웠다고 볼 기준. 랩탑은 60초마다 heartbeat 를 찍으므로 두 번 반 놓치면
 * 자거나 죽은 것으로 본다 — 한 번 놓친 것으로 단정하면 잠깐의 네트워크 끊김에도 깜빡인다.
 */
export const LAPTOP_STALE_MS = 150_000

/**
 * **폰이 오프라인인 것과 랩탑이 자는 것은 다른 일이다.** 전자는 내 신호가 안 나가는 것이고
 * 후자는 상대가 없는 것이라, 사용자가 할 수 있는 일도 다르다. 그래서 따로 판단한다.
 */
export function isLaptopAway(seenAt: number | null, now: number = Date.now()): boolean {
  return seenAt !== null && now - seenAt > LAPTOP_STALE_MS
}

interface RemoteStore {
  hydrated: boolean
  demo: boolean
  pairing: StoredPairing | null
  status: ConnectionStatus
  state: RemoteState | null
  updatedAt: number | null
  laptopSeenAt: number | null
  lastError: string | null
  unpairedReason: string | null
  refresh: (() => Promise<void>) | null
  command: ((channel: RemoteCommandChannel, args: unknown[]) => Promise<unknown>) | null
  unpair: (() => Promise<UnpairOutcome>) | null
  activityRev: number
  enterDemo: () => void
  leaveDemo: () => void
  setHydrated: (hydrated: boolean) => void
  setPairing: (pairing: StoredPairing | null) => void
  setStatus: (status: ConnectionStatus) => void
  setState: (state: RemoteState | null) => void
  setUpdatedAt: (updatedAt: number | null) => void
  setLaptopSeenAt: (laptopSeenAt: number | null) => void
  setLastError: (lastError: string | null) => void
  setUnpairedReason: (unpairedReason: string | null) => void
  setRefresh: (refresh: (() => Promise<void>) | null) => void
  setCommand: (
    command: ((channel: RemoteCommandChannel, args: unknown[]) => Promise<unknown>) | null
  ) => void
  setUnpair: (unpair: (() => Promise<UnpairOutcome>) | null) => void
  unpaired: (reason: string | null) => void
  bumpActivity: () => void
}

export const useRemoteStore = create<RemoteStore>((set, get) => ({
  hydrated: false,
  demo: false,
  pairing: null,
  status: 'offline',
  state: null,
  updatedAt: null,
  laptopSeenAt: null,
  lastError: null,
  unpairedReason: null,
  refresh: null,
  command: null,
  unpair: null,
  activityRev: 0,
  enterDemo: (): void => {
    const session = createDemoSession()
    const command = async (channel: RemoteCommandChannel, args: unknown[]): Promise<unknown> => {
      if (channel === 'remote:watch' || channel === 'remote:ping') return null
      if (channel === 'remote:transcript') {
        const workspaceId = args[0]
        const query = args[1]
        if (typeof workspaceId !== 'string') throw new Error('Invalid demo workspace')
        const items = session.transcripts.get(workspaceId) ?? []
        const beforeTs =
          typeof query === 'object' && query !== null && 'beforeTs' in query
            ? (query as { beforeTs?: unknown }).beforeTs
            : undefined
        const limit =
          typeof query === 'object' && query !== null && 'limit' in query
            ? (query as { limit?: unknown }).limit
            : 100
        return items
          .filter((item) => typeof beforeTs !== 'number' || item.ts < beforeTs)
          .sort((left, right) => right.ts - left.ts)
          .slice(0, typeof limit === 'number' ? limit : 100)
      }
      if (channel === 'pr:checks') {
        // 랩탑이 없는 데모에서도 PR 화면이 진짜와 같은 모양으로 열려야 한다. 목록에 없으면
        // null — 랩탑의 핸들러도 PR 이 없으면 그렇게 답한다.
        const workspaceId = args[0]
        if (typeof workspaceId !== 'string') throw new Error('Invalid demo workspace')
        return session.checks.get(workspaceId) ?? null
      }
      if (channel === 'permission:respond') {
        const requestId = args[0]
        set((current) => {
          if (!current.demo || current.state === null) return current
          return {
            state: {
              ...current.state,
              rev: current.state.rev + 1,
              pendingPermissions: current.state.pendingPermissions.filter(
                (item) =>
                  typeof item !== 'object' ||
                  item === null ||
                  !('requestId' in item) ||
                  item.requestId !== requestId
              ),
              workspaces: current.state.workspaces.map((item) =>
                item.attention === 'permission' ? { ...item, attention: null } : item
              )
            },
            activityRev: current.activityRev + 1
          }
        })
        return null
      }
      const workspaceId = args[0]
      if (typeof workspaceId !== 'string') throw new Error('Invalid demo workspace')
      if (channel === 'chat:interrupt') {
        set((current) => ({
          state:
            current.state === null
              ? null
              : {
                  ...current.state,
                  rev: current.state.rev + 1,
                  workspaces: current.state.workspaces.map((item) =>
                    item.id === workspaceId ? { ...item, status: 'idle' } : item
                  )
                },
          activityRev: current.activityRev + 1
        }))
        return null
      }
      if (channel === 'chat:send') {
        const prompt = args[1]
        if (typeof prompt !== 'string') throw new Error('Invalid demo message')
        const timestamp = Date.now()
        const items = session.transcripts.get(workspaceId) ?? []
        items.push(
          { id: `demo-user-${timestamp}`, type: 'user', text: prompt, ts: timestamp },
          {
            id: `demo-assistant-${timestamp}`,
            type: 'assistant',
            text: 'Demo reply: this message stayed on your phone and was not sent to a computer.',
            ts: timestamp + 1
          }
        )
        session.transcripts.set(workspaceId, items)
        set((current) => ({
          state:
            current.state === null
              ? null
              : {
                  ...current.state,
                  rev: current.state.rev + 1,
                  workspaces: current.state.workspaces.map((item) =>
                    item.id === workspaceId
                      ? { ...item, lastActiveAt: timestamp, status: 'idle' }
                      : item
                  )
                },
          activityRev: current.activityRev + 1
        }))
        return null
      }
      throw new Error(`Unsupported demo command: ${channel}`)
    }
    set({
      demo: true,
      pairing: null,
      status: 'online',
      state: session.state,
      updatedAt: Date.now(),
      // 데모에는 랩탑이 없다. 시각을 넣어 두면 150초 뒤 "랩탑이 자고 있다" 배너가 떠서
      // 바로 위의 데모 배너와 정면으로 모순된다. null 은 "모른다"이고, 그게 사실이다.
      laptopSeenAt: null,
      lastError: null,
      unpairedReason: null,
      refresh: async () => undefined,
      command,
      unpair: null,
      activityRev: get().activityRev + 1
    })
  },
  leaveDemo: (): void =>
    set({
      demo: false,
      status: 'offline',
      state: null,
      updatedAt: null,
      laptopSeenAt: null,
      lastError: null,
      refresh: null,
      command: null,
      unpair: null
    }),
  setHydrated: (hydrated): void => set({ hydrated }),
  setPairing: (pairing): void => set({ pairing }),
  setStatus: (status): void => set({ status }),
  setState: (state): void =>
    set((current) =>
      current.state !== null && state !== null && state.rev < current.state.rev
        ? current
        : { state }
    ),
  setUpdatedAt: (updatedAt): void => set({ updatedAt }),
  setLaptopSeenAt: (laptopSeenAt): void => set({ laptopSeenAt }),
  setLastError: (lastError): void => set({ lastError }),
  setUnpairedReason: (unpairedReason): void => set({ unpairedReason }),
  setRefresh: (refresh): void => set({ refresh }),
  setCommand: (command): void => set({ command }),
  setUnpair: (unpair): void => set({ unpair }),
  unpaired: (reason): void =>
    set({
      pairing: null,
      state: null,
      refresh: null,
      command: null,
      unpair: null,
      status: 'offline',
      updatedAt: null,
      laptopSeenAt: null,
      lastError: null,
      unpairedReason: reason
    }),
  bumpActivity: (): void => set((current) => ({ activityRev: current.activityRev + 1 }))
}))
