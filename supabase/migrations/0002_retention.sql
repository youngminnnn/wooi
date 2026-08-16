-- 보존 정책과 남용 방어.
--
-- 공용 프로젝트를 운영하므로(사용자가 자기 Supabase 를 만드는 BYO 방식이 아니므로) 두 가지가 필요하다:
--  1) 릴레이 테이블이 무한히 자라지 않게 하는 정리 작업
--  2) 익명 auth 로 아무나 가입할 수 있다는 사실에 대한 방어

-- ── 남용 방어: 한 익명 사용자가 만들 수 있는 머신 수 제한 ────────────────
-- 익명 사용자는 누구나 만들 수 있으므로, machines 삽입이 곧 무료 쓰기 엔드포인트가 된다.
create or replace function public.machines_guard_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  select count(*) into n from machines where owner_uid = new.owner_uid;
  if n >= 10 then
    raise exception 'too many machines for this account (limit 10)';
  end if;
  return new;
end $$;

create trigger machines_guard_insert_trg
  before insert on public.machines
  for each row execute function public.machines_guard_insert();

-- ── 남용 방어: 머신당 기기 수 제한 ───────────────────────────────────────
-- devices 의 insert 정책은 owns_machine(machine_id) 만 본다 — user_uid 는 제약하지 않는다.
-- 그럴 수밖에 없는 게, 랩탑이 페어링에서 만드는 행의 user_uid 는 **폰의** uid 라서
-- auth.uid() 와 같을 수 없다. 대신 개수로 막는다.
-- (실측: 이 트리거가 없으면 익명 사용자 1명이 임의 user_uid 로 유령 행을 무제한 삽입할 수 있다)
create or replace function public.devices_guard_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  select count(*) into n from devices where machine_id = new.machine_id;
  if n >= 10 then
    raise exception 'too many devices for this machine (limit 10)';
  end if;
  return new;
end $$;

create trigger devices_guard_insert_trg
  before insert on public.devices
  for each row execute function public.devices_guard_insert();

-- ── 남용 방어: 커맨드 상한 (기기당 분당 + 머신당 시간당) ─────────────────
-- 정상 사용은 분당 한 자릿수다. 두 층으로 막는 이유:
-- 분당 상한만 두면 지속 공격이 그 상한에 붙어 계속 흐른다(30/min × 24h = 43,200건).
-- 시간당 상한이 그 지속률을 끊는다. 저장량 상한 = 300 × 64KB ≈ 19MB/시간/머신.
create or replace function public.commands_guard_rate() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  select count(*) into n from commands
   where device_id = new.device_id and created_at > now() - interval '1 minute';
  if n >= 30 then
    raise exception 'command rate limit exceeded for this device (30/min)';
  end if;

  select count(*) into n from commands
   where machine_id = new.machine_id and created_at > now() - interval '1 hour';
  if n >= 300 then
    raise exception 'command rate limit exceeded for this machine (300/hour)';
  end if;
  return new;
end $$;

create trigger commands_guard_rate_trg
  before insert on public.commands
  for each row execute function public.commands_guard_rate();

-- ── 정리 작업 ────────────────────────────────────────────────────────────
-- 하나의 함수로 모아 둔다. pg_cron 이 있으면 스케줄되고, 없으면(로컬 스택 등) Edge Function 이나
-- 외부 스케줄러가 `select public.cleanup_relay()` 만 호출하면 된다 — 로직은 한 곳뿐이다.
create or replace function public.cleanup_relay() returns void
language sql security definer set search_path = public as $$
  -- 만료된 페어링(코드 수명 5분)
  delete from pairings where expires_at < now();

  -- 랩탑이 오랫동안 못 받아 간 커맨드는 실행하지 않는다.
  -- 잠들었던 랩탑이 30분 뒤에 깨어나 그 사이 승인들을 몰아서 실행하면 안 된다.
  update commands set status = 'expired', completed_at = now()
   where status = 'pending' and created_at < now() - interval '15 minutes';

  -- 처리된 커맨드 본문은 오래 둘 이유가 없다(암호문이어도 유출면이고, 남용 시 저장량이다).
  -- pending 은 15분에 만료되고 결과는 몇 초 안에 회수된다. 폰이 놓쳐도 remote:transcript 로
  -- 다시 당겨오므로 이 테이블은 아카이브가 아니다 — 6시간이면 넉넉하다.
  delete from commands where created_at < now() - interval '6 hours';
  delete from push_events where created_at < now() - interval '2 days';

  -- 반년 넘게 접속하지 않은 머신은 페어링·상태와 함께 정리한다(cascade).
  delete from machines where last_seen_at < now() - interval '180 days';

  -- 익명 사용자는 auth.users 에 영구히 쌓인다 — Supabase 는 자동 정리를 하지 않는다.
  -- 머신도 기기도 없는 30일 이상 된 익명 계정만 지운다(살아 있는 페어링은 건드리지 않는다).
  -- 방치하면 저장량과 MAU 집계가 함께 샌다.
  delete from auth.users u
   where u.is_anonymous
     and u.created_at < now() - interval '30 days'
     and not exists (select 1 from machines m where m.owner_uid = u.id)
     and not exists (select 1 from devices d where d.user_uid = u.id);
$$;

-- pg_cron 이 사용 가능하면 스케줄한다. 로컬 스택에는 없을 수 있으므로 조건부로 처리해
-- 같은 마이그레이션이 로컬과 클라우드 양쪽에서 그대로 돌게 한다.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('wooi-cleanup-relay', '*/5 * * * *', 'select public.cleanup_relay()');
  else
    raise notice 'pg_cron 없음 — cleanup_relay() 를 외부 스케줄러로 호출할 것';
  end if;
end $$;
