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

## 페어링 해제는 랩탑이 확정한다

폰은 RLS 때문에 자기 기기 행을 revoke 할 수 없다. 설정에서 해제를 누르면 폰은 푸시 토큰을
먼저 지우고 랩탑에 해제 명령을 보낸 뒤, 로컬 키와 세션을 정리한다. 랩탑이 깨어 있으면 그
명령이 기기를 revoke 하고 폰은 자기 행이 더 이상 조회되지 않는 것으로 완료를 확인한다.

랩탑이 자고 있으면 요청은 `queued` 로 끝날 수 있다. 처리되지 않은 명령은 15분 뒤 만료되므로,
그 안에 랩탑이 깨어나지 않으면 랩탑 목록에는 연결이 끊긴 폰이 남는다. 이 경우 랩탑의
Settings → Integrations → Remote access 에서 해당 기기를 직접 지워야 한다.

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

## 쓰지도 않는 권한은 막는다 — `blockedPermissions`

스토어 등록정보에는 앱이 **선언한** 권한이 그대로 나열된다. 랩탑을 조종하는 원격 앱에
"마이크" 가 붙어 있으면 설치 직전에 사용자가 멈칫한다. 그런데 우리가 선언한 적 없는 권한이
매니페스트 병합으로 딸려 온다:

| 권한 | 어디서 오나 |
| --- | --- |
| `RECORD_AUDIO` | `expo-camera` 의 라이브러리 매니페스트 |
| `READ/WRITE_EXTERNAL_STORAGE` | `expo-file-system` 의 라이브러리 매니페스트 |
| `SYSTEM_ALERT_WINDOW` | 출처 미확정 — 로컬 `node_modules` 에서는 `react-native` 의 **debug** 매니페스트만 나오는데 릴리즈 빌드에도 들어 있다 |

**`app.json` 의 `expo-camera` 플러그인 옵션 `recordAudioAndroid: false` 로는 못 막는다.**
그 옵션은 *앱* 매니페스트에 한 줄 더할지만 정하고(`withCamera.js` 의
`recordAudioAndroid && 'android.permission.RECORD_AUDIO'`), `expo-camera` 자신의
`android/src/main/AndroidManifest.xml` 이 이미 선언하고 있어서 병합 단계에서 올라온다.
같은 이유로 `permissions` 목록에 `CAMERA` 만 적어 두는 것도 병합을 막지 못한다 —
그 필드는 **더하는** 쪽이지 **빼는** 쪽이 아니다.

빼려면 `android.blockedPermissions` 를 쓴다. 병합된 매니페스트에 `tools:node="remove"` 를
넣어 준다.

막아도 되는 근거:

- 카메라는 페어링 QR 스캔에만 쓴다(`app/pair.tsx` 의 `CameraView` + `BarcodeScanningResult`).
  녹화 경로가 없으므로 `RECORD_AUDIO` 는 쓸 일이 없다.
- `expo-file-system` 은 앱 코드에서 쓰지 않고 직접 의존성도 아니다(`expo` 가 끌고 온다).
  Expo 내부가 쓰는 건 앱 전용 저장소라 API 29+ 에서는 이 권한이 애초에 무의미하다.
- 플로팅 창 기능이 없으므로 `SYSTEM_ALERT_WINDOW` 도 쓸 일이 없다.

**고친 뒤에는 반드시 빌드해서 병합 결과를 확인한다.** 소스는 `app.json` 이지만 최종 권한
목록을 정하는 건 Gradle 의 매니페스트 병합이라, 설정만 보고 판단하면 안 된다:

```sh
sdkmanager "build-tools;36.0.0"
aapt2 dump permissions <내려받은>.apk | grep uses-permission
```

## 수출 규정 — iOS 는 답을 정해 두고 제출한다

TestFlight 는 이 답이 없으면 **테스터에게 빌드를 내려보내지 않는다**("Missing Compliance").
심사 거절이 아니라 답하지 않은 질문이라, 빌드는 성공한 채로 아무에게도 안 간다.

이 앱은 릴레이를 종단 간 암호화한다(`src/shared/crypto.ts`) — 그 코드를 폰이 그대로 번들한다:

| 알고리즘 | 키 길이 | 표준 |
| --- | --- | --- |
| XChaCha20-Poly1305 | 256비트 (nonce 192비트) | RFC 8439 + IRTF CFRG XChaCha 초안 |
| X25519 ECDH | 255비트 곡선 | RFC 7748 |
| HKDF-SHA256 | 256비트 | RFC 5869 / FIPS 180-4 |

전부 **공개된 표준**이고, 전부 **Apple OS 밖**(`@noble/*`, 순수 JS)에서 돈다. 이 둘이 답을
결정한다 — 자체 알고리즘이 아니므로 CCATS 는 필요 없고, OS 암호로 한정되지 않으므로
"운영체제 내 암호" 면제는 못 받는다.

