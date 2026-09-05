import type { GitStatus, StackOpProgress, Workspace } from '@shared/types'

/**
 * base 보다 뒤처지지 않았는가.
 *
 * behind 만 보면 PR 이 base 갱신을 요구하는 경우(#317)를 놓친다. 헤더 칩의 idle 판정과
 * ⇧⌘B 게이트가 서로 다른 답을 내면, 눌리지 않는 버튼 옆에서 단축키만 force-push 를 하게 된다.
 */
export function upToDateWithBase(git: GitStatus, prNeedsBaseUpdate?: boolean): boolean {
  return git.behind <= 0 && !prNeedsBaseUpdate
}

/** ⇧⌘B 를 받을 수 있는지, 못 받는다면 사용자에게 이유를 뭐라고 말할지. */
export type RebaseGate = { ok: true } | { ok: false; message: string }

/**
 * ⇧⌘B(rebase onto base) 게이트.
 *
 * 헤더 칩은 누를 수 없는 상태를 회색으로 보여 주지만 단축키에는 그런 자리가 없다 — 아무 일도
 * 안 일어나면 사용자는 단축키가 고장 났다고 읽는다. 그래서 막는 경우마다 할 말을 함께 돌려준다.
 */
export function rebaseShortcutGate(input: {
  workspace: Workspace
  git: GitStatus | null | undefined
  progress: StackOpProgress | null | undefined
  prNeedsBaseUpdate?: boolean
}): RebaseGate {
  const { workspace, git, progress, prNeedsBaseUpdate } = input
  const base = workspace.baseBranch || 'base'
  // git 상태를 아직 못 읽었으면 뒤처짐도 충돌도 판단할 근거가 없다. 모르는 채로 force-push 하지 않는다.
  if (!git) return { ok: false, message: 'Still reading this worktree — try again in a moment.' }
  if (progress && !progress.finished)
    return {
      ok: false,
      message:
        progress.kind === 'train'
          ? 'A merge train is running here — it rebases the stack itself.'
          : 'This workspace is already rebasing.'
    }
  if (git.conflicted) return { ok: false, message: 'Resolve the conflicts in this worktree first.' }
  // 외부 병합으로 생긴 캐스케이드는 배너가 승인을 받아 실행한다. 단축키가 먼저 옛 base 위로
  // rebase 하면 그 승인 절차를 건너뛴 채 엉뚱한 브랜치 위에 올라간다.
  if (workspace.stackSync)
    return { ok: false, message: 'A stack update is waiting for your approval in the banner.' }
  if (upToDateWithBase(git, prNeedsBaseUpdate))
    return { ok: false, message: `Already up to date with ${base}.` }
  return { ok: true }
}
