# metrics

Wooi 의 채택 규모를 추정하기 위한 스냅샷 보관소.

Wooi 는 자체 서버도 애널리틱스도 없다([PRIVACY.md](../PRIVACY.md)). 사용자를 추적하지
않는 대신, GitHub 이 저장소에 대해 이미 집계해 주는 공개 지표(릴리스 자산
다운로드 수, traffic, 스타)만 주기적으로 찍어 둔다. **앱에서 나가는 데이터는 없고,
개인을 식별하는 값도 없다.**

## adoption.jsonl

한 줄 = 한 스냅샷인 append-only JSONL. 로컬이 아니라 저장소에 커밋한다:

- **GitHub 은 traffic(views/clones/referrers)을 14일치만 보관한다.** 안 찍으면 영구 소실이라
  기록 자체가 이 파일의 존재 이유고, 한 대의 노트북에만 두면 그 노트북과 함께 사라진다.
- Actions 로 자동 수집하려면 러너가 결과를 되돌려 놓을 곳이 필요하다.
  아티팩트는 만료되지만 커밋은 남는다.
- append-only 라 diff 가 항상 "+1 줄"이다. 기존 줄은 절대 고치지 않는다.

## 사용법

```sh
npm run metrics                                # 수집 → 요약 출력 → 한 줄 append
node scripts/adoption-snapshot.mjs --dry-run   # 파일에 쓰지 않고 요약만
node scripts/adoption-snapshot.mjs --help      # 전체 옵션
```

`gh` CLI 가 설치·인증되어 있어야 하고, traffic 수집에는 저장소 push 권한이 있는 토큰이
필요하다. 자동 수집은 [`.github/workflows/metrics.yml`](../.github/workflows/metrics.yml)
이 주 1회 돌린다(별도 `METRICS_TOKEN` 시크릿 필요 — 워크플로 주석 참고).

## 숫자를 읽기 전에

`latest-mac.yml` 다운로드 수는 **사용자 수가 아니라 업데이트 체크 횟수**다. 상시 사용자
1명이 하루 12회 이상 찍는다. 이 함정을 포함한 해석 규칙 전체는
[`scripts/adoption-snapshot.mjs`](../scripts/adoption-snapshot.mjs) 상단 주석에 있다.
숫자를 인용하기 전에 반드시 읽을 것.
