import { create } from 'zustand'
import type { RemoteState } from '@shared/remote'
import type { StoredPairing } from '../storage/secure'

export type ConnectionStatus = 'offline' | 'connecting' | 'online'

interface RemoteStore {
  hydrated: boolean
  pairing: StoredPairing | null
  status: ConnectionStatus
  state: RemoteState | null
  updatedAt: number | null
  lastError: string | null
  refresh: (() => Promise<void>) | null
  setHydrated: (hydrated: boolean) => void
  setPairing: (pairing: StoredPairing | null) => void
  setStatus: (status: ConnectionStatus) => void
  setState: (state: RemoteState | null) => void
  setUpdatedAt: (updatedAt: number | null) => void
  setLastError: (lastError: string | null) => void
  setRefresh: (refresh: (() => Promise<void>) | null) => void
}

export const useRemoteStore = create<RemoteStore>((set) => ({
  hydrated: false,
  pairing: null,
  status: 'offline',
  state: null,
  updatedAt: null,
  lastError: null,
  refresh: null,
  setHydrated: (hydrated): void => set({ hydrated }),
  setPairing: (pairing): void => set({ pairing }),
  setStatus: (status): void => set({ status }),
  setState: (state): void =>
    set((current) =>
      current.state !== null && state !== null && state.rev < current.state.rev ? current : { state }
    ),
  setUpdatedAt: (updatedAt): void => set({ updatedAt }),
  setLastError: (lastError): void => set({ lastError }),
  setRefresh: (refresh): void => set({ refresh })
}))
