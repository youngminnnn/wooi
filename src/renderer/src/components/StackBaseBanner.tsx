import React, { useState } from 'react'
import { GitPullRequestArrow, Loader2, X } from 'lucide-react'
import type { Workspace } from '@shared/types'
import { useStore } from '../store'

/**
 * 스택 워크스페이스의 PR 이 부모가 아닌 브랜치를 향할 때 뜨는 배너.
 *
 * `--base` 없이 실행된 `gh pr create` 는 리포 기본 브랜치를 고르므로, 에이전트가 직접 PR 을
 * 열면 스택인데도 main 을 향하기 쉽다. 예전에는 그 base 를 조용히 채택했는데, 그러면 스택
 * 관계가 흔적 없이 사라지고 ahead/behind·restack·머지 캐스케이드가 전부 어긋난 기준으로
 * 돌아간다. 그래서 채택하지 않고 여기서 물어본다 — 되돌릴지, 의도한 것이니 둘지.
 */
export default function StackBaseBanner({
  workspace
}: {
  workspace: Workspace
}): React.JSX.Element | null {
  const retargetBase = useStore((s) => s.retargetBase)
  const keepBase = useStore((s) => s.keepBase)
  const requireGithub = useStore((s) => s.requireGithub)
  const [busy, setBusy] = useState(false)

  const mismatch = workspace.baseMismatch
  // 캐스케이드 배너와 동시에 뜨면 무엇을 먼저 할지 헷갈린다. 병합 캐스케이드가 우선이다.
  if (!mismatch || workspace.stackSync) return null

  return (
    <div className="px-4 pt-2">
      <div className="max-w-3xl mx-auto flex items-start gap-2.5 rounded-lg border border-[var(--warning-400)]/40 bg-[var(--warning-400)]/10 px-3 py-2.5">
        <GitPullRequestArrow size={14} className="mt-0.5 shrink-0 text-[var(--warning-400)]" />
        <div className="min-w-0 flex-1 text-xs leading-relaxed text-neutral-200">
          <div className="font-medium">
            #{mismatch.prNumber} targets <span className="font-mono">{mismatch.prBase}</span>, not
            the branch it stacks on.
          </div>
          <div className="text-neutral-400">
            This workspace branches off <span className="font-mono">{mismatch.expectedBase}</span>,
            so the PR would include that branch&apos;s commits too. Retargeting only changes the
            base on GitHub — no commits are rewritten.
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            disabled={busy}
            onClick={() => {
              void requireGithub('Retargeting a pull request changes its base on GitHub.', () => {
                setBusy(true)
                return retargetBase(workspace.id).finally(() => setBusy(false))
              })
            }}
            className="flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-[var(--warning-500)]/90 text-black text-xs font-medium hover:bg-[var(--warning-400)] disabled:opacity-60"
            title={`Retarget #${mismatch.prNumber} onto ${mismatch.expectedBase}`}
          >
            {busy && <Loader2 size={12} className="animate-spin" />}
            Retarget onto {mismatch.expectedBase}
          </button>
          <button
            disabled={busy}
            onClick={() => void keepBase(workspace.id)}
            className="h-7 w-7 grid place-items-center rounded-md text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-200 disabled:opacity-60"
            title={`Keep ${mismatch.prBase} as the base — don't ask again`}
          >
            <X size={13} />
          </button>
        </div>
      </div>
    </div>
  )
}