App Store Connect 문답의 답:

| 질문 | 답 |
| --- | --- |
| 앱이 암호화를 쓰는가 | **예** |
| Category 5 Part 2 면제(OS 내 암호·HTTPS 한정·미국/캐나다 전용 등)에 해당하는가 | **아니오** |
| 독자적이거나 국제 표준이 아닌 알고리즘을 구현하는가 | **아니오** |
| OS 암호 대신 또는 그에 더해 표준 알고리즘을 구현하는가 | **예** |

### 이 답은 App Store Connect 에 적는다 — Info.plist 가 아니라

**`ITSAppUsesNonExemptEncryption` 을 `app.json` 에 넣지 않는다.** 넣고 싶은 유혹이 크다 —
매 업로드의 문답이 사라지기 때문이다. 하지만 그 키는 혼자 다니지 않는다.

`true` 는 "나는 수출규정 문서와 그 코드를 갖고 있다"는 신호다. Apple 은 짝이 되는
`ITSEncryptionExportComplianceCode` 를 찾고, 없으면 업로드가 성공한 **뒤에** 처리 단계에서
죽는다:

```
ITMS-90592: Invalid Export Compliance Code. The export compliance key value []
in the app's Info.plist doesn't match the key value of the app's export
compliance documentation.
```

`[]` 가 "비어 있음"이다. 그 코드는 지어낼 수 없다 — 프랑스 암호 신고서를 App Store Connect 에
올려 **심사를 통과해야** Apple 이 발급한다. 그리고 우리 분류에서 그 신고서는 **프랑스 App Store
에 배포할 때만** 필요하다. 배포하지도 않을 문서를 심사받으려고 릴리즈를 세울 이유가 없다.

`false` 로 두는 길도 있지만 그건 사실과 다른 신고다.

그래서 키를 **아예 두지 않는다.** 그러면 업로드된 빌드에 "Missing Compliance" 가 붙고, App
Store Connect 에서 위 표대로 한 번 답하면 풀린다. 선언의 내용은 똑같고, 적는 곳만 다르다.

실패가 늦게 온다는 점이 이 함정의 핵심이다. `eas submit` 은 "성공"이라 답하고 끝나며(전송이
끝났다는 뜻이다), 거부는 몇 분 뒤 메일로 온다. 그 사이 TestFlight 는 그냥 비어 있어서 "아직
처리 중"과 구분되지 않는다. 2026-08-19 에 0.3.0 build 2 가 이렇게 날아갔다.

### 제출 대상은 `eas.json` 이 정한다 — 셸 변수가 아니라

`eas submit` 은 **로컬 app config 를 읽어** 어느 App Store Connect 앱에 올릴지 고른다.
`app.config.ts` 의 `APP_VARIANT` 기본값이 `development` 이라, 변수를 빠뜨리면 조용히
`com.wooi.remote.dev` 를 겨냥한다. 빌드 id 를 정확히 줘도 소용없다 — **빌드는 운영인데 대상만
개발**이 된다. 2026-08-19 에 실제로 이렇게 됐고, EAS 는 "Wooi (dev)" 앱 레코드를 새로 만들어
버렸다(App Store Connect 에 빈 앱이 하나 더 생겼다).

그래서 대상을 `eas.json` 의 submit 프로파일에 못 박았다:

```json
"submit": {
  "production": {
    "ios": { "ascAppId": "6802201873", "bundleIdentifier": "com.wooi.remote" },
    "android": { "track": "internal", "releaseStatus": "completed" }
  }
}
```

이러면 `APP_VARIANT` 를 잊어도 `--profile production` 이 항상 같은 곳으로 간다. 릴레이 환경을
`WOOI_RELAY_DEV_*` / `WOOI_RELAY_PROD_*` 로 갈라 둔 것과 같은 이유다 — 셸에 떠 있는 값이
릴리즈 경로에 섞이는 사고를 문법적으로 불가능하게 만든다.

남는 의무는 둘뿐이다:

- **연례 self-classification 보고** — 그 해에 수출한 항목을 CSV 로 다음 해 **2월 1일까지**
  `crypt@bis.doc.gov` 와 `enc@nsa.gov` 에 메일. ECCN 은 `5D992.c`(mass market).
- **프랑스 암호 신고서** — 프랑스 App Store 에 낼 때만. App Store Connect 에 업로드한다.

레포가 공개(Apache-2.0)이고 알고리즘이 전부 표준이라, EAR §742.15(b) 의 "공개된 암호
소스코드와 그것을 컴파일한 목적코드는 EAR 대상이 아니다" 를 근거로 삼는 길도 있다. 2021년
3월 규칙 개정으로 그 경로의 BIS 이메일 통지 의무도 없어졌다. 다만 App Store Connect 문답에는
이 사유를 고를 칸이 없어서, 제출은 위 표대로 하고 이건 근거로만 남긴다.

