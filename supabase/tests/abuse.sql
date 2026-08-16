-- 적대적 익명 사용자 1명의 쓰기 표면 상한을 측정한다.
--
--   docker exec -i supabase_db_wiggly-orca psql -U postgres < supabase/tests/abuse.sql
--
-- 익명 가입은 누구에게나 열려 있으므로(anon 키가 앱에 내장된다) "적대적 가입자 1명이
-- 무엇을 얼마나 쓸 수 있는가"가 곧 비용 상한이다. 기밀성이 아니라 **비용**에 대한 테스트다.
--
-- 기대: machines 11번째 차단 / devices 11번째 차단 / push_events permission denied

-- 적대적 익명 사용자 1명의 실제 쓰기 표면을 측정한다.
\pset pager off
begin;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddddd","role":"authenticated","is_anonymous":true}';

-- 1) 머신 상한이 실제로 도는가? 11개째가 막혀야 한다.
do $$
declare i int; begin
  for i in 1..11 loop
    begin
      insert into public.machines (name) values ('evil-' || i);
    exception when others then
      raise notice 'machines insert #% blocked: %', i, sqlerrm;
    end;
  end loop;
end $$;
select 'evil_machines' as check, count(*) as n from public.machines;

-- 2) devices 정책은 owns_machine 만 본다 — user_uid 는 제약하지 않는다.
--    즉 임의의 user_uid 로 무제한 행을 꽂을 수 있는가?
do $$
declare m uuid; i int; begin
  select id into m from public.machines limit 1;
  for i in 1..50 loop
    insert into public.devices (machine_id, user_uid, name, platform, pub_key)
    values (m, gen_random_uuid(), 'ghost-' || i, 'ios', 'x');
  end loop;
exception when others then raise notice 'devices insert blocked: %', sqlerrm;
end $$;
select 'ghost_devices' as check, count(*) as n from public.devices;

-- 3) push_events 는 레이트리밋이 없다.
do $$
declare m uuid; i int; begin
  select id into m from public.machines limit 1;
  for i in 1..500 loop
    insert into public.push_events (machine_id, kind, dedupe_key)
    values (m, 'needsInput', 'k' || i);
  end loop;
exception when others then raise notice 'push insert blocked: %', sqlerrm;
end $$;
select 'push_events' as check, count(*) as n from public.push_events;

-- 4) machine_state 최대 크기 × 머신 수
select 'state_max_bytes' as check, 262144 as n;
rollback;

-- ── 미로그인 anon 이 security definer 함수를 부를 수 있는가? ─────────────
-- 함수의 PostgreSQL 기본값은 PUBLIC EXECUTE 다. 0003 이 회수한다.
-- 기대: permission denied for function cleanup_relay
begin;
set local role anon;
select 'anon_calls_cleanup' as check, public.cleanup_relay() is null as result;
rollback;

-- anon 은 테이블에도 접근할 수 없어야 한다(클라우드 기본값은 GRANT ALL 이었다).
-- 기대: permission denied for table machines
begin;
set local role anon;
select 'anon_reads_machines' as check, count(*) as n from public.machines;
rollback;
