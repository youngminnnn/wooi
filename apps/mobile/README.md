# Wooi Remote (Expo)

랩탑의 Wooi 세션을 폰에서 보고 조종하는 컴패니언 앱. 코드와 실행은 계속 랩탑에 남는다 —
이 앱은 원격 제어기다.

## 개발용과 운영용은 다른 앱이다

| | 패키지 / 번들 | scheme | 표시 이름 | Firebase 프로젝트 |
| --- | --- | --- | --- | --- |
| development | `com.wooi.remote.dev` | `wooi-remote-dev` | Wooi Remote (dev) | `wooi-development` |
| production | `com.wooi.remote` | `wooi-remote` | Wooi Remote | `wooi-production` |

`app.config.ts` 가 `APP_VARIANT` 로 고른다(기본값 `development`). EAS 프로파일이 그 값을
넘긴다 — `eas.json` 의 `build.<profile>.env` 참고.

패키지 이름까지 나누는 이유:

1. FCM 자격증명은 (Firebase 프로젝트 × 패키지 이름) 에 묶인다. 이름이 같으면 개발용 빌드가
   운영 Firebase 프로젝트의 자리를 차지한다.
2. 한 폰에 둘 다 깔려 있어야 한다 — 개발하려고 운영 앱을 지우고 싶지 않다.
3. `scheme` 이 달라야 알림 딥링크가 엉뚱한 앱을 열지 않는다.

## 릴레이(Supabase)는 여기서 고르지 않는다

폰은 릴레이 주소와 anon 키를 **페어링 QR 에서** 배운다(`src/main/remote/pairing.ts`).
개발 랩탑이 띄운 QR 은 개발 릴레이를, 배포본이 띄운 QR 은 운영 릴레이를 실어 나른다.
그래서 이 앱에는 릴레이 환경이라는 개념 자체가 없다. 자세한 것은 `supabase/README.md`.

## Firebase 설정 파일

| 파일 | 변형 | 커밋 |
| --- | --- | --- |
| `google-services.development.json` | development | 한다 — 공개 식별자뿐이고, EAS 빌드가 git 아카이브를 쓰므로 무시하면 빌드에 안 들어간다 |
| `google-services.production.json` | production | 한다 |
| 서비스 계정 비공개 키 | 둘 다 | **안 한다** — 유출되면 누구나 이 앱 이름으로 푸시를 보낼 수 있다. `eas credentials` 로 EAS 에만 올린다 |

파일이 없으면 config 가 경고만 하고 넘어간다. 푸시와 무관한 작업(페어링·트랜스크립트)까지
막을 이유가 없기 때문이다 — 대신 그 빌드는 알림을 받지 못한다.

## 빌드

```sh
npx expo start                                      # Metro (개발)
eas build --profile development --platform android  # dev client 포함 APK
```

USB 로 물린 폰에서 Metro 가 안 잡히면 `adb reverse tcp:8081 tcp:8081` — 네트워크·VPN·IP
변화에 영향받지 않는다.
