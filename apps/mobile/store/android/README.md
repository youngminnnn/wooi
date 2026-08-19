# Play 스토어 등록정보 자산

`assets/` 의 아이콘과 **다른 것들**이다. `assets/` 는 앱 바이너리 안에 구워지는 런처 아이콘이고,
여기 있는 것은 스토어 페이지에 올라가는 그림이다. 규격도 다르고 쓰이는 자리도 다르다.

빌드는 `apps/mobile/README.md` 의 원칙과 같다 — 손으로 만든 PNG 을 어딘가에서 주워 오는 게
아니라 **레포의 SVG 에서 다시 만들 수 있어야 한다.**

```sh
brew install librsvg   # rsvg-convert
./build.sh
```

## 자산 목록

| 파일 | 규격 | 상태 |
| --- | --- | --- |
| `icon-512.png` | 512×512, **32비트 PNG(알파 포함)**, 최대 1MB | ✅ `../shared/icon.svg` 에서 생성 |
| `feature-graphic.png` | 1024×500, **24비트 PNG(알파 없음)** | ✅ `src/feature-graphic.svg` 에서 생성 |
| `screenshots/*.png` | 1080×1920, 폰 기준 최소 2장·최대 8장 | ✅ 5장 — 에뮬레이터에서 촬영 |
| 태블릿 스크린샷 | 16:9 또는 9:16, 최소 4장 | ⬜ 안드로이드 태블릿에 게시할 때만 |
| 미리보기 영상 | YouTube URL | ⬜ 선택 |

산출물 PNG 도 커밋한다. 렌더링 결과는 rsvg 버전과 설치된 폰트에 따라 달라질 수 있어서,
"스토어에 실제로 올린 것이 무엇인지" 가 레포에 남아 있어야 한다.

## 아이콘이 런처 아이콘과 다른 이유

한 파일로 합칠 수 없다. 두 자리의 요구가 정반대다.

|  | 런처 (`assets/android-icon-*.png`) | 스토어 (`icon-512.png`) |
| --- | --- | --- |
| 구성 | 전경 + 배경 + 모노크롬 3장 | 1장 |
| 여백 | **필요하다** — 108dp 캔버스 중 런처가 보여 주는 건 가운데 72dp | **없다** — 잘리지 않는다 |
| 모서리 | 런처가 기기마다 다른 모양으로 마스킹 | Play 가 **30% 반경**으로 깎고 그림자를 얹는다 |

그래서 스토어 아이콘은 **모서리를 미리 둥글게 만들면 안 된다.** 두 번 깎여 안쪽에 투명한 이가
빠진다. `../shared/icon.svg` 가 `docs/icon.svg` 와 달리 `rx` 와 가장자리 하이라이트를 빼고 꽉 찬
정사각형인 이유다. 마크는 15% 안쪽 여백에 들어 있어 30% 모서리 마스크에 걸리지 않는다.

Play 는 2026-03-31 부터 모서리 반경을 30% 로 고정한다.

## 스크린샷 — 기기에서 그대로 올리면 거부된다

Play 는 스크린샷의 **가로세로비를 최대 2:1** 로 제한한다. 요즘 폰은 화면이 그보다 길다
(예: 2640×1080 은 2.44:1). 기기에서 찍은 파일을 그대로 올리면 규격 초과로 막힌다.

```sh
./screenshots.sh capture 01-workspaces   # 지금 폰 화면을 raw/ 로 받는다 (adb)
./screenshots.sh build                   # raw/*.png → screenshots/*.png (1080×1920, 24비트)
```

