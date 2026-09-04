# App Store Connect 에 붙여 넣을 문구

App Store Connect 의 **앱 정보 · 버전 정보 · 앱 개인정보 보호 · 심사 정보** 폼에 그대로 넣는
값이다. 여기에 두는 이유는 Play 쪽([`../android/listing.md`](../android/listing.md))과 같다 —
콘솔 폼에만 있으면 무엇을 왜 그렇게 적었는지 다음 사람이 알 수 없다.

두 스토어는 **같은 앱을 설명하되 폼이 다르다.** Play 에 없는 칸이 여기 셋 있고(부제·프로모션
텍스트·키워드), 반대로 Play 의 피처 그래픽은 여기 없다. 그래서 한쪽에서 문구를 복사해 오는 것
만으로는 칸이 채워지지 않는다.

문구를 고쳤으면 콘솔에도 반영하고, 콘솔에서 고쳤으면 여기도 고친다.

---

## 앱 이름 (30자)

```
Wooi
```

## 부제 (30자)

목록·검색 결과에서 이름 바로 밑에 붙는다. Play 의 "짧은 설명" 과 자리는 같지만 **80자가 아니라
30자**라 같은 문장을 줄여 쓸 수 없고, 처음부터 다시 써야 한다.

```
Approve your Mac's AI agents
```

맥이 필요하다는 사실은 30자 안에 들어가지 않는다. 그래서 부제는 동사로 시작해 **무엇을 하는
앱인지**만 말하고, "맥이 있어야 한다" 는 설명의 첫 문장이 맡는다 — 접히기 전에 보이는 자리다.

## 프로모션 텍스트 (170자)

**새 빌드 없이 언제든 바꿀 수 있는 유일한 문구다.** 설명 위에 붙고 심사를 다시 받지 않는다.
그래서 버전마다 달라지는 말은 설명이 아니라 여기에 쓴다 — 설명에 넣으면 문장 하나를 고치려고
빌드를 올려야 한다.

```
Your Mac keeps running the agents. Your phone gets the interruptions — approvals, questions, and the moment something finishes. Pair once with a QR code.
```

## 설명 (4000자)

첫 세 줄이 접히기 전에 보인다. 그래서 Play 와 똑같이 **맥이 필요하다는 사실을 맨 앞에 둔다** —
이걸 뒤에 숨기면 "폰에서 코딩하는 앱" 으로 오해받고, 그 오해는 환불이 아니라 낮은 별점으로
돌아온다.

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

No ads. No trackers. No analytics.

TRY IT WITHOUT A MAC

Not sure yet? Tap "Try the demo" on the first screen. Sample sessions fill the app so
you can see what it feels like — no pairing, no account, nothing sent anywhere.

REQUIREMENTS

• A Mac running Wooi (open source — github.com/youngminnnn/wooi)
• Claude Code or OpenAI Codex set up on that Mac
• The two devices do not need to be on the same network
```

Play 쪽 설명과 딱 한 군데가 다르다 — **"Free." 를 뺐다.** Apple 은 메타데이터에 가격을 적는 것을
금한다(심사 지침 2.3.7). 가격은 스토어가 이미 보여 주고 있고, 무료 앱이 설명에 "Free" 를 적어
두면 언젠가 유료화했을 때 문구가 거짓말이 된다. Play 에는 이 제한이 없어서 그대로 뒀다.

## 키워드 (100자)

쉼표로 나누고 **공백은 넣지 않는다** — 공백도 100자에 든다. 앱 이름과 부제에 있는 낱말은 검색에
자동으로 포함되므로 여기서는 뺀다(`wooi`, `approve`, `mac`, `agents`).

```
claude,codex,cli,terminal,developer,coding,remote,companion,pair,notification,worktree,git
```

## URL · 저작권

| 항목 | 값 |
| --- | --- |
| 지원 URL (필수) | `https://github.com/youngminnnn/wooi/issues` |
| 마케팅 URL (선택) | `https://youngminnnn.github.io/wooi/` |
| 개인정보처리방침 URL (필수) | `https://youngminnnn.github.io/wooi/privacy.html` |
| 저작권 | `2026 youngminnnn` |

