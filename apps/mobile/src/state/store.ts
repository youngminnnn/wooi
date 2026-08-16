import { create } from 'zustand'
import type { RemoteState } from '@shared/remote'
import type { StoredPairing } from '../storage/secure'
import type { RemoteCommandChannel } from '../relay/client'

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
  pairing: StoredPairing | null
  status: ConnectionStatus
  state: RemoteState | null
  updatedAt: number | null
  laptopSeenAt: number | null
  lastError: string | null
  unpairedReason: string | null
  refresh: (() => Promise<void>) | null
  command: ((channel: RemoteCommandChannel, args: unknown[]) => Promise<unknown>) | null
  activityRev: number
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
  bumpActivity: () => void
}

export const useRemoteStore = create<RemoteStore>((set) => ({
  hydrated: false,
  pairing: null,
  status: 'offline',
  state: null,
  updatedAt: null,
  laptopSeenAt: null,
  lastError: null,
  unpairedReason: null,
  refresh: null,
  command: null,
  activityRev: 0,
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
  bumpActivity: (): void => set((current) => ({ activityRev: current.activityRev + 1 }))
}))
