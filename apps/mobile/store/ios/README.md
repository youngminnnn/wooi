# App Store 등록정보 자산

`assets/` 의 아이콘과 **다른 것들**이다. `assets/` 는 앱 바이너리 안에 구워지는 런처 아이콘이고,
여기 있는 것은 스토어 페이지에 올라가는 그림이다. 규격도 다르고 쓰이는 자리도 다르다.

Play 쪽(`../android/`)과 원칙은 같다 — 손으로 만든 PNG 을 어딘가에서 주워 오는 게 아니라
**레포에서 다시 만들 수 있어야 한다.**

```sh
brew install librsvg   # rsvg-convert
./build.sh
```

## 자산 목록

| 파일 | 규격 | 상태 |
| --- | --- | --- |
| `icon-1024.png` | 1024×1024, **24비트 PNG(알파 없음)**, 모서리 각짐 | ✅ `../shared/icon.svg` 에서 생성 |
| `screenshots/iphone-6.9/*.png` | **1320×2868**, 최소 1장·최대 10장 | ✅ 5장 — 시뮬레이터에서 촬영 |
| `screenshots/ipad-13/*.png` | **2064×2752**, 최소 1장 | ✅ 3장 — `supportsTablet: true` 라 필수 |
| 앱 미리보기 영상 | 15~30초 | ⬜ 선택 |

Play 에 있는 **피처 그래픽은 App Store 에 없다.** 그 자리를 대신하는 게 스크린샷 첫 장이라,
1번을 목록에서 가장 먼저 보이는 그림으로 골라야 한다.

## 아이콘 — SVG 를 한 벌만 둔다

`build.sh` 는 `../shared/icon.svg` 를 그대로 렌더링한다. 두 스토어가 요구하는 것은 **같은
마크**이고 다른 것은 래스터 규격뿐이다:

|  | Play | App Store |
| --- | --- | --- |
| 크기 | 512×512 | **1024×1024** |
| 채널 | 32비트(알파 **있음**) | 24비트(알파 **없음** — 있으면 거부) |
| 모서리 | Play 가 30% 반경으로 깎음 | iOS 가 squircle 로 깎음 |

방향이 정반대인 항목이 있어서 `png-recode.py` 가 양쪽에 쓰인다. SVG 를 한 벌 더 두면 한쪽만
고쳐지고, 그때 두 스토어의 아이콘이 말없이 갈린다 — 아무도 눈치채지 못하는 종류의 어긋남이다.

**모서리를 미리 둥글게 만들면 안 되는 것도 양쪽 공통이다.** iOS 는 squircle 마스크를 직접
얹으므로 미리 깎으면 두 번 깎여 안쪽에 이가 빠진다. 마크는 15% 안쪽 여백에 있어 어느 마스크에도
걸리지 않는다.

그래서 그림 원본과 PNG 재인코더는 `store/shared/` 에 있다. 어느 한 스토어의 디렉터리
안에 두면 다른 쪽이 `../android/src/...` 같은 경로로 건너와야 하고, 그 모양은 "Play 것을
iOS 가 빌려 쓴다" 고 읽힌다 — 실제로는 **양쪽이 대등하게 쓰는 한 벌**이다.

## 스크린샷 — Play 와 달리 후처리가 없다

Apple 은 **픽셀 크기를 정확히** 요구한다(1픽셀도 어긋나면 거부). 대신 시뮬레이터가 바로 그
크기로 찍어 준다. 안드로이드에서는 실기기 화면비가 2:1 을 넘어 무엇을 찍든 캔버스에 다시
앉혀야 했는데, 여기서는 기기만 맞으면 그걸로 끝이다.

```sh
./screenshots.sh capture iphone 01-workspaces   # raw/iphone/01-workspaces.png
./screenshots.sh capture ipad   01-workspaces
./screenshots.sh build                          # raw/ → screenshots/ (검증 + 알파 제거)
```

`build` 가 하는 일은 크기 검증과 알파 채널 제거뿐이다. **알파 제거는 장식이 아니다** —
시뮬레이터가 찍은 원본은 32비트 RGBA 이고, Apple 은 알파가 있는 스크린샷을 거부한다.

크기가 어긋난 입력이 들어오면 비율을 유지한 채 규격 캔버스에 앉힌다 — 안전망이지 정상
경로가 아니다. 그 줄에는 경고가 찍힌다.

| 기기 종류 | 시뮬레이터 | 나오는 크기 |
| --- | --- | --- |
| `iphone` | iPhone 17 Pro Max (6.9″) | 1320×2868 |
| `ipad` | iPad Pro 13-inch (M5) | 2064×2752 |

기기 이름은 Xcode 버전마다 바뀐다. 다른 기기를 쓰려면 `IPHONE_DEVICE` / `IPAD_DEVICE` 로
덮어쓴다. `raw/` 는 커밋하지 않는다(`.gitignore`).

### iPad 를 빠뜨리면 제출 자체가 막힌다

`app.json` 의 `supportsTablet` 이 `true` 라 App Store 는 iPad 스크린샷을 **최소 1장** 요구한다.
iPhone 것만 올리면 "제출" 버튼이 열리지 않는다. 앱이 iPad 에서 잘 도는 것과 무관하다.

iPad 를 지원하지 않기로 정한다면 `supportsTablet` 을 `false` 로 내리는 게 맞다. 하지만 그건
네이티브 설정이라 새 빌드가 필요하고, 지금 앱은 iPad 에서도 정상으로 돈다.