지원 URL 은 **사람이 답을 받을 수 있는 곳**이어야 한다. 랜딩 페이지만 넣으면 심사에서 지적받을
수 있어 이슈 트래커를 쓴다.

## 분류

| 항목 | 값 |
| --- | --- |
| 기본 카테고리 | 개발자 도구 (Developer Tools) |
| 보조 카테고리 | 생산성 (Productivity) |
| 가격 | 무료 |
| 배포 국가 | 전 세계 |

## 앱 아이콘 · 스크린샷

`icon-1024.png`, `screenshots/iphone-6.9/*.png`, `screenshots/ipad-13/*.png` — 만드는 법은
[README](./README.md). `supportsTablet` 이 `true` 라 **iPad 스크린샷이 없으면 제출 버튼 자체가
열리지 않는다.**

---

# 앱 심사 정보

## 로그인 정보 — ⭐ 이걸 빠뜨리면 반려된다

Play 의 "앱 액세스" 와 같은 자리다. 이 앱은 맥의 Wooi 와 QR 페어링을 해야 내용이 보이는데
심사자에게는 맥이 없으므로, **데모 모드로 들어가는 방법을 반드시 적어야 한다.** 계정을 만들어
줄 방법이 없다.

"로그인 필요" 는 **아니오**로 두고(계정 개념이 없다), 아래를 "메모" 에 넣는다.

```
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

The Mac app is free and open source: https://github.com/youngminnnn/wooi
```

그리고 심사가 끝난 뒤에 데모 모드를 OTA 업데이트로 바꾸지 않는다 — 이유는
[`apps/mobile/README.md`](../../README.md).

## 수출 규정 — 매 업로드마다 답해야 한다

**`ITSAppUsesNonExemptEncryption` 을 `Info.plist` 에 일부러 넣지 않았다.** 그래서 업로드할
때마다 App Store Connect 에서 문답에 답해야 빌드가 TestFlight 와 심사에 나타난다.

답과 그 근거(알고리즘·키 길이, 왜 면제가 아닌지, 왜 plist 에 넣지 않는지)는
[`apps/mobile/README.md`](../../README.md) 의 "수출 규정" 절에 표로 있다. **그 표가 단일
소스다** — 여기 옮겨 적으면 두 벌이 되고, 한쪽만 고쳐졌을 때 어느 쪽이 맞는지 다투게 된다.

이걸 놓치면 `eas submit` 은 성공했다고 말한 뒤 몇 분 있다가 메일로 거부가 온다. 0.3.0 의
build 2 가 실제로 그렇게 날아갔다.

## 콘텐츠 권리

서드파티 콘텐츠 없음. 앱이 보여 주는 것은 전부 사용자 자신의 맥에서 온다.

## 연령 등급

폭력·성적 콘텐츠·도박·약물·공포 전부 **없음**. 웹 브라우저가 없으므로 "제한 없는 웹 접근" 도
아니고, 사용자 간 상호작용이 없다(폰과 내 맥 사이의 1:1 채널이고 다른 사용자와 이어지지 않는다).
전부 "없음" 으로 답하면 **4+** 가 나온다.

Play 에서 "타겟층 18세 이상" 을 고른 것과 어긋나 보이지만 다른 축이다 — Play 의 그 답은
Families 정책이 붙지 않게 하는 **대상 연령**이고, Apple 의 4+ 는 **콘텐츠 수위**다.

---

# 앱 개인정보 보호 (nutrition labels)

근거는 [`PRIVACY.md`](../../../../PRIVACY.md) 다. 그 문서가 단일 소스이고, 여기 표는 그것을
Apple 의 칸에 옮긴 것이다. Play 의 데이터 보안 폼과 **같은 사실을 다른 분류로** 적는 것이라
한쪽만 고치면 두 스토어의 답이 갈린다.

## 수집하는 데이터

