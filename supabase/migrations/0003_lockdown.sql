-- 권한 봉인 — 스키마가 자기 권한 상태를 **스스로 선언**하게 만든다.
--
-- 왜 필요한가. public 스키마의 기본 권한은 프로젝트가 언제 만들어졌느냐에 따라 다르다.
-- 실측: 로컬 CLI 이미지(2026-08)는 새 테이블에 anon/authenticated 에게 Dxtm 만 주는데,
-- 같은 날 만든 클라우드 프로젝트는 `GRANT ALL ON TABLE ... TO anon` 을 준다.
-- 즉 0001 의 GRANT 만으로는 "어떤 권한이 있는가"가 아니라 "무엇을 더 얹었는가"만 정해진다.
-- 회수부터 하고 필요한 것만 다시 주면 두 환경이 같은 상태로 수렴한다.
--
-- 그리고 더 급한 것: 함수는 PostgreSQL 기본값이 **PUBLIC 에게 EXECUTE** 다.
-- 실측: `set role anon; select public.cleanup_relay();` 가 성공한다 —
-- 로그인조차 하지 않은, 앱에 박힌 공개 anon 키만 가진 누구나
-- `POST /rest/v1/rpc/cleanup_relay` 로 security definer 함수를 돌릴 수 있었다.
-- 그 함수는 postgres 권한으로 commands·push_events·machines·auth.users 를 지운다.

-- ── 전면 회수 ────────────────────────────────────────────────────────────
revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
revoke all on all functions in schema public from public;

-- ── 테이블: 필요한 동사만 (0001 과 동일한 의도, 이제는 단정적으로) ───────
grant select, insert, update, delete on public.machines to authenticated;
grant select, insert, update, delete on public.devices to authenticated;
grant select, insert, update on public.commands to authenticated;
grant select, insert, update, delete on public.machine_state to authenticated;
grant select on public.push_events to authenticated;
-- pairings 는 어디에도 주지 않는다 — Edge Function(service role) 전용.

grant all on all tables in schema public to service_role;

-- ── 함수: RLS 정책이 부르는 두 개만 ──────────────────────────────────────
-- 정책 식은 호출자 롤로 평가되므로 이 둘은 EXECUTE 가 있어야 한다.
-- 나머지(cleanup_relay, 트리거 함수들)는 아무에게도 주지 않는다.
-- 트리거 함수의 EXECUTE 는 트리거 **생성 시점**에만 검사되므로 회수해도 계속 동작한다.
-- cleanup_relay 는 소유자(postgres)로 도는 pg_cron 이 부르므로 GRANT 가 필요 없다.
grant execute on function public.owns_machine(uuid) to authenticated, service_role;
grant execute on function public.is_paired(uuid) to authenticated, service_role;

-- ── 앞으로 만들 객체의 기본값도 고정한다 ─────────────────────────────────
-- 이게 없으면 다음에 추가하는 테이블·함수가 다시 프로젝트 기본값을 물려받고,
-- 그때는 아무도 눈치채지 못한다.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
alter default privileges in schema public revoke all on functions from public;
