-- Wooi Remote — 릴레이 스키마.
--
-- 설계 원칙: 서버는 **암호문만** 본다. 모든 페이로드는 랩탑과 폰 사이에서만 존재하는 키로
-- XChaCha20-Poly1305 봉인되며, 서버가 볼 수 있는 것은 머신/기기 UUID·시각·크기뿐이다.
-- 따라서 이 스키마에는 워크스페이스 이름도, 브랜치도, 프롬프트도 컬럼으로 존재하지 않는다.

create extension if not exists pgcrypto;

-- ── machines: 랩탑 설치본 1개 = 1행 ──────────────────────────────────────
create table public.machines (
  id           uuid primary key default gen_random_uuid(),
  -- 랩탑의 익명 auth 사용자. 이 값이 "이 머신을 소유한다"의 유일한 정의다.
  owner_uid    uuid not null default auth.uid(),
  name         text not null,
  platform     text not null default 'darwin',
  app_version  text,
  last_seen_at timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  constraint machines_name_len check (char_length(name) between 1 and 100)
);
create index machines_owner_idx on public.machines (owner_uid);

-- ── devices: 페어링된 폰 1대 = 1행 ───────────────────────────────────────
create table public.devices (
  id              uuid primary key default gen_random_uuid(),
  machine_id      uuid not null references public.machines (id) on delete cascade,
  -- 폰의 익명 auth 사용자.
  user_uid        uuid not null,
  name            text not null,
  platform        text not null check (platform in ('ios', 'android')),
  -- 폰의 X25519 공개키(base64url). 페어링 때 교환한 것.
  pub_key         text not null,
  expo_push_token text,
  -- 리플레이 방지: 랩탑이 커맨드를 처리할 때마다 전진시킨다.
  last_seq        bigint not null default 0,
  revoked_at      timestamptz,
  last_seen_at    timestamptz,
  created_at      timestamptz not null default now(),
  unique (machine_id, user_uid)
);
create index devices_live_idx on public.devices (machine_id) where revoked_at is null;
create index devices_uid_idx on public.devices (user_uid) where revoked_at is null;

-- ── pairings: QR 이 화면에 떠 있는 동안에만 존재하는 단명 행 ──────────────
-- 클라이언트 정책을 **하나도 만들지 않는다** → RLS 기본 전면 거부.
-- service role 로 도는 Edge Function(pair-begin / pair-claim / pair-finish)만 접근한다.
create table public.pairings (
  -- 페어링 코드의 sha256. 코드 원문은 어디에도 저장하지 않는다(QR 과 폰의 메모리에만 존재).
  code_hash       text primary key,
  machine_id      uuid not null references public.machines (id) on delete cascade,
  machine_name    text not null,
  machine_pub_key text not null,
  device_pub_key  text,
  device_uid      uuid,
  device_name     text,
  device_platform text,
  -- 랩탑이 KEK 로 봉인한 세션키 K_dev. 폰이 pair-finish 에서 가져가 언랩한다.
  wrapped_key     bytea,
  wrapped_nonce   bytea,
  claimed_at      timestamptz,
  completed_at    timestamptz,
  expires_at      timestamptz not null default now() + interval '5 minutes'
);
create index pairings_expiry_idx on public.pairings (expires_at);

-- ── commands: 폰 → 랩탑 (암호문) ─────────────────────────────────────────
-- Broadcast 가 아니라 테이블인 이유: 랩탑이 자고 있을 때 보낸 Allow/프롬프트가 깨어난 뒤
-- 전달되어야 하고, 폰이 백그라운드로 가도 결과를 나중에 회수할 수 있어야 하기 때문이다.
create table public.commands (
  id           uuid primary key default gen_random_uuid(),
  machine_id   uuid not null references public.machines (id) on delete cascade,
  device_id    uuid not null references public.devices (id) on delete cascade,
  nonce        bytea not null,
  payload_ct   bytea not null,
  status       text not null default 'pending'
    check (status in ('pending', 'done', 'error', 'expired')),
  result_nonce bytea,
  result_ct    bytea,
  created_at   timestamptz not null default now(),
  completed_at timestamptz,
  -- 폰 → 랩탑 페이로드는 작다: 가장 큰 것이 프롬프트이고 그건 허용목록이 32KiB 로 자른다.
  -- 64KB 면 봉투·AEAD 오버헤드까지 넉넉하다. 이 숫자가 곧 남용 시 저장량의 곱셈 인자라
  -- "혹시 모르니 크게" 잡을 자리가 아니다. (결과는 트랜스크립트 페이지라 더 커도 된다)
  constraint commands_payload_size check (octet_length(payload_ct) <= 65536),
  constraint commands_result_size check (result_ct is null or octet_length(result_ct) <= 262144)
);
create index commands_pending_idx on public.commands (machine_id, created_at)
  where status = 'pending';
