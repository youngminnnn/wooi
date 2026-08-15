-- machine_state 를 기기별로 나눈다.
--
-- 상태는 **기기마다 다른 키로 봉인된다**(K_dev 에서 파생한 laptopToPhone). 그런데 PK 가
-- machine_id 단독이라, 기기가 둘이면 두 번째 봉인이 첫 번째를 덮어써 앞 기기는 자기 키로
-- 열 수 없는 암호문을 받게 된다. 지금까지는 "첫 번째 기기에만 발행"으로 피해 왔지만,
-- 그건 다중 기기를 지원하지 않는다는 사실을 코드에 숨겨 둔 것에 가깝다.
--
-- 행이 기기 수만큼 늘지만 각 행은 최대 256KB 이고 기기는 머신당 10개로 제한되어 있다.

alter table public.machine_state
  add column device_id uuid references public.devices (id) on delete cascade;

-- 기존 행은 어느 기기의 것인지 알 수 없다(그 정보를 저장한 적이 없다). 폰은 열지 못하는
-- 암호문을 받느니 없는 편이 낫고 — 랩탑이 다음 상태 변화에 곧바로 다시 발행한다.
delete from public.machine_state where device_id is null;

alter table public.machine_state
  alter column device_id set not null;

alter table public.machine_state drop constraint machine_state_pkey;
alter table public.machine_state
  add constraint machine_state_pkey primary key (machine_id, device_id);

-- 폰은 자기 행만 읽으면 된다. RLS 는 이미 is_paired 로 머신 단위 격리를 하고 있고,
-- 이 인덱스는 그 위에서 조회를 좁힌다.
create index machine_state_device_idx on public.machine_state (device_id);
