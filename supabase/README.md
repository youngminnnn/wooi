# 릴레이 환경 (개발 / 운영)

원격 접근이 쓰는 Supabase 프로젝트는 **둘**이고, 절대 섞이지 않는다.

| | 프로젝트 | ref | 쓰는 곳 |
| --- | --- | --- | --- |
| 개발 | `wooi-development` | `vicgdpqmaazavjezxkxx` | `npm run dev`, 프로브, 실험 |
| 운영 | `wooi-production` | `hdaumqthnvplmbbytwrf` | 릴리즈 빌드 |

둘 다 조직 `wooi` (ap-northeast-2) 소속이다. 무료 티어는 **조직당 활성 프로젝트 2개**이므로
이걸로 슬롯을 다 쓴다. 무료 프로젝트는 **1주일 미사용 시 일시정지**되니, 실제 사용자가 붙는
시점에는 운영 프로젝트를 Pro 로 올려야 한다.

## 어느 쪽에 붙는지 누가 정하는가

**데스크톱만 정한다.** 폰은 릴레이 주소와 anon 키를 페어링 QR 에서 배우므로
(`src/main/remote/pairing.ts`), 개발 랩탑이 띄운 QR 은 개발 릴레이를, 배포본이 띄운 QR 은
운영 릴레이를 실어 나른다. 모바일 앱에는 릴레이 환경이라는 개념 자체가 없다.

데스크톱의 값은 `electron.vite.config.ts` 가 **빌드 시점에** 구워 넣는다:

```
npm run dev    → WOOI_RELAY_DEV_*    (.env.local)
npm run build  → WOOI_RELAY_PROD_*   (CI 시크릿)
```

두 경로가 **다른 변수 이름**을 읽는 것이 안전장치다. 이름이 같았다면 내 셸에 떠 있는 개발용
값이 릴리즈 빌드에 조용히 섞일 수 있다. 지금은 그 사고가 문법적으로 불가능하다.

실행 시점에 `WOOI_SUPABASE_URL`/`WOOI_SUPABASE_ANON_KEY` 를 주면 구워 넣은 값을 덮어쓴다 —
로컬 `supabase start` 스택을 겨냥할 때 쓴다.

## 배포

`supabase link` 의 상태에 기대지 않는다. `scripts/relay.mjs` 가 매번 접속 문자열을 만들어
명시하므로, 링크가 어디를 가리키고 있든 명령이 겨냥하는 프로젝트가 실행 첫 줄에 찍힌다.

```sh
npm run relay:dev:status      npm run relay:prod:status      # 마이그레이션 적용 현황
npm run relay:dev:migrate     npm run relay:prod:migrate     # 마이그레이션 push
npm run relay:dev:functions   npm run relay:prod:functions   # Edge Function 배포
npm run relay:dev:config      npm run relay:prod:config      # [auth] 등 설정 반영
```

이게 스크립트인 이유는 CLI 가 명령마다 프로젝트를 지정하는 방법이 다르기 때문이다 —
`db push` 와 `migration list` 는 `--project-ref` 를 **받지 않고** `--db-url` 만 받는다.
플래그를 빼면 CLI 는 링크된 프로젝트로 조용히 떨어진다. 운영을 겨냥한 줄 알았던 명령이
개발 프로젝트를 보고 "다 적용됨"이라 답하는 사고가 실제로 났다.
`SUPABASE_DB_URL` 환경변수도 무시된다 — 반드시 플래그여야 한다.

접속은 풀러의 5432(세션 모드)를 쓴다. 직접 접속(`db.<ref>.supabase.co`)은 무료 티어에서
IPv6 전용이라 닿지 않고, 풀러의 6543(트랜잭션 모드)에서는 마이그레이션이 돌지 않는다.
풀러 호스트는 **프로젝트마다 다르다** — 같은 리전인데 dev 는 `aws-1`, prod 는 `aws-0` 이다.

DB 비밀번호는 macOS 키체인에서 읽는다:

```sh
security find-generic-password -a wooi -s wooi-supabase-production-db -w
security add-generic-password -U -a wooi -s wooi-supabase-development-db -w   # 없으면 등록
```

## 새 프로젝트를 세울 때

0. **Realtime 을 한 번 깨운다.** 갓 만든 프로젝트에는 `realtime.messages` 가 **없다** —
   Realtime 테넌트는 첫 연결 때 지연 초기화되면서 자기 테이블을 만든다. 그 전에 마이그레이션을
   돌리면 0001 이 `realtime.messages` 에 정책을 걸다가 `relation ... does not exist` 로 죽는다
   (트랜잭션이라 부분 적용은 남지 않는다). anon 키로 아무 채널이나 한 번 구독했다 끊으면 된다:

   ```js
   const client = createClient(url, anonKey)
   const channel = client.channel('bootstrap')
   channel.subscribe(() => client.removeChannel(channel))
   ```

1. `npm run relay:<env>:migrate` — 마이그레이션 전부
2. `npm run relay:<env>:functions` — `pair`, `push`
3. `npm run relay:<env>:config` — `[auth]` 설정(익명 로그인 포함) 반영

## RLS 회귀 테스트

`tests/rls.sql` 은 **로컬 스택 전용**이다. 클라우드 프로젝트에 대고 실행하지 말 것 —
행을 심고 지운다.