create index commands_device_idx on public.commands (device_id, created_at desc);

-- ── machine_state: 머신당 1행, 최신 상태 스냅샷 ──────────────────────────
-- 콜드 스타트한 폰이나, 랩탑이 자고 있을 때도 뭔가는 보여 줄 수 있어야 한다.
create table public.machine_state (
  machine_id uuid primary key references public.machines (id) on delete cascade,
  rev        bigint not null default 0,
  nonce      bytea not null,
  state_ct   bytea not null,
  updated_at timestamptz not null default now(),
  constraint state_size check (octet_length(state_ct) <= 262144)
);

-- ── push_events: 중복 억제 + 감사 (본문 없음) ────────────────────────────
create table public.push_events (
  id         uuid primary key default gen_random_uuid(),
  machine_id uuid not null references public.machines (id) on delete cascade,
  kind       text not null check (kind in ('needsInput', 'completed', 'error', 'summary')),
  dedupe_key text not null,
  created_at timestamptz not null default now()
);
-- 이 unique 인덱스가 곧 중복 억제 장치다 — 랩탑이 재시작해도 유효하다.
create unique index push_dedupe_idx on public.push_events (machine_id, dedupe_key);

-- ═══════════════════════════════════════════════════════════════════════
-- 권한(GRANT) — RLS 보다 먼저 통과해야 하는 관문
-- ═══════════════════════════════════════════════════════════════════════
-- Supabase 의 기본 권한은 public 스키마 새 테이블에 대해 anon/authenticated 에게
-- TRUNCATE/REFERENCES/TRIGGER 만 준다 — select/insert 는 주지 않는다.
-- 즉 RLS 정책만 쓰면 모든 클라이언트 호출이 "permission denied for table" 로 죽는다.
-- RLS 는 "어떤 행"을 정하고, GRANT 는 "그 동사를 쓸 수 있는가"를 정한다. 둘 다 필요하다.
--
-- 익명 로그인(anonymous sign-in)도 JWT 의 role 은 authenticated 다.
-- 따라서 anon 롤에는 이 스키마에서 아무 권한도 주지 않는다 — 로그인 없이는 아무것도 못 한다.

grant select, insert, update, delete on public.machines to authenticated;
grant select, insert, update, delete on public.devices to authenticated;
grant select, insert, update on public.commands to authenticated;
grant select, insert, update, delete on public.machine_state to authenticated;
grant select on public.push_events to authenticated;  -- 쓰기는 Edge Function 전용

-- pairings 는 의도적으로 제외한다. 정책도 없고 권한도 없다 —
-- 클라이언트가 뚫으려면 두 겹을 동시에 뚫어야 한다.

-- Edge Function 은 service_role 로 돈다. RLS 는 우회하지만 GRANT 는 우회하지 못한다.
grant select, insert, update, delete on all tables in schema public to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- RLS
-- ═══════════════════════════════════════════════════════════════════════

alter table public.machines enable row level security;
alter table public.devices enable row level security;
alter table public.pairings enable row level security;
alter table public.commands enable row level security;
alter table public.machine_state enable row level security;
alter table public.push_events enable row level security;

-- 이 머신을 소유한 랩탑인가?
create or replace function public.owns_machine(m uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from machines where id = m and owner_uid = auth.uid())
$$;

-- 이 머신에 접근 권한이 있는가? (소유 랩탑이거나, 살아 있는 페어링 기기)
create or replace function public.is_paired(m uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from machines where id = m and owner_uid = auth.uid())
      or exists (select 1 from devices  where machine_id = m and user_uid = auth.uid()
                                          and revoked_at is null)
$$;

-- RLS 정책 식은 **호출자 롤로** 평가된다 — 정책이 부르는 함수에 EXECUTE 가 없으면
-- 정책 자체가 permission denied 로 죽는다. security definer 라도 마찬가지다.
grant execute on function public.owns_machine(uuid) to authenticated, service_role;
grant execute on function public.is_paired(uuid) to authenticated, service_role;

-- machines
create policy machines_owner_all on public.machines
  for all using (owner_uid = auth.uid()) with check (owner_uid = auth.uid());
create policy machines_device_read on public.machines
  for select using (public.is_paired(id));

-- devices — 삽입은 **머신 소유자만**. 적대적 익명 사용자가 남의 머신에 자기 기기를 꽂을 수 없다.
create policy devices_owner_all on public.devices
  for all using (public.owns_machine(machine_id)) with check (public.owns_machine(machine_id));
create policy devices_self_read on public.devices
  for select using (user_uid = auth.uid() and revoked_at is null);
