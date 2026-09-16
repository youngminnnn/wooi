import { ArrowLeft, Loader2, Square } from 'lucide-react'
import MessageList from './MessageList'
import Composer from './Composer'
import { AgentBackendMark } from './BrandIcons'
import { useStore } from '../store'
import { formatDuration } from '../lib/format'
import { useNow } from '../lib/useNow'
import { subagentAddress, subagentRow } from '@shared/subagents'
import { workspaceDisplayName } from '@shared/types'
import type { Workspace } from '@shared/types'

/**
 * 서브에이전트 하나의 대화 — 워크스페이스 대화창이 서 있던 그 자리에 그대로 선다.
 *
 * ## 왜 별도의 화면인가
 *
 * 서브에이전트는 정의상 병렬로 돈다. 셋을 동시에 띄우면 셋의 도구 호출이 시간순으로 뒤엉켜
 * 도착하고, 그것을 한 대화에 늘어놓으면 어느 줄이 누구의 것인지 읽을 방법이 없다. 실행 단위로
 * 갈라 두면 각 대화는 원래대로 한 줄기로 읽힌다. 부모 대화에는 `Task` 도구 카드가 그 자리를
 * 지킨다 — "누구에게 무엇을 시켰다" 는 여전히 대화의 일부고, "그가 무엇을 했는가" 만 여기로 온다.
 *
 * ## 왜 대화창과 같아야 하는가
 *
 * 같은 것을 읽는 화면이 두 벌이면 사용자는 도구 카드를 두 번 배운다. 그래서 `MessageList` 와
 * `Composer` 를 **그대로** 쓴다 — 밀도(⌃O)·검색(⌘F)·점프·스크롤 앵커·도구 묶음·초안·↑ 히스토리가
 * 전부 따라온다. 헤더만 다르다: PR·rebase·stack 은 서브에이전트에 뜻이 없고, 대신 그 실행이
 * 무엇이며 얼마나 썼는지가 온다.
 */
export default function SubagentChatView({
  workspace,
  toolId
}: {
  workspace: Workspace
  toolId: string
}): React.JSX.Element {
  const items = useStore((s) => s.transcripts[workspace.id])
  const close = useStore((s) => s.closeSubagent)
  const row = subagentRow(items ?? [], toolId)
  const running = row?.status === 'running'
  const now = useNow(1000, running)
  const address = subagentAddress(items ?? [], toolId)

  // 기록이 아직 없거나 사라졌다 — 되돌아갈 길만 남긴다. 빈 화면에 갇히지 않게 한다.
  if (!row) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-neutral-500">
        <p className="text-sm">This subagent’s conversation is no longer in the transcript.</p>
        <button
          onClick={close}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-2)] bg-[var(--surface)] px-2.5 py-1 text-xs text-neutral-200 hover:border-neutral-500"
        >
          <ArrowLeft size={12} />
          Back to {workspaceDisplayName(workspace)}
        </button>
      </div>
    )
  }

  const elapsed = running ? now - row.ts : row.durationMs
  const facts = [
    typeof row.toolUses === 'number' ? `${row.toolUses} tool uses` : null,
    typeof row.totalTokens === 'number' ? `${row.totalTokens.toLocaleString()} tokens` : null,
    typeof elapsed === 'number' ? formatDuration(elapsed) : null
  ].filter(Boolean)

  return (
    <div className="h-full flex flex-col min-h-0 bg-[var(--bg)]">
      <div className="workspace-header h-12 shrink-0 flex items-center gap-2 px-4 border-b border-[var(--border)]">
        <button
          onClick={close}
          title={`Back to ${workspaceDisplayName(workspace)}`}
          aria-label={`Back to ${workspaceDisplayName(workspace)}`}
          className="shrink-0 rounded-md p-1 text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-200"
        >
          <ArrowLeft size={15} />
        </button>
        <span className="shrink-0">
          <AgentBackendMark backend={row.backend} size={13} />
        </span>
        <span className="shrink-0 text-sm font-medium text-neutral-100">{row.agentType}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-neutral-500">{row.description}</span>
        {facts.length > 0 && (
          <span className="hidden md:inline shrink-0 text-[11px] tabular-nums text-neutral-600">
            {facts.join(' · ')}
          </span>
        )}
        {running ? (
          <span className="shrink-0 inline-flex items-center gap-1 text-[11px] text-neutral-400">
            <Loader2 size={11} className="animate-spin" />
            running
          </span>
        ) : (
          <span className="shrink-0 text-[11px] text-neutral-500">{row.status}</span>
        )}
        {running && row.taskId && (
          <button
            type="button"
            aria-label={`Stop subagent: ${row.description}`}
            title="Stop subagent"
            onClick={() => void window.api.chat.stopTask(workspace.id, row.taskId!)}
            className="shrink-0 rounded p-1 text-neutral-500 hover:bg-[var(--surface-2)] hover:text-[var(--danger-400)]"
          >
            <Square size={10} fill="currentColor" />
          </button>
        )}
      </div>

      {/*
        감싸지 않는다. MessageList 의 루트는 `flex-1 min-h-0` 이라 **flex 컬럼의 직계 자식**일
        때만 높이가 잡힌다 — 평범한 div 로 한 겹 두르면 그 제약이 먹지 않아 목록이 내용만큼
        자라고 화면 밖으로 흘러넘친다. ChatView 도 같은 이유로 직접 놓는다.
      */}
      <MessageList
        workspaceId={workspace.id}
        running={running}
        subagentToolId={toolId}
        subagentTranscriptUnavailable={row.backend === 'codex'}
      />

      {address.canSend ? (
        <>
          <Composer
            workspace={workspace}
            subagent={{ toolId, address: address.address, label: row.agentType }}
          />
          {/*
            릴레이의 한계를 감추지 않는다. 이 메시지는 서브에이전트에게 직접 들어가지 않는다 —
            Agent SDK 는 호스트에게 그 채널을 주지 않으므로 부모에게 대신 전하라고 시킨다. 그래서
            부모의 턴이 한 번 돌고, 부모가 그대로 따른다는 보장도 없다. 보낸 뒤에 왜 안 갔는지
            찾게 만드는 것보다 보내기 전에 알려 주는 편이 낫다.
          */}
          <p className="shrink-0 px-4 pb-2 text-[11px] text-neutral-600">
            Relayed through {workspaceDisplayName(workspace)} — the main agent passes it on with
            SendMessage, which costs it a turn.
          </p>
        </>
      ) : (
        <div className="shrink-0 border-t border-[var(--border)] px-4 py-3 text-xs text-neutral-500">
          {address.reason === 'finished'
            ? 'This run has finished — there is nobody left to message.'
            : // 위임 실행·Codex collab 이 여기 걸린다 — SDK 의 task 가 아니라 부를 주소가 없다.
              'This run has no address the main agent can send to, so it cannot be messaged.'}
        </div>
      )}
    </div>
  )
}
