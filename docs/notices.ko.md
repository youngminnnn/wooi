# 인앱 공지

공지는 타이틀바 바로 아래에 뜨는 한 줄짜리 배너다. 존재 이유는 하나 — 점검 안내, 장애, 잘못
나간 릴리스, 기능 폐기처럼 **이미 설치된 모든 버전에** 앱 업데이트 없이 전해야 하는 말이 있을
때다.

문구는 리포 루트의 [`notice.json`](../notice.json) 에 있다. `main` 에 커밋하는 게 곧 배포다.
설치된 앱은 실행 몇 초 뒤,
`https://raw.githubusercontent.com/youngminnnn/wooi/main/notice.json` 을 가져오고 이후 30분마다
다시 확인한다.

사용자는 ✕ 로 닫을 수 있다. 닫은 기록은 **공지 id 단위로 영구**이며 그 기기에만 남는다.

## 형식

```json
{
  "notices": [
    {
      "id": "2026-08-agent-outage",
      "level": "warn",
      "message": "Anthropic is having an outage — agents may fail to start.",
      "link": { "label": "Status", "url": "https://status.anthropic.com" },
      "startsAt": "2026-08-02T09:00:00Z",
      "endsAt": "2026-08-02T18:00:00Z",
      "minVersion": "1.0.0",
      "maxVersion": "1.2.0"
    }
  ]
}
```

| 필드         | 필수 | 뜻                                                                     |
| ------------ | ---- | ---------------------------------------------------------------------- |
| `id`         | O    | 식별자. **한 번 쓴 id 는 재사용하지 않는다** — 아래 참고.              |
| `message`    | O    | 한 줄 플레인 텍스트. 300자에서 잘린다.                                 |
| `level`      | X    | `info`(기본) · `warn` · `critical`. 배너 색과 아이콘을 고른다.         |
| `link`       | X    | `{ label, url }` 버튼. `http`/`https` 만 허용, 외부 브라우저로 열린다. |
| `startsAt`   | X    | ISO 8601. 이 시각 전에는 안 보인다.                                    |
| `endsAt`     | X    | ISO 8601. 이 시각 후에는 안 보인다.                                    |
| `minVersion` | X    | 이 버전 이상에서만 노출(경계 포함).                                    |
| `maxVersion` | X    | 이 버전 이하에서만 노출(경계 포함) — "업데이트하세요" 안내용.          |

아직 닫지 않은 공지 중 **맨 앞의 한 건만** 띄운다. 즉 배열 순서가 우선순위다. 띄울 게 없으면
`notices` 를 `[]` 로 둔다.

## 쓸 때의 기준

- **id 는 재사용하지 않는다.** 닫음 기록이 id 로 남으므로, 이전 공지를 닫은 사람은 새 내용을
  영영 못 본다. 오타 수정처럼 같은 뜻의 문구 손질은 괜찮지만, 내용이 바뀌면 새 id 를 쓴다.
- **아무것도 할 수 없는 사람 기준으로 쓴다.** 배너는 모든 버전의 모든 사용자를 방해한다. 기본은
  `info` 로 두고, `critical` 은 "지금 작업이 위험하다" 일 때만 쓴다.
- **기간이 있는 공지엔 `endsAt` 을 넣는다.** 지난 배너는 없느니만 못하다 — 기간이 끝나면 알아서
  사라진다.
- **플레인 텍스트만.** 메시지는 마크다운/HTML 이 아니라 텍스트로만 그려진다.

## 커밋 전에 확인해 보기

로컬 파일을 HTTP 로 띄워 앱이 그쪽을 보게 한다:

```sh
python3 -m http.server 8000        # 리포 루트에서
WOOI_NOTICE_URL=http://localhost:8000/notice.json npm run dev
```

실행 5초쯤 뒤에 배너가 뜬다. 한 번 닫은 공지를 다시 보려면 id 를 바꾸거나, 렌더러
localStorage 의 `wooi.noticeDismissed.<id>` 키를 지운다(DevTools → Application).

## 동작

- `src/main/notice.ts` — 가져오기·검증·기간/버전 필터를 하고 `evt:notice` 로 방송한다. main 에서
  받아오는 이유는 프로덕션 렌더러 CSP 가 `connect-src 'self'` 라 렌더러의 원격 fetch 가 막혀
  있기 때문이다. 형식이 깨진 항목은 그 항목만 버려서, 잘못 쓴 공지가 앱을 망가뜨리지 않는다.
- `src/renderer/src/components/NoticeBanner.tsx` — 배너를 그리고 닫음 기록을 `lib/uiFlags.ts` 에
  남긴다.