create policy devices_self_update on public.devices
  for update using (user_uid = auth.uid() and revoked_at is null)
  with check (user_uid = auth.uid());

-- 폰의 self-update 는 푸시 토큰과 생존 시각만 바꿀 수 있다.
-- 정책만으로는 컬럼을 제한할 수 없어서(RLS 는 행 단위다) 트리거로 막는다 —
-- 이게 없으면 폰이 자기 revoked_at 을 지우거나 pub_key 를 갈아끼울 수 있다.
create or replace function public.devices_guard_self_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.owns_machine(new.machine_id) then
    return new;  -- 랩탑은 전 컬럼을 다룰 수 있다(revoke 포함)
  end if;
  if new.id is distinct from old.id
     or new.machine_id is distinct from old.machine_id
     or new.user_uid is distinct from old.user_uid
     or new.name is distinct from old.name
     or new.platform is distinct from old.platform
     or new.pub_key is distinct from old.pub_key
     or new.last_seq is distinct from old.last_seq
     or new.revoked_at is distinct from old.revoked_at
     or new.created_at is distinct from old.created_at then
    raise exception 'devices: a device may only update expo_push_token and last_seen_at';
  end if;
  return new;
end $$;

create trigger devices_guard_self_update_trg
  before update on public.devices
  for each row execute function public.devices_guard_self_update();

-- pairings — 정책 없음 = 클라이언트 전면 거부. Edge Function(service role)만 접근.

-- commands
create policy commands_device_insert on public.commands
  for insert with check (
    exists (select 1 from devices d
             where d.id = device_id and d.user_uid = auth.uid()
               and d.machine_id = commands.machine_id and d.revoked_at is null));
create policy commands_device_read on public.commands
  for select using (
    exists (select 1 from devices d
             where d.id = device_id and d.user_uid = auth.uid() and d.revoked_at is null));
create policy commands_machine_read on public.commands
  for select using (public.owns_machine(machine_id));
create policy commands_machine_update on public.commands
  for update using (public.owns_machine(machine_id)) with check (public.owns_machine(machine_id));

-- machine_state
create policy state_owner_write on public.machine_state
  for all using (public.owns_machine(machine_id)) with check (public.owns_machine(machine_id));
create policy state_paired_read on public.machine_state
  for select using (public.is_paired(machine_id));

-- push_events — 쓰기는 Edge Function(`push`, service role)만 한다.
-- 랩탑은 푸시를 직접 보내지 않고 Edge Function 을 호출하므로 insert 권한이 애초에 필요 없고,
-- 클라이언트에 열어 두면 레이트리밋 없는 무제한 insert 구멍이 된다(실측: 익명 1명이 500행 삽입).
-- 소유자에게는 "내 폰에 뭐가 언제 갔나"를 보여 줄 읽기만 남긴다.
create policy push_owner_read on public.push_events
  for select using (public.owns_machine(machine_id));

-- ═══════════════════════════════════════════════════════════════════════
-- Realtime (Broadcast)
-- ═══════════════════════════════════════════════════════════════════════
-- Postgres Changes 가 아니라 Broadcast 를 쓴다: 전자는 구독자·행마다 RLS 를 재평가해 확장이 나쁘고,
-- 컬럼 메타데이터가 그대로 새어 나간다.
--
-- 토픽 이름은 'machine:<uuid>'. 그 머신에 페어링된 참가자만 구독·발행할 수 있다.

create policy realtime_paired_read on realtime.messages
  for select to authenticated using (
    public.is_paired(nullif(substring(realtime.topic() from '^machine:(.*)$'), '')::uuid));

create policy realtime_paired_write on realtime.messages
  for insert to authenticated with check (
    public.is_paired(nullif(substring(realtime.topic() from '^machine:(.*)$'), '')::uuid));

-- 커맨드가 들어오거나 결과가 채워지면 해당 머신 토픽으로 **깨우기 핑만** 보낸다.
-- 암호문 자체는 실어 보내지 않는다 — 수신자가 RLS 하에서 select 로 가져간다.
-- 그래야 암호문이 Realtime 경로와 메시지 크기 회계에서 빠진다.
create or replace function public.notify_command() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform realtime.send(
    jsonb_build_object('id', new.id, 'status', new.status),
    case when tg_op = 'INSERT' then 'command' else 'command_result' end,
    'machine:' || new.machine_id,
    true  -- private
  );
  return null;
end $$;

create trigger commands_notify_insert
  after insert on public.commands
  for each row execute function public.notify_command();

create trigger commands_notify_result
  after update of status on public.commands
  for each row when (old.status = 'pending' and new.status <> 'pending')
  execute function public.notify_command();