가장 쉬운 길은 **에뮬레이터를 1080×1920 으로 만들어 두는 것**이다. 그러면 애초에 규격에
맞는 파일이 나와서 `build` 가 재인코딩만 하고 지나간다 — 실기기는 화면비를 고를 수 없다.
설치와 AVD 설정은 [에뮬레이터](#에뮬레이터) 참고.

`build` 는 비율을 유지한 채 1080×1920 안에 넣고 남는 자리를 앱 배경색(`#13161c`)으로 채운다.
잘라내지 않으므로 화면 내용이 사라지지 않는다. 여백이 넓어 보이는 게 싫으면 `raw/` 단계에서
상태바·내비게이션바를 먼저 잘라 두면 된다.

`raw/` 는 커밋하지 않는다(`.gitignore`). 기기마다 해상도가 다르고 용량이 크다.

### 무엇을 찍는가 — 데모 모드로 찍으면 된다

페어링된 랩탑 없이도 앱 전체를 볼 수 있다. 첫 화면의 **"Try the demo"** 를 누르면 샘플
세션이 채워진다(`src/state/demo.ts`). 실제 워크스페이스 이름이나 코드가 노출되지 않으므로
스토어 스크린샷에 그대로 쓸 수 있다.

찍은 화면 5장(대형 화면 추천 노출 조건이 4장 이상이다). 순서는 스토어에 보이는 순서다:

1. **워크스페이스 목록** — 여러 세션이 병렬로 돌고, 기다리는 것이 승인인지 답인지가
   배지로 갈려 보인다
2. **권한 승인** — 이 앱의 존재 이유에 가장 가까운 화면. 트랜스크립트와 Allow/Deny 가 한 화면에 있다
3. **질문 답하기** — 선택지 카드. 승인과 다른 종류의 기다림이라는 걸 보여 준다
4. **PR 상태** — 체크 결과를 폰에서 확인한다
5. **페어링** — 랩탑과 어떻게 이어지는지

데모 데이터가 바뀌면 그림도 바뀐다. 실제로 #384 가 `demo.ts` 에 질문 워크스페이스를 넣고 목록
배지를 `QUESTION`/`PERMISSION` 으로 가르면서 1번이 낡았고, 그래서 다시 찍었다. 앱 UI 나 데모
데이터를 건드렸다면 여기 그림도 같이 봐야 한다.

**심사자가 보는 것도 이 데모 모드다.** Play Console 의 "앱 액세스" 에 데모 모드 진입 방법을
반드시 적어야 한다. 랩탑 페어링이 필요한 앱이라 심사자가 로그인할 방법이 달리 없다.

그리고 심사 뒤에 데모 모드를 OTA 업데이트로 바꾸지 않는다 — 이유는 `apps/mobile/README.md`.

## 문구

피처 그래픽에 들어간 문구는 `src/feature-graphic.svg` 에 있다.

- eyebrow — `COMPANION FOR WOOI ON MAC`. 단독으로 쓰는 앱이 아니라는 걸 먼저 못박는다.
  이걸 빼면 "폰에서 코딩하는 앱" 으로 오해받고, 그 오해는 낮은 별점으로 돌아온다.
- 태그라인 — `Approve, reply, and watch — live.` 앱이 실제로 하는 세 가지다.

Play 는 피처 그래픽을 목록·검색 결과에서 좌우로 잘라 보여 주는 자리가 있고, 미리보기 영상을
등록하면 가운데에 재생 버튼을 얹는다. 그래서 글자는 바깥 10% 와 정가운데를 피해 왼쪽에 모았다.

## 에뮬레이터

iOS 시뮬레이터와 달리 안드로이드 에뮬레이터는 **해상도를 임의로 정할 수 있다.** 스토어
스크린샷에는 이게 결정적이다 — 실기기는 화면이 2:1 보다 길어서 무엇을 찍든 후처리가 필요하지만,
1080×1920 AVD 는 찍는 즉시 규격에 맞는다.

```sh
brew install openjdk@21                        # sdkmanager·avdmanager 가 Java 로 돌아간다
brew install --cask android-commandlinetools

export JAVA_HOME="/opt/homebrew/opt/openjdk@21"
export ANDROID_SDK_ROOT="/opt/homebrew/share/android-commandlinetools"
export ANDROID_HOME="$ANDROID_SDK_ROOT"
export PATH="$JAVA_HOME/bin:$ANDROID_SDK_ROOT/emulator:$PATH"

yes | sdkmanager "emulator" "platform-tools" "system-images;android-36;google_apis;arm64-v8a"
echo no | avdmanager create avd -n wooi-store -k "system-images;android-36;google_apis;arm64-v8a"
```

그다음 `~/.android/avd/wooi-store.avd/config.ini` 에서 이 값들을 고친다:

| 키 | 값 | 왜 |
| --- | --- | --- |
| `hw.lcd.width` / `hw.lcd.height` | `1080` / `1920` | Play 스크린샷 규격(9:16)에 정확히 맞는다 |
| `hw.lcd.density` | `420` | 1080px 가 411dp 가 되어 Pixel 급 폰과 같은 레이아웃이 나온다 |
| `hw.gpu.enabled` | `yes` | 기본값이 소프트웨어 렌더링이라 느리고 실제 기기와 다르게 그려진다 |
| `hw.mainKeys` | `no` | 화면 안에 내비게이션 바가 그려져 실제 폰처럼 보인다 |
| `hw.keyboard` | `yes` | 맥 키보드로 바로 입력한다 |
| `hw.ramSize` | `4096` | React Native 앱에 2G 는 빠듯하다 |

```sh
emulator -avd wooi-store
adb shell wm size   # Physical size: 1080x1920 이어야 한다
```

### 걸리는 곳 세 군데

1. **JDK 가 없으면** `sdkmanager` 가 `Unable to locate a Java Runtime` 으로 죽는다. 그
   위에 찍히는 `line 173: test: : integer expression expected` 는 증상이지 원인이 아니다.
2. **brew 의 `openjdk@21` 은 keg-only** 라서 설치해도 `java` 가 PATH 에 없다. `JAVA_HOME`
   을 직접 잡아야 한다.
3. **`platform-tools` 를 빼면 안 된다.** `adb` 가 이미 brew cask 로 깔려 있어도 마찬가지다 —
   에뮬레이터는 이 디렉터리의 존재를 SDK 루트가 유효한지 판단하는 표식으로 쓴다. 없으면
   `FATAL | Cannot find AVD system path` 로 죽는다. 두 adb 는 같은 버전이라 충돌하지 않는다.

### 앱은 preview 프로파일로 넣는다

```sh
cd ../..    # apps/mobile
EXPO_TOKEN="$(cat ~/.expo-token)" npx eas build --profile preview --platform android
adb install <내려받은>.apk
```

`development` 가 아니라 `preview` 인 이유 — preview 는 `APP_VARIANT=production` 에 APK
산출이라 Metro 없이 단독으로 돌고 개발용 오버레이가 없다. 스토어에 올라갈 화면은 사용자가
실제로 보는 화면이어야 한다.

데모 모드는 카메라·푸시·페어링을 전혀 쓰지 않으므로 에뮬레이터로 충분하다. 다만 **페어링 QR
화면만은 실기기로 찍는 편이 낫다** — 에뮬레이터 카메라는 가짜 장면을 비춘다.