## Play 제출 — 첫 한 번은 손으로 올려야 한다

Google Play Developer API 는 **신규 앱의 첫 AAB 를 받지 않는다.** 패키지 이름이 콘솔에 이미
등록돼 있어야 API 가 열리므로, 첫 빌드는 Play Console 에서 사람이 업로드한다. 그다음부터
`eas submit` 이 붙는다.

그래서 CI 의 제출 단계는 **기본이 꺼져 있다.** 준비되기 전에 돌면 태그를 밀 때마다 릴리즈가
빨갛게 실패하기 때문이다. 저장소 변수로 잠가 뒀다:

```
Settings → Secrets and variables → Actions → Variables
MOBILE_AUTO_SUBMIT = true
```

켜기 전에 할 일:

1. Play Console 에 앱을 만들고 **AAB 를 한 번 수동 업로드** (`mobile-release.yml` 의 요약에
   뜨는 링크에서 받는다)
2. Google Cloud 에서 서비스 계정을 만들고, Play Console 에서 **"출시 관리자"** 권한을 준다
3. `eas credentials --platform android` 로 그 키를 **EAS 에 올린다**

3번을 EAS 보관으로 하는 이유는 `serviceAccountKeyPath` 를 쓰면 키 파일이 레포에 있어야
하기 때문이다. 스토어에 무엇이든 올릴 수 있는 자격증명을 커밋할 이유가 없다.

어느 트랙으로 가는지는 `eas.json` 이 정한다 — 지금은 `internal` 이다. 비공개 테스트나
프로덕션으로 **올리는 건 콘솔에서 사람이 한다.** 자동으로 프로덕션까지 가면, 태그 하나가
전 사용자에게 도달하는 데 사람의 확인이 한 번도 끼지 않는다.

스토어 등록정보에 넣을 문구와 데이터 보안 답변은 [`store/android/listing.md`](./store/android/listing.md).

## 시뮬레이터에서 화면 확인하기

화면을 눈으로 보고 싶을 때. iOS 시뮬레이터에 dev build 가 이미 깔려 있으면 한 줄이면 된다.

```sh
npm run sim:ios         # expo start --dev-client --offline --ios
npm run sim:ios:go      # dev build 가 없을 때 — Expo Go 로 띄운다
```

dev client 는 Metro 주소만 바라보므로, **다른 워크트리가 구운 dev build 라도 이 워크트리의
JS 를 그대로 받는다.** 네이티브 의존성을 건드리지 않은 변경이라면 다시 구울 필요가 없다.

`--offline` 이 붙어 있는 이유: 이 프로젝트는 `owner` 와 EAS Update 가 설정돼 있어서, 온라인
모드에서는 매니페스트에 서명하려고 Expo 계정 로그인을 요구한다(비대화형 자리에서는 그대로
죽는다). 화면만 보는 데 계정이 필요할 이유가 없다.

몇 가지 걸리는 것:

- **포트.** 워크트리마다 워크스페이스가 따로 있어서 다른 워크트리의 Metro 가 이미 8081 을
  쓰고 있는 일이 흔하다. CLI 가 다른 포트를 쓸지 물어보지만, 되묻지 못하는 자리에서는 그대로
  죽으므로 `npm run sim:ios -- --port 8083` 처럼 직접 지정한다.
- **Expo Go 로 띄우면 중간 페이지가 뜬다** — dev build 가 함께 깔려 있으면 CLI 가 둘 중
  무엇으로 열지 브라우저로 물어본다. 거기서 Expo Go 를 고르면 된다.
- 랩탑과 페어링돼 있지 않아도 첫 화면의 **Try the demo** 로 샘플 워크스페이스를 볼 수 있다.

시뮬레이터로 확인할 수 **없는** 것:

- **안드로이드 상태바 알림 아이콘**(`assets/notification-icon.png`). 빌드 시점에 drawable 로
  구워지는 네이티브 리소스라 OTA 로도, iOS 로도 확인되지 않는다. Android SDK 를 깔고
  `npx expo run:android` 로 굽거나 dev build 를 받아야 한다. iOS 알림은 이 파일과 무관하게
  앱 아이콘을 쓴다.
- **푸시 알림 전반** — Expo Go 에서는 SDK 53 부터 빠졌다(앱을 켜면 그 경고가 뜬다).

## 로컬에서 굽기

```sh
npx expo start                                      # Metro (개발)
eas build --profile development --platform android  # dev client 포함 APK
```

USB 로 물린 폰에서 Metro 가 안 잡히면 `adb reverse tcp:8081 tcp:8081` — 네트워크·VPN·IP
변화에 영향받지 않는다.
