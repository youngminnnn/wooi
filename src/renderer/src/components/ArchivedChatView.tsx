import { useState } from 'react'
import { Archive, ArchiveRestore, ArrowUp, GitBranch, Loader2, Lock } from 'lucide-react'
import { useStore } from '../store'
import MessageList from './MessageList'
import { truncatedHistoryNotice } from '../lib/archivedPreview'
import { useUnarchiveWorkspace } from '../lib/unarchive'
import { workspaceDisplayName } from '@shared/types'
import type { Workspace } from '@shared/types'

/**
 * 아카이브된 워크스페이스의 대화를 **읽기 전용으로** 보여 준다.
 *
 * 이 화면이 있는 이유는 하나다 — "이걸 되살릴까?" 는 안을 봐야 답할 수 있는 질문인데, 지금까지
 * 안을 보는 유일한 길이 되살리는 것이었다. 판단에 필요한 정보를 얻으려면 판단 대상인 행동을
 * 먼저 해야 하는 구조였다. 그래서 대화를 먼저 보여 주고, **결정 버튼을 같은 화면에 둔다**.
 *
 * 읽기 전용은 인심이 아니라 사실이다: worktree 디렉터리가 없으므로 git·파일·터미널·스크립트는
 * 실제로 불가능하고, 보낼 세션도 없다. 그래서 입력창·작업 패널·헤더 도구를 감추는 대신
 * 아래쪽에 그 이유를 한 줄로 적어 둔다 — 없는 것보다 "왜 없는지" 가 필요한 화면이다.
 *
 * 대화 자체는 살아 있는 워크스페이스와 **같은 MessageList·같은 읽기 창**을 쓴다. 여기서만
 * 다르게 그리면 되살린 순간 화면이 바뀌어, 방금 보고 결정한 것과 다른 것을 받게 된다.
 */
export default function ArchivedChatView({
  workspace
}: {
  workspace: Workspace
}): React.JSX.Element {
  const shown = useStore((s) => s.transcripts[workspace.id]?.length ?? 0)
  const loaded = useStore((s) => !!s.loadedTranscripts[workspace.id])
  const hasMore = useStore((s) => !!s.transcriptPaging[workspace.id]?.hasMore)
  const unarchiveWorkspace = useUnarchiveWorkspace()
  const [restoring, setRestoring] = useState(false)

  // 아카이브 시 표시 이름(PR 제목 등)을 displayName 에 보존하므로 PR 정보 없이도 같은 이름이 뜬다.
  const displayName = workspaceDisplayName(workspace)
  const notice = truncatedHistoryNotice(shown, hasMore)

  const restore = async (): Promise<void> => {
    setRestoring(true)
    try {
      await unarchiveWorkspace(workspace)
    } finally {
      setRestoring(false)
    }
  }

  return (
    <div className="archived-preview h-full flex flex-col min-w-0">
      {/* 헤더 — 배지로 어디에 와 있는지 말하고, 결정 버튼을 바로 옆에 둔다. */}
      <div className="archived-preview-header h-12 shrink-0 flex items-center gap-3 px-4 border-b border-[var(--border)]">
        <span className="shrink-0 inline-flex items-center gap-1 rounded border border-[var(--border-2)] bg-[var(--surface)] px-1.5 py-0.5 text-[11px] text-neutral-400">
          <Archive size={11} />
          Archived
        </span>
        <div className="archived-preview-identity min-w-0 flex-1">
          <div className="truncate text-base font-semibold text-neutral-100" title={displayName}>
            {displayName}
          </div>
        </div>
        <span
          className="hidden md:inline-flex shrink-0 items-center gap-1 text-xs text-neutral-500 max-w-[16rem]"
          title={workspace.branch}
        >
          <GitBranch size={11} />
          <span className="truncate">{workspace.branch}</span>
        </span>
        <button
          onClick={restore}
          disabled={restoring}
          title="Unarchive (recreate worktree)"
          className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-[var(--border-2)] bg-[var(--surface)] px-2.5 py-1 text-xs text-neutral-200 hover:border-neutral-500 hover:bg-[var(--surface-2)] disabled:opacity-50"
        >
          {restoring ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <ArchiveRestore size={12} />
          )}
          {restoring ? 'Unarchiving…' : 'Unarchive'}
        </button>
      </div>

      {/* 잘려 있다는 사실은 숨기지 않는다 — 이 화면만 보고 되살릴지 정하기 때문이다. */}
      {notice && (
        <div className="shrink-0 flex items-center gap-1.5 px-4 py-1.5 border-b border-[var(--border)] bg-[var(--surface)] text-xs text-neutral-500">
          <ArrowUp size={12} className="shrink-0" />
          {notice}
        </div>
      )}

      {loaded && shown === 0 ? (
        <div className="flex-1 overflow-y-auto grid place-items-center px-8">
          <div className="flex flex-col items-center text-center max-w-sm">
            <div className="mb-3 grid h-12 w-12 place-items-center rounded-xl bg-[var(--surface)] border border-[var(--border-2)]">
              <Archive size={20} className="text-neutral-400" />
            </div>
            <p className="text-base text-neutral-300">No conversation to show</p>
            <p className="mt-1 text-sm text-neutral-500 leading-relaxed">
              This workspace was archived before an agent session ran. Its branch is still there —
              unarchive it to pick the work back up.
            </p>
          </div>
        </div>
      ) : (
        <MessageList workspaceId={workspace.id} running={false} />
      )}

      {/* 입력창이 있던 자리. 비워 두면 "왜 못 쓰지" 가 되므로 이유를 적는다. */}
      <div className="shrink-0 flex items-center gap-2 border-t border-[var(--border)] px-4 py-2.5 text-xs text-neutral-500">
        <Lock size={12} className="shrink-0" />
        Read-only — this workspace&rsquo;s worktree was removed. Unarchive it to continue the
        conversation.
      </div>
    </div>
  )
}
