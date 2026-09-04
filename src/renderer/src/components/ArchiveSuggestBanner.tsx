import React, { useState } from 'react'
import { Archive, Eraser, Loader2, TriangleAlert, X } from 'lucide-react'
import type { Workspace } from '@shared/types'
import { useStore } from '../store'

/**
 * "맥락을 끊고 가자" 를 권할 만한 컨텍스트 크기.
 *
 * [[claude/session]] 의 `LARGE_RESUME_NOTICE_TOKENS` 와 **같은 값을 의도적으로 쓴다** — 저쪽은
 * 콜드 resume 이 디스크에서 되살리는 양을 보고 같은 말을 하고 있고, 새 개념을 하나 더 만들 이유가
 * 없다. 비율이 아니라 절대 토큰 수인 이유도 저쪽 주석 그대로다: 다시 읽는 비용은 창의 몇 %냐가
 * 아니라 몇 토큰이냐에 비례한다.
 */
const LARGE_CONTEXT_TOKENS = 100_000

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
 *
 * 병합됐다고 이 워크스페이스를 꼭 접는 것은 아니라, 정리 말고 다른 출구도 함께 준다 — 맥락만 끊고
 * 기록은 남기는 `Start fresh session`. 다음 작업이 끝난 작업의 컨텍스트를 이고 가는 것이 이
 * 워크스페이스에서 가장 비싼 습관이라, 그것을 정리와 같은 자리에서 말한다.
 */
export default function ArchiveSuggestBanner({
  workspace
}: {
  workspace: Workspace
}): React.JSX.Element | null {
  const dismissArchiveSuggest = useStore((s) => s.dismissArchiveSuggest)
  const reportArchiveScriptFailure = useStore((s) => s.reportArchiveScriptFailure)
  const archiveWorkspace = useStore((s) => s.archiveWorkspace)
  const changedFiles = useStore((s) => s.gitStatus[workspace.id]?.changedFiles ?? 0)
  const pushToast = useStore((s) => s.pushToast)
  const resetSessionContext = useStore((s) => s.resetSessionContext)
  // 이 워크스페이스를 계속 쓸 사람에게 필요한 값이라 아카이브와 같은 자리에서 함께 본다.
  const contextTokens = useStore((s) => s.contextUsage[workspace.id]?.usedTokens ?? 0)
  const [busy, setBusy] = useState(false)

  const suggestion = workspace.archiveSuggest
  // 캐스케이드 배너가 있으면 그쪽이 먼저다 — 스택을 정리하기 전에 아카이브하면 자식들이 끊긴다.
  // 판정에서 이미 배제하지만(detectArchiveSuggestion), 렌더 순서로도 한 번 더 보장한다.
  if (!suggestion || workspace.stackSync) return null

  const archive = async (): Promise<void> => {
    setBusy(true)
    try {
      const { archiveScriptFailure } = await archiveWorkspace(workspace.id)
      reportArchiveScriptFailure(archiveScriptFailure)
    } finally {
      setBusy(false)
    }
  }

  /**
   * 아카이브하지 않고 이 워크스페이스를 계속 쓰는 쪽. 맥락만 끊고 기록은 남긴다.
   *
   * 확인 창을 띄우지 않는 이유는 `/clear` 와 달리 **잃는 것이 없기 때문**이다 — 대화는 그대로
   * 남고, 되돌릴 것은 다음 턴이 앞 작업을 못 본다는 사실뿐이다.
   */
  const startFresh = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.api.chat.clear(workspace.id, { keepTranscript: true })
      // main 이 잊은 것을 렌더러도 잊어야 한다 — 게이지는 렌더러가 자기 복사본을 들고 있어서,
      // 이게 없으면 맥락을 끊은 뒤에도 상태줄이 끊기 전 사용량을 계속 가리킨다.
      resetSessionContext(workspace.id)
      pushToast('success', 'Started a fresh session. The conversation above is kept.')
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
          {contextTokens >= LARGE_CONTEXT_TOKENS && (
            <div className="mt-1 text-neutral-400">
              If you keep working here, the next turn still carries{' '}
              {Math.round(contextTokens / 1000).toLocaleString()}k tokens of the finished work
              forward. Starting a fresh session drops that but keeps the conversation on screen.
            </div>
          )}
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
          {contextTokens >= LARGE_CONTEXT_TOKENS && (
            <button
              disabled={busy}
              onClick={() => void startFresh()}
              className="flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-transparent border border-[var(--border-strong)] text-neutral-300 text-xs font-medium hover:border-neutral-500 disabled:opacity-60"
              title="Keep this workspace and the conversation, but start the next turn with empty context"
            >
              <Eraser size={12} />
              Start fresh session
            </button>
          )}
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
