import React, { useState } from 'react'
import { Loader2, MessagesSquare, X } from 'lucide-react'
import type { PendingPeerMessage, Workspace } from '@shared/types'
import { useStore } from '../store'

/**
 * 다른 워크스페이스가 보낸 메시지의 승인 배너.
 *
 * 사용자가 `hold` 를 명시한 워크스페이스에서 이 배너가 곧 턴 비용의 승인 자리다. 앱의 기본은
 * 자동 전달이지만, 비용이나 집중 때문에 경계를 좁힌 곳에서는 보낸 쪽이 아니라 비용이 나는
 * 수신 쪽 사용자가 이 카드에서 한 건씩 열어 준다.
 *
 * 여러 건이 와 있으면 **가장 오래된 것부터 한 건씩** 보여 준다. 목록으로 펼치면 배너가 화면을
 * 먹고, 무엇보다 승인은 한 건씩 읽고 판단해야 하는 일이라 한꺼번에 처리할 버튼을 두지 않는다.
 */
export default function PeerInboxBanner({
  workspace
}: {
  workspace: Workspace
}): React.JSX.Element | null {
  const selectWorkspace = useStore((s) => s.selectWorkspace)
  const [busy, setBusy] = useState(false)

  const inbox = workspace.peerInbox ?? []
  const pending: PendingPeerMessage | undefined = inbox[0]
  if (!pending) return null

  const act = async (deliver: boolean): Promise<void> => {
    setBusy(true)
    try {
      await (deliver
        ? window.api.workspace.deliverPeerMessage(workspace.id, pending.id)
        : window.api.workspace.dismissPeerMessage(workspace.id, pending.id))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="px-4 pt-2">
      <div className="max-w-3xl mx-auto flex items-start gap-2.5 rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-2.5">
        <MessagesSquare size={14} className="mt-0.5 shrink-0 text-neutral-400" />
        <div className="min-w-0 flex-1 text-xs leading-relaxed text-neutral-200">
          <div className="flex items-center gap-1.5">
            <span className="font-medium">Message from</span>
            {pending.fromWorkspaceId ? (
              <button
                onClick={() => void selectWorkspace(pending.fromWorkspaceId!)}
                className="min-w-0 truncate rounded px-1 font-mono text-neutral-300 hover:bg-[var(--surface-2)] hover:text-neutral-100"
                title={`Open ${pending.fromName}`}
              >
                {pending.fromBranch}
              </button>
            ) : (
              <span className="min-w-0 truncate rounded px-1 text-neutral-300">
                {pending.fromName}
              </span>
            )}
            {/* 리포가 다르면 그 사실이 판단을 바꾼다 — 여기 코드베이스 이야기가 아니다. */}
            {pending.crossRepo && (
              <span className="shrink-0 rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] text-neutral-400">
                {pending.fromRepoName}
              </span>
            )}
            {inbox.length > 1 && (
              <span className="shrink-0 text-[10px] text-neutral-500">
                +{inbox.length - 1} more waiting
              </span>
            )}
          </div>
          <div className="mt-1 whitespace-pre-wrap break-words text-neutral-300">
            {pending.message}
          </div>
          <div className="mt-1 text-neutral-500">
            {/* 정책으로 잡힌 것과 전달에 실패한 것은 사용자가 할 판단이 다르다. 뒤쪽은
                "저쪽은 보냈다는데 여긴 왜 없나" 의 답이므로 그 사실을 그대로 말한다. */}
            {pending.undelivered
              ? 'Wooi could not deliver this — the session here went away before it arrived. The agent has not seen it.'
              : 'Delivering starts a turn here, so Wooi held it for you. The agent has not seen it.'}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            disabled={busy}
            onClick={() => void act(true)}
            className="flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-[var(--surface-2)] border border-[var(--border-strong)] text-neutral-200 text-xs font-medium hover:border-neutral-500 disabled:opacity-60"
            title="Send this into the conversation — starts a turn"
          >
            {busy && <Loader2 size={12} className="animate-spin" />}
            Deliver
          </button>
          <button
            disabled={busy}
            onClick={() => void act(false)}
            className="h-7 w-7 grid place-items-center rounded-md text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-200 disabled:opacity-60"
            title="Discard — the sender is not told"
          >
            <X size={13} />
          </button>
        </div>
      </div>
    </div>
  )
}
