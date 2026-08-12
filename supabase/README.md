# Supabase — Wooi Remote 릴레이

이 디렉토리가 Wooi Remote 의 백엔드 전부다. 여기서 하는 일은 **암호문 중계**뿐이고,
서버는 워크스페이스 이름도 프롬프트도 볼 수 없다.

## Supabase 중 실제로 쓰는 것

| 기능 | 용도 |
|---|---|
| **Postgres + RLS** | `machines` / `devices` / `commands` / `machine_state` 등. RLS 가 "누가 어떤 행을 보는가"의 유일한 규칙 |
| **Anonymous Auth** | 랩탑도 폰도 익명 사용자로 로그인. 그 `auth.uid()` 가 소유권의 정의 |
| **Realtime Broadcast** | `machine:<uuid>` 토픽. 커맨드 도착 "깨우기 핑"과 이벤트 스트림 |
| **Edge Functions** | 페어링 3종(`pair-begin`/`pair-claim`/`pair-finish`)과 `push`. service role 로 돌아 `pairings` 에 접근 |

쓰지 않는 것: Storage, Auth 의 이메일/OAuth 로그인, Postgres Changes(구독마다 RLS 재평가라
확장이 나쁘고 컬럼 메타데이터가 샌다), Vector, Cron 이외의 확장.

## 키 두 개 — 이것만 헷갈리지 않으면 된다

| 키 | 성격 | 어디에 두나 |
|---|---|---|
| `anon` (publishable) | **공개해도 되는 키.** "익명 방문자 자격으로 붙는다"는 뜻일 뿐, 그 자체로 데이터 접근권이 없다. 실제 접근은 전부 RLS 가 판정한다 | 모바일 바이너리, Electron 앱, QR 코드에 그대로 내장 |
| `service_role` (secret) | **RLS 를 완전히 우회한다.** 이 키를 가진 쪽은 모든 행을 읽고 지운다 | Edge Function 의 환경변수에만. 클라이언트·레포·QR 어디에도 절대 금지 |

RLS 없이 anon 키만 있는 테이블은 곧 공개 테이블이다. 그래서 이 스키마의 6개 테이블은
전부 `enable row level security` 이고, 새 테이블을 추가할 때도 예외 없이 켜야 한다.

## RLS 와 GRANT 는 다른 관문이다 (실제로 물렸던 곳)

Supabase 의 기본 권한은 public 스키마 새 테이블에 대해 `anon`/`authenticated` 에게
`TRUNCATE/REFERENCES/TRIGGER` 만 준다 — `select`/`insert` 는 **주지 않는다**.
정책만 쓰고 GRANT 를 빠뜨리면 모든 호출이 `permission denied for table` 로 죽는다.

- **GRANT** = 이 롤이 그 동사를 쓸 수 있는가
- **RLS** = 그 동사로 어떤 행에 닿을 수 있는가

정책이 부르는 함수(`owns_machine`/`is_paired`)에도 `grant execute` 가 필요하다 —
정책 식은 `security definer` 함수라도 **호출자 롤로** 평가된다.

`pairings` 는 정책도 GRANT 도 없다. 이중 잠금이며, 그래서 Edge Function 전용이다.

### 기본값을 믿지 않는다 (0003 / 0004 가 하는 일)

기본 권한은 **프로젝트가 언제 만들어졌느냐에 따라 다르다.** 실측한 차이:

| | 로컬 CLI 이미지 | 클라우드 프로젝트(같은 날 생성) |
|---|---|---|
| public 새 테이블 | anon/authenticated 에 `Dxtm` 만 | anon/authenticated 에 **`GRANT ALL`** |

그래서 0003 은 **전부 회수한 뒤 필요한 것만 다시 준다.** 그래야 스키마가
"무엇을 더 얹었는가"가 아니라 "무엇이 있는가"를 스스로 선언하게 된다.
`alter default privileges` 로 앞으로 만들 객체의 기본값(테이블·함수·시퀀스)도 같이 고정한다.

