import { Platform } from 'react-native'
import Constants from 'expo-constants'
import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import { darkTheme } from '../theme'

/**
 * 폰을 푸시 수신자로 등록한다. 토큰은 릴레이의 `devices.expo_push_token` 에 들어가고,
 * 그건 RLS 트리거가 폰에게 허용한 **유일한 self-update 컬럼**이다.
 */

function projectId(): string | null {
  const fromConfig = Constants.expoConfig?.extra?.eas?.projectId
  if (typeof fromConfig === 'string' && fromConfig.length > 0) return fromConfig
  const fromEas = Constants.easConfig?.projectId
  return typeof fromEas === 'string' && fromEas.length > 0 ? fromEas : null
}

/**
 * Android 는 채널이 없으면 알림이 조용히 사라진다. 앱 설정 화면에서 사용자가 끌 수 있도록
 * 채널 하나만 두고, 중요도는 HIGH — 권한 요청을 놓치면 이 기능의 존재 이유가 없다.
 */
export async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return
  await Notifications.setNotificationChannelAsync('default', {
    name: 'Workspace alerts',
    importance: Notifications.AndroidImportance.HIGH,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
    vibrationPattern: [0, 250, 250, 250],
    // 알림 LED 색은 앱 테마를 따르지 않는다 — 앱 밖에서, 대개 화면이 꺼진 채로 켜지는 불이라
    // 배경이랄 게 없다. app.json 의 expo-notifications `color` 와 같은 브랜드 보라 하나로
    // 고정한다(두 값이 갈리면 Android 가 어느 쪽을 쓰는지 추적할 수 없게 된다).
    lightColor: darkTheme.accent
  })
}

export class PushRegistrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PushRegistrationError'
  }
}

/**
 * 권한을 묻고 Expo 푸시 토큰을 받아 온다. 거절되면 **null** — 던지지 않는다.
 * 알림을 원하지 않는 것은 오류가 아니고, 앱의 나머지는 그대로 동작해야 한다.
 */
export async function requestPushToken(): Promise<string | null> {
  if (!Device.isDevice) return null
  await ensureAndroidChannel()

  const existing = await Notifications.getPermissionsAsync()
  const granted =
    existing.granted ||
    existing.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL ||
    (await Notifications.requestPermissionsAsync()).granted
  if (!granted) return null

  const id = projectId()
  if (id === null) {
    // dev build 가 아니면(Expo Go) 여기 도달하지 않지만, 설정 누락은 조용히 넘기면 안 된다.
    throw new PushRegistrationError('This build has no EAS project id, so it cannot receive push')
  }
  const token = await Notifications.getExpoPushTokenAsync({ projectId: id })
  return token.data
}
