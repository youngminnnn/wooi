# Play Console 에 붙여 넣을 문구

Play Console 의 **스토어 등록정보**와 **앱 콘텐츠** 폼에 그대로 넣는 값이다. 여기에 두는 이유는
자산과 같다 — 콘솔 폼에만 있으면 무엇을 왜 그렇게 적었는지 다음 사람이 알 수 없다.

문구를 고쳤으면 콘솔에도 반영하고, 콘솔에서 고쳤으면 여기도 고친다.

---

## 앱 이름 (30자)

```
Wooi
```

## 짧은 설명 (80자)

목록과 검색 결과에서 이름 밑에 붙는 한 줄이다. 잘리면 안 되므로 80자를 넘기지 않는다.

```
Approve, reply, and watch your Mac's coding agents — live, from your phone.
```

## 자세한 설명 (4000자)

첫 세 줄이 접히기 전에 보인다. 그래서 **맥이 필요하다는 사실을 맨 앞에 둔다** — 이걸 뒤에
숨기면 "폰에서 코딩하는 앱" 으로 오해받고, 그 오해는 환불이 아니라 낮은 별점으로 돌아온다.

```
Wooi Remote is the companion app for Wooi, a macOS app that runs multiple AI coding
agents in parallel. You need a Mac running Wooi to use this app — pair the two once,
and your sessions come with you.

Agents stop and wait. They wait for permission to run a command, they wait for an
answer to a question, and they wait for you to read what they found. Until now that
meant staying at your desk. Now the waiting comes to your phone.

WHAT YOU CAN DO

• Approve or deny — see the exact command an agent wants to run, with the rule it
  would create, and decide from the lock screen
• Answer questions — agents that ask before choosing get their answer as a tap
• Follow along — read the transcript as it streams: thinking, tool calls, results
• Reply — send a follow-up message without opening your laptop
• Check pull requests — CI status for every workspace, at a glance
• Watch your quota — Claude Code and Codex plan usage, so a rate limit is not a
  surprise
• Stay oriented — which sessions are running, which are done, which need you

BUILT FOR WORK YOU CARE ABOUT

Everything with substance is end-to-end encrypted between your Mac and your phone.
The relay in between moves ciphertext and cannot read your sessions, your code, or
your prompts. Pairing is a one-time QR scan, confirmed by six digits that must match
on both screens — so a stranger who photographs your screen still gets nothing.

Your agents keep running on your Mac. The phone is a control surface, not a second
brain: nothing is executed on the phone, and nothing is copied to a cloud you do not
own. Remote access is off until you turn it on, and one tap on your Mac revokes a
phone immediately.

No ads. No trackers. No analytics. Free.

TRY IT WITHOUT A MAC

Not sure yet? Tap "Try the demo" on the first screen. Sample sessions fill the app so
you can see what it feels like — no pairing, no account, nothing sent anywhere.

REQUIREMENTS

• A Mac running Wooi (free, open source — github.com/youngminnnn/wooi)
• Claude Code or OpenAI Codex set up on that Mac
• The two devices do not need to be on the same network
```

## 앱 아이콘 · 그래픽

`icon-512.png`, `feature-graphic.png`, `screenshots/*.png` — 만드는 법은 [README](./README.md).

## 분류

| 항목 | 값 |
| --- | --- |
| 앱 또는 게임 | 앱 |
| 카테고리 | 도구 (Tools) |
| 태그 | 개발자 도구 |
| 이메일 | 개발자 연락처 이메일 |
| 웹사이트 | https://youngminnnn.github.io/wooi/ |

---

# 앱 콘텐츠 선언

## 앱 액세스 — ⭐ 이걸 빠뜨리면 반려된다

이 앱은 맥의 Wooi 와 QR 페어링을 해야 내용이 보인다. 심사자에게는 맥이 없으므로,
**데모 모드로 들어가는 방법을 반드시 적어야 한다.** 계정을 만들어 줄 방법이 없다.

"앱의 일부 또는 전체 기능이 제한됨" 을 고르고 다음을 넣는다.

```
Name: Demo mode (no account or pairing required)

Instructions:
This app is a companion for Wooi, a macOS desktop app. Normal use requires pairing
with a Mac by scanning a QR code, so there are no credentials we can provide.

Instead, the app ships with a full demo mode that needs no account, no pairing and
no network:

1. Launch the app.
2. On the first screen ("Pair this phone"), scroll to the bottom.
3. Tap "Try the demo".

Sample sessions load immediately and every screen is reachable — workspace list,
transcripts, permission approval, question answering, pull request status and
settings. Camera permission is not required for the demo.
```

## 광고

없음. **앱에 광고가 표시되지 않습니다.**

## 콘텐츠 등급 (IARC 설문)

개발자 도구다. 폭력·성적 콘텐츠·도박·약물 전부 없음. 사용자 간 상호작용 없음(폰과 내 맥
사이의 1:1 채널이고 다른 사용자와 이어지지 않는다). 위치 공유 없음. 전체이용가로 나온다.

## 타겟층 및 콘텐츠

**18세 이상.** 개발자 도구이고 아동을 대상으로 하지 않는다 — 이렇게 답해야 Families 정책이
붙지 않는다.

## 뉴스 앱 / 정부 앱 / 금융 상품 / 건강