| Apple 의 분류 | 무엇 | 추적에 사용 | 신원에 연결 | 목적 |
| --- | --- | --- | --- | --- |
| 식별자 → 사용자 ID | Supabase 익명 계정 ID | 아니오 | **아니오** | 앱 기능 |
| 식별자 → 기기 ID | 기기 UUID, 푸시 토큰 | 아니오 | **아니오** | 앱 기능 |
| 기타 데이터 | 폰의 이름·플랫폼 (`SM-F741N` / `android`) | 아니오 | **아니오** | 앱 기능 |
| 사용자 콘텐츠 → 기타 | 알림 배너에 실리는 워크스페이스 이름 | 아니오 | **아니오** | 앱 기능 |

**"신원에 연결" 이 전부 아니오인 이유** — 계정을 만들지 않으므로 이름도 이메일도 전화번호도
없다. 릴레이에 있는 것은 앱이 기기에서 만든 UUID 뿐이고, 그 UUID 를 사람에게 이어 붙일 재료가
어디에도 없다.

**"추적에 사용" 이 전부 아니오인 이유** — 광고도 분석 SDK 도 없고 데이터 브로커에 넘기지
않는다. 그래서 "사용자를 추적하는 데 사용되는 데이터" 는 **없음**이고, **ATT 권한 요청도 하지
않는다.**

## 워크스페이스 이름을 신고하는 이유 — 판단이 필요한 곳

Apple 이 말하는 "수집" 은 Play 보다 좁다. **실시간 요청을 처리하는 데 필요한 시간보다 오래**
접근할 수 있게 기기 밖으로 내보내는 것이 수집이고, 알림 배너는 전달되고 나면 릴레이에 남지
않는다(`PRIVACY.md` 의 Notifications). 그 정의만 보면 신고하지 않아도 된다.

그래도 신고한다. 배너 텍스트는 Expo 푸시 서비스와 APNs 를 지나가면서 평문으로 읽히고, 무엇보다
**Play 쪽에서 이미 같은 항목을 신고하기로 했다.** 두 스토어에 서로 다른 답을 적어 두면 어느 쪽이
진짜인지 설명해야 하는 날이 온다. 덜 신고해서 앱이 내려가는 것과 더 신고해서 라벨이 한 줄
길어지는 것은 값이 다르다.

## 수집하지 않는 데이터

코드, 프롬프트, 트랜스크립트, 파일 내용은 **릴레이가 읽을 수 없다** — 종단간 암호화되어
암호문으로만 지나간다. 위치·연락처·사진·건강·금융·검색 기록·진단 데이터는 일절 없다.

## 계정 삭제 (심사 지침 5.1.1(v))

Apple 은 **앱에서 계정을 만들 수 있으면 앱 안에 계정 삭제 경로**를 요구한다. Wooi 는 사용자가
계정을 만들지 않지만 페어링 과정에서 Supabase 익명 인증으로 기기 행이 생긴다 — Play 쪽과 똑같은
회색지대다.

앱 안의 경로는 이미 있다: 폰에서 설정 → **Unpair this phone**, 맥에서 설정 → Remote →
**Delete all remote data**. 웹 경로는 `PRIVACY.md` 의
[Data deletion requests](https://youngminnnn.github.io/wooi/privacy.html#data-deletion-requests)
절이고, **두 스토어에 같은 URL 을 낸다.**

---

# 출시 전 마지막 점검

- [ ] 데모 모드 진입 방법이 "앱 심사 정보 ▸ 메모" 에 적혀 있는가 — 없으면 심사자가 아무것도 못 본다
- [ ] 이번 업로드의 수출 규정 문답에 답했는가 — 답하기 전에는 TestFlight 에 빌드가 나타나지 않는다
- [ ] iPad 스크린샷이 올라가 있는가 — `supportsTablet` 이 `true` 인 한 필수다
- [ ] 개인정보처리방침 URL 이 공개로 열리는가
- [ ] 스크린샷이 배포될 빌드와 같은 화면인가 — 데모 데이터나 대화 화면이 바뀌면 다시 찍는다
- [ ] 앱 개인정보 보호 답이 Play 데이터 보안 답과 같은 사실을 말하는가
- [ ] 심사 뒤 데모 모드를 OTA 로 바꾸지 않는다 ([`apps/mobile/README.md`](../../README.md))
