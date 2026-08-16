import { Platform } from 'react-native'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  computeSas,
  derivePairingKek,
  fromBase64Url,
  generateKeyPair,
  open,
  sharedSecret,
  toBase64Url
} from '@shared/crypto'
import { REMOTE_PROTOCOL_VERSION, type RemoteDevicePlatform } from '@shared/remote'
import { savePairing, secureAuthStorage, type StoredPairing } from '../storage/secure'

const POLL_INTERVAL_MS = 1500
const PAIRING_TIMEOUT_MS = 5 * 60 * 1000

interface PairingQr {
  v: number
  url: string
  anonKey: string
  machineId: string
  machineName: string
  mpk: string
  code: string
}

interface ClaimResponse {
  machineId: string
  machineName: string
  machinePubKey: string
}

interface FinishResponse {
  deviceId: string
  machineId: string
  machineName: string
  wrappedKey: string
  wrappedNonce: string
}

export interface ClaimedPairing {
  sas: string
  machineName: string
  finish: () => Promise<StoredPairing>
}

export class PairingError extends Error {
  readonly code: 'invalid-qr' | 'invalid-code' | 'expired' | 'compromised' | 'network'

  constructor(code: PairingError['code'], message: string) {
    super(message)
    this.name = 'PairingError'
    this.code = code
  }
}

function requiredString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function parsePairingQr(raw: string): PairingQr {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new PairingError('invalid-qr', 'This is not a Wooi pairing code')
  }
  if (typeof value !== 'object' || value === null) {
    throw new PairingError('invalid-qr', 'This is not a Wooi pairing code')
  }
  const item = value as Record<string, unknown>
  if (
    item.v !== REMOTE_PROTOCOL_VERSION ||
    !requiredString(item.url) ||
    !requiredString(item.anonKey) ||
    !requiredString(item.machineId) ||
    !requiredString(item.machineName) ||
    !requiredString(item.mpk) ||
    !requiredString(item.code)
  ) {
    throw new PairingError('invalid-qr', 'This is not a compatible Wooi pairing code')
  }
  try {
    const url = new URL(item.url)
    if (url.protocol !== 'https:') throw new Error('Insecure relay URL')
    if (fromBase64Url(item.mpk).length !== 32 || fromBase64Url(item.code).length !== 16) {
      throw new Error('Invalid key material')
    }
  } catch {
    throw new PairingError('invalid-qr', 'This pairing code is malformed')
  }
  return item as unknown as PairingQr
}

function isClaimResponse(value: unknown): value is ClaimResponse {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return (
    requiredString(item.machineId) &&
    requiredString(item.machineName) &&
    requiredString(item.machinePubKey)
  )
}

function isFinishResponse(value: unknown): value is FinishResponse {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return (
    requiredString(item.deviceId) &&
    requiredString(item.machineId) &&
    requiredString(item.machineName) &&
    requiredString(item.wrappedKey) &&
    requiredString(item.wrappedNonce)
  )
}

async function postPair(
  qr: PairingQr,
  accessToken: string,
  body: Record<string, unknown>
): Promise<Response> {
  return fetch(`${qr.url}/functions/v1/pair`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: qr.anonKey,
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify(body)
  })
}

function platform(): RemoteDevicePlatform {
  return Platform.OS === 'ios' ? 'ios' : 'android'
}

async function anonymousToken(client: SupabaseClient): Promise<string> {
  const current = await client.auth.getSession()
  if (current.data.session?.access_token) return current.data.session.access_token
  const signedIn = await client.auth.signInAnonymously()
  if (signedIn.error || !signedIn.data.session?.access_token) {
    throw new PairingError('network', 'Could not sign in to the relay')
  }
  return signedIn.data.session.access_token
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function claimPairing(rawQr: string, deviceName: string): Promise<ClaimedPairing> {
  const qr = parsePairingQr(rawQr)
  const client = createClient(qr.url, qr.anonKey, {
    auth: { storage: secureAuthStorage, persistSession: true, autoRefreshToken: true }
  })
  const accessToken = await anonymousToken(client)
  const phone = generateKeyPair()
  let claim: Response
  try {
    claim = await postPair(qr, accessToken, {
      action: 'claim',
      code: qr.code,
      devicePubKey: toBase64Url(phone.publicKey),
      deviceName,
      devicePlatform: platform()
    })
  } catch {
    throw new PairingError('network', 'Could not reach the relay')
  }
  if (claim.status === 404) {
    throw new PairingError('invalid-code', 'This code is no longer valid')
  }
  if (!claim.ok) throw new PairingError('network', 'The relay rejected the pairing request')
  const claimValue: unknown = await claim.json()
  if (
    !isClaimResponse(claimValue) ||
    claimValue.machineId !== qr.machineId ||
    claimValue.machinePubKey !== qr.mpk
  ) {
    throw new PairingError('compromised', 'The pairing response could not be verified')
  }
  let shared: Uint8Array
  try {
    shared = sharedSecret(phone.secretKey, fromBase64Url(claimValue.machinePubKey))
  } catch {
    throw new PairingError('compromised', 'The pairing response contains an invalid key')
  }
  const sas = computeSas(shared, qr.code)

  return {
    sas,
    machineName: claimValue.machineName,
    finish: async (): Promise<StoredPairing> => {
      const deadline = Date.now() + PAIRING_TIMEOUT_MS
      while (Date.now() < deadline) {
        let response: Response
        try {
          response = await postPair(qr, accessToken, { action: 'finish', code: qr.code })
        } catch {
          await wait(POLL_INTERVAL_MS)
          continue
        }
        if (response.status === 409) {
          await wait(POLL_INTERVAL_MS)
          continue
        }
        if (response.status === 404) {
          throw new PairingError('expired', 'Pairing expired. Start again on your laptop.')
        }
        if (!response.ok) {
          throw new PairingError('network', 'The relay could not finish pairing')
        }
        const value: unknown = await response.json()
        if (
          !isFinishResponse(value) ||
          value.machineId !== qr.machineId ||
          value.machineId !== claimValue.machineId
        ) {
          throw new PairingError('compromised', 'The pairing result could not be verified')
        }
        let sessionKey: Uint8Array
        try {
          sessionKey = open(
            derivePairingKek(shared, qr.code),
            {
              v: REMOTE_PROTOCOL_VERSION,
              machineId: value.machineId,
              deviceId: value.deviceId,
              kind: 'result'
            },
            {
              nonce: fromBase64Url(value.wrappedNonce),
              ct: fromBase64Url(value.wrappedKey)
            }
          )
        } catch {
          throw new PairingError(
            'compromised',
            'Pairing verification failed. Do not use this connection.'
          )
        }
        const pairing: StoredPairing = {
          url: qr.url,
          anonKey: qr.anonKey,
          machineId: value.machineId,
          machineName: value.machineName,
          deviceId: value.deviceId,
          sessionKey: toBase64Url(sessionKey)
        }
        await savePairing(pairing)
        return pairing
      }
      throw new PairingError('expired', 'Pairing expired. Start again on your laptop.')
    }
  }
}
