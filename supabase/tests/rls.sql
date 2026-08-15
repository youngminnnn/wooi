-- RLS 회귀 증명. 로컬 스택에 대고 그대로 실행한다:
--
--   docker exec -i supabase_db_$(basename $PWD) psql -U postgres < supabase/tests/rls.sql
--
-- psql 은 service role(=RLS 우회)로 붙으므로, 클라이언트 흉내는
-- `set local role authenticated` + `set local request.jwt.claims` 로 낸다.
-- 이게 PostgREST 가 요청마다 하는 일과 정확히 같다 — auth.uid() 는 그 claims 의 sub 를 읽는다.
--
-- 기대 결과 (이것과 다르면 회귀다):
--   alice_machines 1 / alice_state 1 / alice_pairings → ERROR permission denied
--   mallory_machines 0 / mallory_state 0 / mallory_pairings → ERROR permission denied
--   Mallory 의 devices insert → ERROR new row violates row-level security policy
--   laptop_inserted_device 1 / phone_sees_machine 1 / phone_sees_state 1
--   phone_sent_command 1 / phone_set_push_token 1
--   폰의 pub_key 변경 → ERROR devices: a device may only update ...
--   revoked_phone_machines 0 / revoked_phone_state 0

-- RLS 격리 증명: 두 익명 사용자(Alice=랩탑 소유자, Mallory=무관한 익명 가입자)
-- Alice 는 자기 머신을 보고, Mallory 는 아무것도 보지 못한다.

\set QUIET on
\pset pager off

-- ── 준비: service role(RLS 우회)로 Alice 의 머신/상태를 심는다 ──────────
begin;
delete from public.machines where name in ('alice-laptop');

insert into public.machines (id, owner_uid, name)
values ('11111111-1111-1111-1111-111111111111',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'alice-laptop');

-- 상태는 기기별로 봉인되므로(0006) 기기가 먼저 있어야 한다. 여기서는 service role 로
-- 심는다 — 소유권 검증은 뒤의 시나리오가 따로 다룬다.
insert into public.devices (id, machine_id, user_uid, name, platform, pub_key)
values ('33333333-3333-3333-3333-333333333333',
        '11111111-1111-1111-1111-111111111111',
        'cccccccc-cccc-cccc-cccc-cccccccccccc', 'seed-phone', 'ios', 'seed-dpk');

insert into public.machine_state (machine_id, device_id, rev, nonce, state_ct)
values ('11111111-1111-1111-1111-111111111111',
        '33333333-3333-3333-3333-333333333333', 1, '\x00'::bytea, '\x01'::bytea);

insert into public.pairings (code_hash, machine_id, machine_name, machine_pub_key)
values ('deadbeef', '11111111-1111-1111-1111-111111111111', 'alice-laptop', 'mpk');
commit;

-- ── Alice 로 위장 ────────────────────────────────────────────────────────
begin;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';

select 'alice_machines' as check, count(*) as n from public.machines;
select 'alice_state' as check, count(*) as n from public.machine_state;
-- pairings 는 소유자에게도 보이지 않아야 한다 (Edge Function 전용)
select 'alice_pairings' as check, count(*) as n from public.pairings;
commit;

-- ── Mallory 로 위장 ─────────────────────────────────────────────────────
begin;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated"}';

select 'mallory_machines' as check, count(*) as n from public.machines;
select 'mallory_state' as check, count(*) as n from public.machine_state;
select 'mallory_pairings' as check, count(*) as n from public.pairings;
commit;

-- ── Mallory 가 Alice 머신에 자기 기기를 꽂으려 시도 ──────────────────────
begin;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated"}';

insert into public.devices (machine_id, user_uid, name, platform, pub_key)
values ('11111111-1111-1111-1111-111111111111',
        'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'mallory-phone', 'ios', 'dpk');
commit;

-- 페어링된 폰의 정상 경로 + 컬럼 가드 증명.
\pset pager off

begin;
delete from public.machines where name = 'alice-laptop';
insert into public.machines (id, owner_uid, name)
values ('11111111-1111-1111-1111-111111111111',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'alice-laptop');
-- 위 delete 가 cascade 로 기기까지 지웠으므로 다시 심는다(상태는 기기별이다).
insert into public.devices (id, machine_id, user_uid, name, platform, pub_key)
values ('33333333-3333-3333-3333-333333333333',
        '11111111-1111-1111-1111-111111111111',
        'cccccccc-cccc-cccc-cccc-cccccccccccc', 'seed-phone', 'ios', 'seed-dpk');
insert into public.machine_state (machine_id, device_id, rev, nonce, state_ct)
values ('11111111-1111-1111-1111-111111111111',
        '33333333-3333-3333-3333-333333333333', 1, '\x00'::bytea, '\x01'::bytea);
commit;

-- ── Alice(랩탑)가 폰 기기 행을 만든다 ───────────────────────────────────
begin;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';
-- 시드가 이미 같은 (machine_id, user_uid) 로 기기를 만들어 두었다(unique 제약).
-- 랩탑이 그 행을 자기 자격으로 갱신할 수 있는지를 본다 — 그게 실제 재페어링 경로다.
update public.devices set name = 'alice-phone', pub_key = 'dpk'
 where id = '33333333-3333-3333-3333-333333333333';
select 'laptop_inserted_device' as check, count(*) as n from public.devices;
commit;

-- ── 폰(Carol uid)이 자기 머신을 본다 ────────────────────────────────────
begin;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';
select 'phone_sees_machine' as check, count(*) as n from public.machines;
select 'phone_sees_state' as check, count(*) as n from public.machine_state;
insert into public.commands (machine_id, device_id, nonce, payload_ct)
values ('11111111-1111-1111-1111-111111111111',
        '33333333-3333-3333-3333-333333333333', '\x00'::bytea, '\x02'::bytea);
select 'phone_sent_command' as check, count(*) as n from public.commands;
-- 허용된 self-update: 푸시 토큰
update public.devices set expo_push_token = 'ExponentPushToken[x]'
 where id = '33333333-3333-3333-3333-333333333333';
select 'phone_set_push_token' as check, count(*) as n from public.devices
 where expo_push_token is not null;
commit;

-- ── 폰이 자기 revoked_at 을 지우려 시도 (컬럼 가드) ──────────────────────
begin;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';
update public.devices set pub_key = 'attacker-key'
 where id = '33333333-3333-3333-3333-333333333333';
commit;

-- ── 랩탑이 revoke → 폰의 접근이 즉시 끊긴다 ─────────────────────────────
begin;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated"}';
update public.devices set revoked_at = now()
 where id = '33333333-3333-3333-3333-333333333333';
commit;

begin;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}';
select 'revoked_phone_machines' as check, count(*) as n from public.machines;
select 'revoked_phone_state' as check, count(*) as n from public.machine_state;
commit;
