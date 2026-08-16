import { deriveDirectionKeys, fromBase64Url, openJson } from '@shared/crypto'
import { REMOTE_PROTOCOL_VERSION } from '@shared/remote'
import type { StoredPairing } from '../storage/secure'

/**
 * 푸시 본문에는 워크스페이스 **이름**만 평문으로 실린다(`"design-tokens" finished`).
 * 어느 워크스페이스인지 — UUID 와 정규 이름 — 는 여전히 `data` 에 봉인되어 오고,
 * 탭했을 때 여기서 열려 화면 이동에 쓰인다. 본문의 이름은 표시용일 뿐 신뢰하지 않는다.
 *
 * 랩탑 쪽 계약은 `src/main/remote/push.ts` 와 `supabase/functions/push/index.ts` 에 있다:
 *   data = { m: machineId, k: kind, n: base64url(nonce), p: base64url(ct) }
 *   header = { v, machineId, deviceId, kind: 'push' }
 *   평문 = { workspaceId, workspaceName }
 */

export interface RemotePushTarget {
  workspaceId: string
  workspaceName: string
}

function isTarget(value: unknown): value is RemotePushTarget {
  if (typeof value !== 'object' || value === null) return false
  const target = value as Record<string, unknown>
  return typeof target.workspaceId === 'string' && typeof target.workspaceName === 'string'
}

/**
 * 열 수 없으면 **조용히 null** — 다른 머신의 알림(재페어링 직후 남은 것)이나 변조된
 * 페이로드가 화면을 깨뜨리는 대신 그냥 무시되어야 한다.
 */
export function openPushPayload(pairing: StoredPairing, data: unknown): RemotePushTarget | null {
  if (typeof data !== 'object' || data === null) return null
  const row = data as Record<string, unknown>
  if (row.m !== pairing.machineId) return null
  if (typeof row.n !== 'string' || typeof row.p !== 'string') return null

  try {
    const { laptopToPhone } = deriveDirectionKeys(
      fromBase64Url(pairing.sessionKey),
      pairing.deviceId
    )
    const opened = openJson(
      laptopToPhone,
      {
        v: REMOTE_PROTOCOL_VERSION,
        machineId: pairing.machineId,
        deviceId: pairing.deviceId,
        kind: 'push'
      },
      { nonce: fromBase64Url(row.n), ct: fromBase64Url(row.p) }
    )
    return isTarget(opened) ? opened : null
  } catch {
    return null
  }
}
