-- 페어링이 만든 devices 행의 id 를 페어링 행에 남긴다.
--
-- 폰은 이 id 가 반드시 필요하다: 방향별 키를 `HKDF(K_dev, salt=deviceId)` 로 파생하고,
-- 모든 암호문의 AAD 헤더에 넣으며, `commands.device_id` 로도 쓴다.
--
-- 없으면 폰이 pair-finish 이후에 devices 를 따로 조회해야 하는데, 그러면 페어링 완료가
-- 두 번의 왕복으로 갈라지고 그 사이에 실패하면 "키는 받았는데 내 id 를 모르는" 상태가 된다.
alter table public.pairings
  add column device_id uuid references public.devices (id) on delete cascade;
