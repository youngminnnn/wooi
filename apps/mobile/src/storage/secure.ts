import * as SecureStore from 'expo-secure-store'
import type { SupportedStorage } from '@supabase/supabase-js'

const PAIRING_KEY = 'wooi.remote.pairing.v1'
const AUTH_PREFIX = 'wooi.remote.auth.'

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
}

export interface StoredPairing {
  url: string
  anonKey: string
  machineId: string
  machineName: string
  deviceId: string
  sessionKey: string
}

function isStoredPairing(value: unknown): value is StoredPairing {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return (
    typeof item.url === 'string' &&
    typeof item.anonKey === 'string' &&
    typeof item.machineId === 'string' &&
    typeof item.machineName === 'string' &&
    typeof item.deviceId === 'string' &&
    typeof item.sessionKey === 'string'
  )
}

export async function loadPairing(): Promise<StoredPairing | null> {
  const stored = await SecureStore.getItemAsync(PAIRING_KEY, OPTIONS)
  if (stored === null) return null
  try {
    const value: unknown = JSON.parse(stored)
    return isStoredPairing(value) ? value : null
  } catch {
    return null
  }
}

export async function savePairing(pairing: StoredPairing): Promise<void> {
  await SecureStore.setItemAsync(PAIRING_KEY, JSON.stringify(pairing), OPTIONS)
}

export async function clearPairing(): Promise<void> {
  await SecureStore.deleteItemAsync(PAIRING_KEY, OPTIONS)
}

function secureKey(key: string): string {
  let hash = 2166136261
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${AUTH_PREFIX}${(hash >>> 0).toString(16)}`
}

export const secureAuthStorage: SupportedStorage = {
  getItem: async (key: string): Promise<string | null> =>
    SecureStore.getItemAsync(secureKey(key), OPTIONS),
  setItem: async (key: string, value: string): Promise<void> => {
    await SecureStore.setItemAsync(secureKey(key), value, OPTIONS)
  },
  removeItem: async (key: string): Promise<void> => {
    await SecureStore.deleteItemAsync(secureKey(key), OPTIONS)
  }
}