### 무엇을 찍는가 — 데모 모드로 찍으면 된다

페어링된 랩탑 없이도 앱 전체를 볼 수 있다. 첫 화면의 **"Try the demo"** 를 누르면 샘플 세션이
채워진다(`src/state/demo.ts`). 실제 워크스페이스 이름이나 코드가 노출되지 않으므로 스토어
스크린샷에 그대로 쓸 수 있다.

순서는 스토어에 보이는 순서다. Play 쪽과 같은 5장으로 맞춘다 — 두 스토어의 페이지가 서로 다른
앱처럼 보이면 곤란하다:

1. **워크스페이스 목록** — 여러 세션이 병렬로 돌고, 기다리는 것이 승인인지 답인지가 배지로
   갈려 보인다
2. **권한 승인** — 이 앱의 존재 이유에 가장 가까운 화면
3. **질문 답하기** — 선택지 카드. 승인과 다른 종류의 기다림이다
4. **PR 상태** — 체크 결과를 폰에서 확인한다
5. **페어링** — 랩탑과 어떻게 이어지는지

데모 데이터가 바뀌면 그림도 바뀐다. 앱 UI 나 `demo.ts` 를 건드렸다면 여기 그림도 같이 봐야 한다.

### 시뮬레이터에는 탭 API 가 없다 — 앱이 스스로 돌게 한다

`enterDemo()` 는 `app/pair.tsx` 버튼의 `onPress` 로만 불린다. 라우트도 아니고 저장되지도 않는
**메모리 상태**라(`src/state/store.ts` 의 `demo: false`) 밖에서 켤 수 없다. 그런데 시뮬레이터를
밖에서 조작하는 길이 전부 막혀 있다:

| 방법 | 막히는 지점 |
| --- | --- |
| `xcrun simctl` | `screenshot`·`openurl`·`launch`·`terminate` 뿐. 탭 API 자체가 없다 |
| `osascript` 좌표 클릭 | macOS 보조 접근 권한이 필요하고, **디스플레이가 잠들면 창이 AX 에 0개**로 보여 좌표를 못 잡는다 |
| `simctl openurl` 딥링크 | iOS 가 "'Wooi'에서 열겠습니까?" 확인 창을 띄우는데, 그걸 닫는 것도 탭이다. 콜드 스타트도 마찬가지 |

그래서 **버리는 브랜치에 임시 코드를 얹어 앱이 스스로 화면을 돌게 했다.** 15초마다 다음 화면으로
넘어가며 무한 반복하고, 밖에서는 `simctl io screenshot` 만 주기적으로 찍어 원하는 장면을 고른다
— 이건 헤드리스라 맥 화면이 잠겨 있어도 된다.

```ts
const STORE_SHOT_ROUTES = ['/', '/workspace/mobile-checkout',
                           '/workspace/docs-refresh', '/workspace/mobile-checkout/pr']
const STORE_SHOT_DWELL_MS = 15_000
```

데모 워크스페이스 id 는 `src/state/demo.ts` 에 하드코딩이라 고정이다. 같은 브랜치에서
`DemoBanner` 도 숨긴다 — Play 쪽 그림에 배너가 없어서 구도를 맞추려는 것이고, 배너는 헤더 바로
아래 고정이라 스크롤로는 가려지지 않는다.

**임시 코드는 산출 브랜치에 절대 넣지 않는다.** 되돌리는 것을 잊으면 그대로 새어 나가고, 실제로
그런 전례가 있다. 별도 브랜치에 담아 찍고 나서 브랜치째 버리면 되돌릴 것 자체가 없다.

찍히는 것을 고를 때는 `sips -Z 24` 로 축소해 서로 거리를 재면 같은 화면끼리 묶인다. 회전 순서와
묶음 순서가 같으므로 어느 묶음이 어느 화면인지는 한 장만 눈으로 확인하면 정해진다.

**심사자가 보는 것도 이 데모 모드다.** App Store Connect 의 "심사 정보 ▸ 메모" 에 데모 모드
진입 방법을 반드시 적어야 한다. 랩탑 페어링이 필요한 앱이라 심사자가 로그인할 방법이 달리 없다.

그리고 심사 뒤에 데모 모드를 OTA 업데이트로 바꾸지 않는다 — 이유는 `apps/mobile/README.md`.

## 앱은 `preview-simulator` 프로파일로 넣는다

```sh
cd ../..    # apps/mobile
EXPO_TOKEN="$(cat ~/.expo-token)" npx eas build --profile preview-simulator --platform ios
```

내려받은 `.tar.gz` 를 풀면 `Wooi.app` 이 나온다:

```sh
xcrun simctl install <UDID> /path/to/Wooi.app
xcrun simctl launch <UDID> com.wooi.remote
```

`development-simulator` 가 아니라 `preview-simulator` 인 이유 — preview 는 `APP_VARIANT=production`
이라 이름도 `Wooi` 이고 Metro 없이 단독으로 돈다. dev client 는 개발 서버에 붙어야 화면이 뜨고,
번들이 어느 워크트리에서 왔는지에 따라 그림이 달라진다. **스토어에 올라갈 화면은 사용자가 실제로
보는 화면이어야 한다.**

데모 모드는 카메라·푸시·페어링을 전혀 쓰지 않으므로 시뮬레이터로 충분하다. 다만 **페어링 QR
화면만은** 시뮬레이터에 카메라가 없어 "Can't scan? Paste the code" 쪽 UI 로만 보인다 — 실기기가
생기면 그 한 장은 다시 찍는 편이 낫다.