### 함수는 기본이 PUBLIC EXECUTE 다 — 가장 위험했던 구멍

PostgreSQL 함수의 기본 권한은 **PUBLIC 에게 EXECUTE** 이고, PostgREST 는 `public` 스키마 함수를
`POST /rest/v1/rpc/<name>` 으로 노출한다. 즉 **로그인조차 하지 않은 anon 키 소지자 누구나**
우리 `security definer` 함수를 호출할 수 있었다 — `cleanup_relay()` 는 postgres 권한으로
`commands`·`push_events`·`machines`·`auth.users` 를 지운다.

0003 이 회수했다. 남긴 것은 RLS 정책이 실제로 부르는 `owns_machine`/`is_paired` 둘뿐이다.
트리거 함수는 EXECUTE 가 **트리거 생성 시점에만** 검사되므로 회수해도 계속 동작하고,
`cleanup_relay` 는 소유자(postgres)로 도는 pg_cron 이 부르므로 GRANT 가 필요 없다.

### 새 객체를 추가할 때의 규칙

1. 테이블이면 **반드시** `enable row level security` — `authenticated` 는 곧 전 세계다
2. 필요한 동사만 `grant` (기본값에 기대지 않는다)
3. 함수면 `revoke all ... from public` 후 정말 호출해야 하는 롤에만 `grant execute`
4. `tests/rls.sql` 과 `tests/abuse.sql` 에 케이스를 추가한다

## 익명 로그인 (Anonymous sign-ins)

`signInAnonymously()` 는 `auth.users` 에 **진짜 행**을 만들고 `role: authenticated` +
`is_anonymous: true` 인 JWT 와 refresh token 을 준다. 이메일도 비밀번호도 없는, 기기에 저장된
refresh token 이 전부인 영구 신원이다.

**왜 필요한가.** 이 스키마의 격리는 전부 `auth.uid()` 위에 서 있다
(`machines.owner_uid = auth.uid()`, `devices.user_uid = auth.uid()`). 로그인이 없으면 롤은 `anon`
이고 우리는 `anon` 에 아무 권한도 주지 않았으므로 전면 거부다. 그렇다고 사용자에게 Wooi 계정을
만들라고 할 이유는 없다 — 실제 신원 확인은 페어링(QR + SAS)이 하고, 익명 세션은 "이 기기"를
가리키는 핸들일 뿐이다.

**켠다고 RLS 가 약해지지는 않는다.** 익명 JWT 도 프로젝트 JWT 시크릿으로 서명되므로 `auth.uid()`
는 위조할 수 없고, 익명 사용자가 남의 uid 를 주장할 방법은 없다(`tests/rls.sql` 이 실증한다).

**대신 두 가지가 열린다:**

1. **가입 엔드포인트가 공개된다.** anon 키는 앱에 내장되므로 누구나 익명 사용자를 만들 수 있다.
   위험은 기밀성이 아니라 **비용**(저장량 + MAU)이다. 방어는 두 층이다:
   - Supabase 쪽: IP 당 시간당 30회 익명 가입 제한(기본), Turnstile/hCaptcha(권장, 대시보드 설정)
   - 스키마 쪽: 계정당 머신 10개, 머신당 기기 10개, 커맨드 30/분·300/시간,
     페이로드 64KB, `push_events` 는 클라이언트 쓰기 금지 — `tests/abuse.sql` 이 상한을 실측한다
2. **`authenticated` 롤에 준 권한은 전 세계에 준 것과 같다.** 그러므로 **`public` 스키마에
   추가하는 모든 테이블은 예외 없이 RLS 를 켜야 한다.** 안 켜면 그 테이블은 공개 테이블이다.

**정리가 필요하다.** Supabase 는 오래된 익명 계정을 자동으로 지우지 않는다.
`cleanup_relay()` 가 머신·기기가 없는 30일 이상 된 익명 계정을 지운다.

