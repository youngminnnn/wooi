import { useStore } from '../store'
import type { Workspace } from '@shared/types'

/**
 * 아카이브를 풀어 worktree 를 다시 만들고 그 워크스페이스를 연다.
 *
 * 사이드바의 아카이브 행과 읽기 전용 미리보기 헤더가 **같은 경로**를 쓰게 하려고 여기 둔다.
 * 언아카이브는 worktree 를 새로 만드는 일이라 전달(carry)이 다시 일어나고, 그 실패·누락·제안을
 * 알리는 것까지가 한 동작이다 — 한쪽에서만 알리면 같은 버튼인데 결과가 달라 보인다.
 */
export function useUnarchiveWorkspace(): (workspace: Workspace) => Promise<void> {
  const select = useStore((s) => s.selectWorkspace)
  const pushToast = useStore((s) => s.pushToast)
  const reportCarryFailures = useStore((s) => s.reportCarryFailures)
  const reportCarryMissing = useStore((s) => s.reportCarryMissing)
  const suggestCarry = useStore((s) => s.suggestCarry)

  return async (workspace) => {
    const res = await window.api.workspace.unarchive(workspace.id)
    if (res.error) {
      pushToast('error', res.error)
      return
    }
    void select(workspace.id)
    reportCarryFailures(res.carryFailures)
    // 전달 목록이 빈 리포라면 생성 경로와 똑같이 한 번 제안한다.
    reportCarryMissing(workspace.repoId, res.carryMissing)
    suggestCarry(workspace.repoId, workspace.id, res.carrySuggestions)
  }
}
