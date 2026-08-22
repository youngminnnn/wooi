/**
 * 충돌 해결을 시작할지 정하는 조건을 호출부마다 흩뜨리지 않고, 테스트할 수 있는 순수 함수 하나에
 * 모은다. 앞으로 merge train 이 같은 해결 진입점을 재사용할 때도 토큰을 쓰는 결정은 이 경계를
 * 지나게 한다.
 */

import type { StackCascadeStep } from '@shared/types'

export function buildConflictPrompt(input: {
  branch: string
  baseBranch: string
  conflictedFiles: string[]
  /** 사용자가 버튼을 누른 게 아니라 autoResolveConflicts 설정으로 Wooi 가 시작한 턴인지. */
  auto?: boolean
}): string {
  const automaticStart = input.auto
    ? 'Wooi started this turn automatically because "Resolve conflicts with the agent" is enabled; you can turn it off in Settings.\n\n'
    : ''
  const files = input.conflictedFiles.map((file) => `- ${file}`).join('\n')

  return `${automaticStart}Branch ${input.branch} is being rebased onto ${input.baseBranch}, and a rebase is currently in progress in this worktree.

Conflicted files:
${files}

Resolve only the conflict markers in those files, git add them, then run git rebase --continue. If a later commit conflicts, repeat the same loop for the files Git reports then.

Do not refactor. Do not touch files outside the conflicted list. Do not run the full test suite. Do not broadly explore the repository.

If you are not confident in the correct resolution, run git rebase --abort and explain why. Abandoning is better than resolving incorrectly.`
}

/** pickAutoResolveStep 이 고른, 자동 해결을 시작해도 되는 단계. */
export type AutoResolveStep = StackCascadeStep & {
  workspaceId: string
  conflictedFiles: string[]
}

export function pickAutoResolveStep(
  enabled: boolean,
  steps: Array<StackCascadeStep & { workspaceId?: string }>
): AutoResolveStep | null {
  if (!enabled) return null

  for (const step of steps) {
    if (
      step.status === 'conflict' &&
      typeof step.workspaceId === 'string' &&
      step.workspaceId.length > 0 &&
      Array.isArray(step.conflictedFiles) &&
      step.conflictedFiles.length > 0
    ) {
      // 캐스케이드는 첫 충돌 뒤에도 다음 child 를 처리해 충돌이 여럿 나올 수 있다. 워크스페이스마다
      // 턴을 병렬로 시작해 토큰을 태우지 않도록, 한 캐스케이드에서는 첫 충돌 하나만 고른다.
      return step as AutoResolveStep
    }
  }

  return null
}