## 로컬 스택

```bash
supabase start          # Docker 로 Postgres/Auth/Realtime/Studio 전부 기동
supabase status         # URL 과 로컬 키 확인
supabase db reset       # 마이그레이션을 처음부터 다시 적용 (로컬 데이터 날아감)
supabase stop           # 종료
```

- API `http://127.0.0.1:54321`, Studio `http://127.0.0.1:54323`,
  DB `postgresql://postgres:postgres@127.0.0.1:54322/postgres`
- 로컬 키는 모든 프로젝트가 공유하는 고정값이라 커밋해도 무해하다. **클라우드 키는 다르다.**

## 클라우드 프로젝트

1. https://supabase.com 가입 → **New project** (리전은 서울 `ap-northeast-2`).
2. 생성 후 Settings → API 에서 project ref 와 anon 키 확인.
3. Authentication → Sign In / Providers → **Anonymous sign-ins 활성화**
   (`config.toml` 의 `enable_anonymous_sign_ins` 는 로컬 전용이다).
   같은 화면의 **Attack Protection 에서 Turnstile/hCaptcha 도 함께 켠다** — 익명 가입은
   공개 엔드포인트라 이게 유일한 상류 방어다. Rate Limits 의 anonymous 값도 확인한다.
4. 레포에서:
   ```bash
   supabase link --project-ref <ref>
   supabase db push          # supabase/migrations/*.sql 을 클라우드에 적용
   ```

`supabase db push` 는 이미 적용된 마이그레이션을 건너뛰고 새 것만 올린다.
**마이그레이션은 절대 수정하지 말고 새 파일을 추가한다** — 이미 올라간 파일을 고치면
로컬과 클라우드가 갈라진다. (아직 어디에도 배포하지 않은 지금만 0001 을 직접 고쳐도 된다.)

## 테스트

```bash
docker exec -i supabase_db_wiggly-orca psql -U postgres < supabase/tests/rls.sql
docker exec -i supabase_db_wiggly-orca psql -U postgres < supabase/tests/abuse.sql
```

- `rls.sql` — 격리(무관한 익명 사용자는 0행), 정상 경로(페어링된 폰), 컬럼 가드, revoke 즉시성
- `abuse.sql` — 적대적 익명 가입자 1명의 쓰기 상한, anon 의 함수·테이블 접근 거부

기대 출력은 각 파일 상단 주석에 있다.

## 릴레이 왕복 프로브

랩탑·폰·무관한 제3자를 한 프로세스에서 동시에 연기해 페어링 전 구간을 검증한다.
`src/main/remote/crypto.ts` 를 **그대로** import 하므로(암호 구현을 복사하지 않는다)
프로브가 통과하면 실제 앱도 같은 코드로 통과한다.

```bash
# 로컬
supabase start && supabase functions serve          # 다른 터미널
eval "$(supabase status -o env | sed 's/^/export /')"
npm run remote:probe

# 클라우드
API_URL=https://<ref>.supabase.co ANON_KEY=<anon> npm run remote:probe
```

검증하는 것: 익명 사용자 격리, 남의 페어링 폴링 거부, 선착순 claim 잠금, 양쪽 SAS 일치,
세션키 언랩, 코드 1회용, 방향 분리(반사 공격), commands 삽입, revoke 즉시성.

## 클라우드 상태 확인

CLI 에는 임의 SQL 실행 명령이 없다. 실제 권한 상태는 스키마를 떠서 본다:

```bash
supabase db dump --linked --schema public -f /tmp/remote.sql
grep '"anon"' /tmp/remote.sql          # GRANT USAGE ON SCHEMA 한 줄만 남아야 정상
supabase migration list --linked        # local/remote 버전 일치 확인
```

`cron.job` 같은 확장 소유 테이블은 `db dump` 에 나오지 않는다. 대시보드 SQL Editor 에서
`select jobname, schedule, active from cron.job;` 로 확인한다.
