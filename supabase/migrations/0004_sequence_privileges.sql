-- 0003 이 테이블과 함수는 봉인했지만 **시퀀스**를 빠뜨렸다.
-- 클라우드 기본값에는 `alter default privileges ... grant all on sequences to anon` 이 남아 있다.
--
-- 지금은 무해하다 — 이 스키마의 PK 는 전부 uuid 이고 시퀀스가 하나도 없다.
-- 그래서 고치는 것이다. 나중에 누가 serial 컬럼 하나를 추가하는 순간 그 시퀀스는
-- anon 에게 열린 채로 태어나고, 그때는 아무도 이 기본값을 다시 보지 않는다.
revoke all on all sequences in schema public from anon, authenticated;
grant all on all sequences in schema public to service_role;

alter default privileges in schema public revoke all on sequences from anon, authenticated;
