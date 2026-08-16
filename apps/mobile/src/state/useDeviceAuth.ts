import { useCallback, useRef } from 'react'
import { Alert } from 'react-native'
import * as LocalAuthentication from 'expo-local-authentication'

/**
 * 랩탑에 무언가를 시키기 전의 기기 인증.
 *
 * 이 폰에는 세션키와 릴레이 갱신 토큰이 들어 있다. **잠금 해제된 폰을 도난당한 시나리오에서
 * 이것이 유일한 방어선**이라, 권한 승인과 프롬프트 전송 양쪽에 똑같이 건다 — 에이전트에게
 * 임의의 일을 시키는 것과 에이전트의 요청을 허락하는 것은 위험도가 다르지 않다.
 *
 * 세션 단위로 한 번만 묻고 몇 분간 열어 두는 방식을 쓰지 않는다. 그 창이 정확히
 * "방금 잠금을 풀고 내려놓은 폰"을 노리는 공격자에게 열어 주는 창이기 때문이다.
 */
export function useDeviceAuthentication(): (promptMessage: string) => Promise<boolean> {
  const warnedUnavailable = useRef(false)

  return useCallback(async (promptMessage: string): Promise<boolean> => {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage,
      cancelLabel: 'Cancel',
      disableDeviceFallback: false,
      biometricsSecurityLevel: 'strong'
    })
    if (result.success) return true

    // 생체도 암호도 없는 기기에서는 막을 방법이 없다. 조용히 통과시키지 않고 한 번은
    // 사실대로 알린다 — 사용자가 자기 기기의 상태를 알아야 판단할 수 있다.
    if (
      result.error === 'not_available' ||
      result.error === 'not_enrolled' ||
      result.error === 'passcode_not_set'
    ) {
      if (!warnedUnavailable.current) {
        warnedUnavailable.current = true
        Alert.alert(
          'Device authentication unavailable',
          'This device cannot verify biometrics or a passcode. This will proceed without authentication.'
        )
      }
      return true
    }
    return false
  }, [])
}
