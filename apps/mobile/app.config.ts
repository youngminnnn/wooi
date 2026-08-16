import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ConfigContext, ExpoConfig } from 'expo/config'

/**
 * 개발용과 운영용을 **다른 앱**으로 만든다.
 *
 * 왜 패키지 이름까지 나누는가:
 *   1. FCM 자격증명은 (Firebase 프로젝트 × 패키지 이름) 에 묶인다. 이름이 같으면 개발용 빌드가
 *      운영 Firebase 프로젝트의 자리를 차지한다.
 *   2. 같은 폰에 둘 다 깔려 있어야 한다 — 개발 중에 운영 앱을 지우고 싶지 않다.
 *   3. `scheme` 이 달라야 알림 딥링크가 엉뚱한 앱을 열지 않는다.
 *
 * 릴레이(Supabase) 는 여기서 고르지 않는다. 폰은 릴레이 주소와 anon 키를 **페어링 QR 에서**
 * 배우므로(`src/main/remote/pairing.ts`), 개발 랩탑의 QR 은 개발 릴레이를, 배포본의 QR 은
 * 운영 릴레이를 실어 나른다. 앱은 어느 쪽인지 알 필요가 없다.
 */

const isDevelopment = (process.env.APP_VARIANT ?? 'development') === 'development'

/**
 * Firebase 설정 파일은 콘솔에서 받아 와야 존재한다. 없을 때 config 를 터뜨리면 아직 푸시와
 * 무관한 작업(페어링·트랜스크립트)까지 못 하게 되므로, 경고만 하고 빠진 채로 진행한다.
 * 빌드가 실제로 필요할 때는 EAS 가 FCM 자격증명 부재를 따로 알려 준다.
 */
function googleServices(file: string): string | undefined {
  const path = resolve(__dirname, file)
  if (existsSync(path)) return file
  console.warn(`[wooi-remote] ${file} 이 없습니다 — 이 빌드는 푸시 알림을 받지 못합니다.`)
  return undefined
}

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: isDevelopment ? 'Wooi Remote (dev)' : 'Wooi Remote',
  slug: config.slug ?? 'wooi-remote',
  scheme: isDevelopment ? 'wooi-remote-dev' : 'wooi-remote',
  ios: {
    ...config.ios,
    bundleIdentifier: isDevelopment ? 'com.wooi.remote.dev' : 'com.wooi.remote'
  },
  android: {
    ...config.android,
    package: isDevelopment ? 'com.wooi.remote.dev' : 'com.wooi.remote',
    googleServicesFile: googleServices(
      isDevelopment
        ? './google-services.development.json'
        : './google-services.production.json'
    )
  }
})
