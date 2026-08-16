import * as Notifications from 'expo-notifications'
import { clearCommandSequence, clearPairing } from '../storage/secure'
import { useRemoteStore } from './store'
import { unpairedNotice } from './unpairNotice'

export type UnpairOutcome = 'revoked' | 'queued'

export async function unpairThisPhone(): Promise<UnpairOutcome> {
  const { pairing, unpair } = useRemoteStore.getState()
  let outcome: UnpairOutcome = 'queued'
  if (unpair !== null) {
    try {
      outcome = await unpair()
    } catch {
      outcome = 'queued'
    }
  }

  await Promise.allSettled([
    clearPairing(),
    ...(pairing === null ? [] : [clearCommandSequence(pairing.deviceId)]),
    Notifications.dismissAllNotificationsAsync(),
    Notifications.setBadgeCountAsync(0)
  ])

  // pairing 전이는 RelayClient 를 즉시 폐기한다. 원격 요청과 로컬 흔적 정리가 끝나기 전에
  // 전이하면 그 클라이언트가 인증과 폴링을 잃으므로 반드시 마지막에 한 번만 바꾼다.
  useRemoteStore.getState().unpaired(unpairedNotice(outcome))
  return outcome
}
