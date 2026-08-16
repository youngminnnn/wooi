import * as SecureStore from 'expo-secure-store'
import type { SupportedStorage } from '@supabase/supabase-js'
import type { ThemePreference } from '../theme'

const PAIRING_KEY = 'wooi.remote.pairing.v1'
const AUTH_PREFIX = 'wooi.remote.auth.'
const SEQUENCE_PREFIX = 'wooi.remote.sequence.'
const THEME_KEY = 'wooi.remote.theme.v1'
let sequenceQueue: Promise<void> = Promise.resolve()

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

export async function clearCommandSequence(deviceId: string): Promise<void> {
  await SecureStore.deleteItemAsync(`${SEQUENCE_PREFIX}${deviceId}`, OPTIONS)
}

export function nextCommandSequence(deviceId: string): Promise<number> {
  let resolveSequence: (value: number) => void
  let rejectSequence: (reason: unknown) => void
  const result = new Promise<number>((resolve, reject) => {
    resolveSequence = resolve
    rejectSequence = reject
  })
  sequenceQueue = sequenceQueue
    .catch(() => undefined)
    .then(async () => {
      try {
        const key = `${SEQUENCE_PREFIX}${deviceId}`
        const stored = await SecureStore.getItemAsync(key, OPTIONS)
        const current = stored === null ? 0 : Number(stored)
        const next = Number.isSafeInteger(current) && current >= 0 ? current + 1 : 1
        if (!Number.isSafeInteger(next)) throw new Error('Command sequence is exhausted')
        // 삽입 전에 저장해야 앱이 중단되어도 같은 번호를 다시 쓰지 않는다.
        await SecureStore.setItemAsync(key, String(next), OPTIONS)
        resolveSequence(next)
      } catch (error) {
        rejectSequence(error)
      }
    })
  return result
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

/**
 * 테마 선호. 보안 값이 아니지만 앱에 이미 있는 저장소가 SecureStore 뿐이라 여기에 둔다
 * (한 단어짜리 값 하나를 위해 저장소를 하나 더 들이지 않는다). 언페어해도 지우지 않는다 —
 * 이건 페어링 상태가 아니라 이 **기기**의 취향이고, 다시 붙였다고 리셋될 이유가 없다.
 */
export async function loadThemePreference(): Promise<ThemePreference | null> {
  const stored = await SecureStore.getItemAsync(THEME_KEY, OPTIONS)
  return stored === 'system' || stored === 'light' || stored === 'dark' ? stored : null
}

export async function saveThemePreference(preference: ThemePreference): Promise<void> {
  await SecureStore.setItemAsync(THEME_KEY, preference, OPTIONS)
}
