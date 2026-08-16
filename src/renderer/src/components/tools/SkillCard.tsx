/**
 * 스킬 호출 — 도구 행으로 접지 않고 한 장으로 세운다.
 *
 * 스킬은 "무엇을 조회했다" 가 아니라 "여기서부터 이 절차로 일한다" 는 전환점이다. 다른 도구와
 * 같은 줄에 섞어 접어 두면, 대화를 되짚을 때 방향이 바뀐 지점을 찾을 수 없다.
 */
export function SkillCard({ name }: { name: string }): React.JSX.Element {
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 font-mono text-sm text-neutral-300">
      Skill({name})
    </div>
  )
}
