# Wooi 모바일 (Expo)

랩탑의 Wooi 세션을 폰에서 보고 조종하는 컴패니언 앱. 코드와 실행은 계속 랩탑에 남는다 —
이 앱은 원격 제어기다.

## 개발용과 운영용은 다른 앱이다

| | 패키지 / 번들 | scheme | 표시 이름 | Firebase 프로젝트 |
| --- | --- | --- | --- | --- |
| development | `com.wooi.remote.dev` | `wooi-remote-dev` | Wooi (dev) | `wooi-development` |
| production | `com.wooi.remote` | `wooi-remote` | Wooi | `wooi-production` |

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

## 네이티브 모듈을 더하면 dev build 를 다시 만들어야 한다

JS 는 Metro 가 즉시 갈아 끼우지만 **네이티브 코드는 앱 안에 구워져 있다.** 그래서
`expo install` 로 네이티브 모듈이 하나 늘어나는 순간, 폰에 깔린 dev client 는 그 모듈을
모르는 채로 새 JS 를 받게 되고 그 모듈을 import 하는 화면에서 죽는다.

증상이 헷갈린다 — Metro 도 정상이고 번들도 잘 내려가는데 앱만 에러 화면을 띄운다. 실제로
`react-native-svg` 를 더했을 때 정확히 그랬다(설치본 10:58, 모듈 추가 12:52).

`node_modules/<모듈>/android` 나 `ios` 가 있으면 네이티브다. 그럴 땐:

```sh
eas build --profile development --platform android
```

같은 이유로 다음도 JS 리로드로는 반영되지 않는다 — 전부 다시 빌드해야 한다:

- 앱 아이콘·스플래시 등 `assets/` 의 네이티브 리소스
- `app.config.ts` / `app.json` 의 패키지 이름·`scheme`·플러그인 설정
- `google-services.*.json`

## EAS Update 로 내보낼 수 있는 것

EAS Update 는 이미 설치된 앱의 네이티브 껍데기는 그대로 두고, Metro 가 묶는 JavaScript 와
스타일, 이미지 자산만 바꾼다. 화면의 동작이나 문구, 레이아웃을 고치는 데는 쓸 수 있지만
`expo-camera` 같은 네이티브 모듈을 추가·변경할 수는 없다. `app.json`·`app.config.ts` 의
네이티브 설정, 앱 아이콘, 권한, 패키지 이름도 마찬가지다. 이런 변경은 운영체제가 설치하는
바이너리에 들어가므로 반드시 새 스토어 빌드를 내야 한다.

빌드는 프로파일과 같은 이름의 `development`, `preview`, `production` 채널만 바라본다. 다른
단계의 업데이트가 섞이지 않게 하려는 경계다. 업데이트를 내보낼 때는 메시지를 덧붙여
`EXPO_TOKEN="$(cat ~/.expo-token)" npm run update:preview -- --message "Describe the change"`처럼
실행한다. 운영 반영 전에는 같은 변경을 preview 채널에서 먼저 확인한다. 토큰은 명령에
환경 변수로만 넘기고 화면에 출력하지 않는다.

런타임 버전은 `fingerprint` 정책으로 정한다. 네이티브 의존성이나 네이티브 설정이 달라지면
fingerprint 도 달라져, 그 네이티브 기능이 없는 예전 바이너리가 새 JavaScript 를 받지 않는다.
대신 네이티브 표면을 바꾼 뒤에는 새 빌드를 설치해야 그 런타임을 대상으로 업데이트할 수 있다.

잘못된 업데이트를 배포했다면 먼저 해당 채널과 런타임에서 데이터 호환성을 확인한 뒤
`EXPO_TOKEN="$(cat ~/.expo-token)" eas update:rollback`을 실행한다. 이 명령의 대화형 안내에서
직전의 정상 업데이트를 다시 배포하거나 앱에 내장된 업데이트로 돌아갈 수 있다. 업데이트가
기기 저장 데이터를 호환되지 않게 바꿨다면 이전 코드도 안전하지 않을 수 있으므로, 그 경우에는
롤백보다 수정 업데이트가 낫다.

**스토어 심사자가 본 데모 모드는 OTA 업데이트로 절대 바꾸지 않는다.** 심사 뒤에 리뷰어가
확인한 동작을 바꾸는 것은 App Store 와 Play Store 모두 기만적인 행위로 보기 때문이다. 데모
모드 변경은 사소한 JavaScript 변경처럼 보여도 반드시 새 스토어 빌드로 다시 심사받는다.

## 빌드는 태그가 만든다

데스크톱과 같은 원칙이다 — 누구의 노트북에서 구웠는지가 아니라 레포의 어느 커밋에서 나왔는지가
남아야 한다. (빌드 자체는 원래도 로컬이 아니었다. EAS 클라우드에서 굽고, 바뀐 것은 트리거다.)

```sh
# apps/mobile/app.json 의 expo.version 을 올려 커밋한 뒤
git tag mobile-v0.2.0 && git push origin mobile-v0.2.0
```

첫 버전은 `0.1.0` 이다. 데스크톱은 이미 1.x 지만 이쪽은 아직 아무에게도 나간 적이 없고,
`0.x` 는 "아직 굳지 않았다"를 뜻한다 — 같은 1.x 를 달면 성숙도가 같다는 뜻이 되어 버린다.
스토어에 한 번 제출하면 버전은 되돌릴 수 없으므로, 내릴 수 있는 시점은 제출 전뿐이다.

`mobile-release` 워크플로가 태그와 `app.json` 의 version 이 같은지 먼저 확인하고, 다르면
굽기 전에 끊는다. 어긋난 채로 나가면 스토어에는 옛 버전이 올라가는데 릴리즈 이름만 새 버전이
되고, 빌드는 성공으로 끝나 눈치채기 어렵다.

스토어에 내지 않고 확인만 할 때는 Actions 에서 workflow_dispatch 로 프로파일·플랫폼을 골라
돌린다.

### 버전은 둘로 나뉜다

| | 어디가 갖나 | 이유 |
| --- | --- | --- |
| 사람이 보는 버전 (`app.json` 의 `version`) | **레포** | 커밋과 태그로 추적돼야 한다 |
| 스토어 빌드 번호 (`versionCode` / `buildNumber`) | **EAS** (`appVersionSource: remote`) | 절대 되돌아가면 안 되는 단조 증가 값이라, 커밋으로 관리하면 충돌·되감기가 난다 |

### 자격증명은 처음 한 번 직접 만든다

`--non-interactive` 에서는 EAS 가 Android 키스토어나 iOS 인증서를 **새로 만들지 못하고 그
자리에서 실패한다.** 그래서 production 프로파일로 처음 굽는 것은 로컬에서 대화형으로 한다:

```sh
cd apps/mobile
EXPO_TOKEN="$(cat ~/.expo-token)" npx eas build --profile production --platform all
```

물어보는 대로 승인하면 EAS 가 만들어 보관하고, 그 뒤로는 CI 가 그것을 쓴다. iOS 는 이때
Apple 계정으로 로그인해 인증서·프로비저닝 프로파일과 APNs 키를 만든다 — 이걸 건너뛰면
푸시가 안 되는 앱이 나간다.

## 로컬에서 굽기

```sh
npx expo start                                      # Metro (개발)
eas build --profile development --platform android  # dev client 포함 APK
```

USB 로 물린 폰에서 Metro 가 안 잡히면 `adb reverse tcp:8081 tcp:8081` — 네트워크·VPN·IP
변화에 영향받지 않는다.
