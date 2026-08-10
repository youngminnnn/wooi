import React, { useState } from 'react'
import { Archive, Loader2, TriangleAlert, X } from 'lucide-react'
import type { Workspace } from '@shared/types'
import { useStore } from '../store'

/**
 * 이 워크스페이스의 PR 이 병합돼 남은 일이 없을 때 뜨는 정리 제안 배너.
 *
 * 앱이 이미 아는 사실을 앱이 말한다 — 병합 감지는 스택 캐스케이드가 쓰는 것과 같은 신호이므로,
 * 에이전트에게 턴을 태워 다시 판단시키지 않는다. 죽은 워크스페이스가 사이드바에 쌓이는 것을
 * 사용자가 눈으로 알아채야 하는 상황을 없애는 것이 목적이다.
 *
 * 감지는 자동이지만 실행은 자동이 아니다 — 아카이브는 worktree 디렉토리를 지우므로(브랜치·기록은
 * 남는다) 사용자 승인 뒤에만 나간다. 이 배너가 곧 그 확인 창이라, 별도 확인 다이얼로그는 띄우지
 * 않고 대신 잃게 될 것을 여기서 먼저 말한다.
 */
export default function ArchiveSuggestBanner({
  workspace
}: {
  workspace: Workspace
}): React.JSX.Element | null {
  const dismissArchiveSuggest = useStore((s) => s.dismissArchiveSuggest)
  const selectWorkspace = useStore((s) => s.selectWorkspace)
  const reportArchiveScriptFailure = useStore((s) => s.reportArchiveScriptFailure)
  const changedFiles = useStore((s) => s.gitStatus[workspace.id]?.changedFiles ?? 0)
  const [busy, setBusy] = useState(false)

  const suggestion = workspace.archiveSuggest
  // 캐스케이드 배너가 있으면 그쪽이 먼저다 — 스택을 정리하기 전에 아카이브하면 자식들이 끊긴다.
  // 판정에서 이미 배제하지만(detectArchiveSuggestion), 렌더 순서로도 한 번 더 보장한다.
  if (!suggestion || workspace.stackSync) return null

  const archive = async (): Promise<void> => {
    setBusy(true)
    try {
      const { archiveScriptFailure } = await window.api.workspace.archive(workspace.id)
      reportArchiveScriptFailure(archiveScriptFailure)
      void selectWorkspace(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="px-4 pt-2">
      <div className="max-w-3xl mx-auto flex items-start gap-2.5 rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-2.5">
        <Archive size={14} className="mt-0.5 shrink-0 text-neutral-400" />
        <div className="min-w-0 flex-1 text-xs leading-relaxed text-neutral-200">
          <div className="font-medium">
            {suggestion.prNumber ? `#${suggestion.prNumber} ` : ''}was merged —{' '}
            <span className="font-mono">{suggestion.mergedBranch}</span> is done.
          </div>
          <div className="text-neutral-400">
            Archiving removes this worktree directory. The branch, pull request, and conversation
            are kept, and you can unarchive it later.
          </div>
          {changedFiles > 0 && (
            <div className="mt-1 flex items-start gap-1.5 text-[var(--warning-400)]">
              <TriangleAlert size={12} className="mt-0.5 shrink-0" />
              <span>
                {changedFiles} uncommitted {changedFiles > 1 ? 'files' : 'file'} will be deleted
                along with the worktree. Commit or stash first to keep them.
              </span>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            disabled={busy}
            onClick={() => void archive()}
            className="flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-[var(--surface-2)] border border-[var(--border-strong)] text-neutral-200 text-xs font-medium hover:border-neutral-500 disabled:opacity-60"
            title="Remove this worktree — branch, pull request, and conversation are kept"
          >
            {busy && <Loader2 size={12} className="animate-spin" />}
            Archive
          </button>
          <button
            disabled={busy}
            onClick={() => void dismissArchiveSuggest(workspace.id)}
            className="h-7 w-7 grid place-items-center rounded-md text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-200 disabled:opacity-60"
            title="Dismiss — keep this workspace"
          >
            <X size={13} />
          </button>
        </div>
      </div>
    </div>
  )
}