전부 **아니오.**

## 광고 ID

**사용하지 않는다.** 빌드된 APK 의 병합 매니페스트에
`com.google.android.gms.permission.AD_ID` 가 없음을 확인했다:

```sh
aapt2 dump permissions wooi.apk | grep -i AD_ID   # 결과 없음
```

이 답이 실제와 어긋나면 앱이 내려갈 수 있으므로, 광고·분석 SDK 를 더할 때 반드시 다시 확인한다.

## 앱이 요구하는 권한

스토어 등록정보는 앱이 **선언한** 권한을 그대로 나열한다. 병합된 매니페스트를 확인한 결과가
이것이고, 전부 실제로 쓰는 것만 남아 있다:

| 권한 | 왜 필요한가 |
| --- | --- |
| `CAMERA` | 페어링 QR 스캔 (`app/pair.tsx`) |
| `INTERNET` · `ACCESS_NETWORK_STATE` | 릴레이 연결 |
| `POST_NOTIFICATIONS` | 승인·질문·완료 알림 |
| `USE_BIOMETRIC` · `USE_FINGERPRINT` | 앱 잠금 (`expo-local-authentication`) |
| `VIBRATE` · `WAKE_LOCK` · `RECEIVE_BOOT_COMPLETED` · `READ_APP_BADGE` | 알림 전달과 배지 |

쓰지도 않는 권한 네 개(`RECORD_AUDIO`, `READ/WRITE_EXTERNAL_STORAGE`,
`SYSTEM_ALERT_WINDOW`)는 `app.json` 의 `blockedPermissions` 로 막았다. 라이브러리 매니페스트에서
딸려 오던 것들이고, 왜 그것만으로는 안 되는지는 [`apps/mobile/README.md`](../../README.md).

민감 권한(위치·SMS·통화기록·전체 파일 접근)이 없으므로 **권한 선언 양식은 제출할 것이 없다.**

## 데이터 보안

근거는 [`PRIVACY.md`](../../../../PRIVACY.md) 다. 그 문서가 단일 소스이고, 여기 표는 그것을
Play 의 칸에 옮긴 것이다.

### 수집하는 데이터

| Play 의 분류 | 무엇 | 공유 | 목적 | 필수 | 전송 중 암호화 | 삭제 요청 |
| --- | --- | --- | --- | --- | --- | --- |
| 기기 또는 기타 ID | 기기 UUID, 익명 계정 ID, 푸시 토큰 | 아니오 | 앱 기능 | 필수 | 예 | 예 |
| 앱 정보 및 성능 → 기타 | 기기 이름·플랫폼(`SM-F741N` / `android`) | 아니오 | 앱 기능 | 필수 | 예 | 예 |

**푸시 토큰**은 Expo 푸시 서비스와 FCM 을 거친다. 서드파티 SDK 도 앱의 수집으로 치므로
반드시 반영한다.

**알림 배너 텍스트에는 워크스페이스 이름이 평문으로 실린다**(`PRIVACY.md` 의 Notifications).
이건 저장되지 않고 전달만 되지만, 데이터 보안 폼에서 "앱 활동" 으로 볼 여지가 있다. 보수적으로
가려면 이 항목도 함께 신고한다.

### 수집하지 않는 데이터

코드, 프롬프트, 트랜스크립트, 파일 내용은 **릴레이가 읽을 수 없다** — 종단간 암호화되어
암호문으로만 지나간다. 위치·연락처·사진·통화 기록·건강 데이터는 일절 없다.

### 전송 중 암호화

**예.** HTTPS 위에 앱 자체의 종단간 암호화가 한 겹 더 있다.

### 삭제 요청

**예.** 설정 → "Unpair this phone" 이 이 폰의 접근과 릴레이의 기기 행을 없앤다.

> ⚠️ **판단이 필요한 곳** — Play 는 "앱에서 계정을 만들 수 있으면 웹 삭제 요청 URL 이
> 필수" 라고 본다. Wooi 는 사용자가 계정을 만들지 않지만 페어링 과정에서 Supabase 익명
> 인증으로 기기 행이 생긴다. 회색지대다. 안전하게 가려면 `PRIVACY.md` 에 "데이터 삭제 요청"
> 절을 만들고 그 URL 을 제출한다.

## 개인정보처리방침 URL

```
https://youngminnnn.github.io/wooi/privacy.html
```

이 페이지는 `PRIVACY.md` 에서 만들어진다(`node scripts/build-privacy-page.mjs`). 방침을
고쳤으면 마크다운만 고치고 페이지를 다시 만든다 — 개인정보처리방침이 두 벌 존재하면 어느 쪽이
진짜인지 다투게 된다.

---

# 출시 전 마지막 점검

- [ ] 데모 모드 진입 방법이 "앱 액세스" 에 적혀 있는가 — 없으면 심사자가 아무것도 못 본다
- [ ] 광고 ID 답이 병합 매니페스트와 일치하는가
- [ ] 개인정보처리방침 URL 이 공개로 열리는가
- [ ] 스크린샷이 배포될 빌드와 같은 화면인가 — 데모 데이터가 바뀌면 다시 찍는다
- [ ] 심사 뒤 데모 모드를 OTA 로 바꾸지 않는다 (`apps/mobile/README.md`)
