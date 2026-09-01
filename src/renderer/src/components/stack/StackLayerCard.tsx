import { useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  GitBranch,
  GitCommitVertical,
  Loader2
} from 'lucide-react'
import type { CommitEntry, StackCascadeStepKind, Workspace } from '@shared/types'
import type { StackLayer, StackLayerState, StackTrainCell } from '../../lib/stackView'
import { PR_DOT } from '../../lib/workspaceStatus'
import { agoLabel } from '../../lib/rateLimit'
import { useNow } from '../../lib/useNow'
import { useStore } from '../../store'
import BaseSyncControl from '../BaseSyncControl'
import CommitMoveModal from '../CommitMoveModal'
import StackBaseBanner from '../StackBaseBanner'
import StackSyncBanner from '../StackSyncBanner'

/** 진행 중인 캐스케이드 단계의 사람 말. StackTrainModal 의 단계 어휘와 같은 뜻을 쓴다. */
const STEP_LABEL: Record<StackCascadeStepKind, string> = {
  retarget: 'Retargeting the pull request',
  recover: 'Reopening the pull request',
  restack: 'Restacking',
  merge: 'Merging',
  'cherry-pick': 'Cherry-picking',
  drop: 'Dropping'
}

/** 끝난 단계의 결과 어휘. 색은 토큰으로만 — 상태별 전체 클래스 문자열을 그대로 둔다. */
const DONE_TONE: Record<string, { label: string; className: string }> = {
  ok: { label: 'Done', className: 'text-[var(--success-400)] bg-[var(--success-500)]/10' },
  skipped: { label: 'Skipped', className: 'text-neutral-400 bg-[var(--surface-2)]' },
  conflict: { label: 'Conflict', className: 'text-[var(--danger-300)] bg-[var(--danger-500)]/10' },
  failed: { label: 'Failed', className: 'text-[var(--danger-300)] bg-[var(--danger-500)]/10' },
  diverged: {
    label: 'Diverged',
    className: 'text-[var(--warning-300)] bg-[var(--warning-500)]/10'
  }
}

const chipCls = 'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs'

function TrainChip({ cell }: { cell: StackTrainCell }): React.JSX.Element | null {
  if (cell.state === 'none') return null
  if (cell.state === 'running') {
    return (
      <span
        className={`${chipCls} text-[var(--info-300)] bg-[var(--info-500)]/10`}
        title="This layer is being processed by the merge train right now"
      >
        <Loader2 size={9} className="animate-spin" />
        {STEP_LABEL[cell.kind]}…
      </span>
    )
  }
  if (cell.state === 'done') {
    const tone = DONE_TONE[cell.status] ?? DONE_TONE.skipped
    return (
      <span className={`${chipCls} ${tone.className}`} title={cell.message ?? 'Merge train result'}>
        Train · {tone.label}
      </span>
    )
  }
  if (cell.state === 'blocked') {
    return (
      <span
        className={`${chipCls} text-[var(--warning-300)] bg-[var(--warning-500)]/10`}
        title={cell.reason}
      >
        Train blocked
      </span>
    )
  }
  return (
    <span
      className={`${chipCls} text-[var(--accent-300)] bg-[var(--accent-400)]/10`}
      title="The merge train would merge this layer"
    >
      Train ready
    </span>
  )
}

/**
 * 스택의 한 층. 브랜치·PR·behind·base 어긋남·변경 요약·머지 트레인 상태를 한 카드에 모으고,
 * 그 층에 대해 할 수 있는 기존 액션(base 동기화·캐스케이드 승인·커밋 내리기)을 그대로 붙인다.
 *
 * 액션은 새로 만들지 않는다 — 이미 다른 자리에 있던 컴포넌트를 여기서도 마운트할 뿐이다.
 */
export default function StackLayerCard({
  layer,
  index,
  total,
  state,
  workspace,
  parentWorkspace,
  branchMode,
  loading,
  expanded,
  onToggle,
  onRefresh
}: {
  layer: StackLayer
  /** 바닥부터 0. 화면에는 1-기반으로 쓴다. */
  index: number
  total: number
  state: StackLayerState
  /** 이 층의 워크스페이스. 모델 B 는 층들이 같은 것을 나눠 쓴다. */
  workspace: Workspace | undefined
  /** 커밋을 내려보낼 아래 층의 워크스페이스(모델 A 에만 있다). */
  parentWorkspace: Workspace | undefined
  branchMode: boolean
  loading: boolean
  expanded: boolean
  onToggle: () => void
  onRefresh: () => Promise<void>
}): React.JSX.Element {
  const now = useNow(60_000)
  const selectWorkspace = useStore((s) => s.selectWorkspace)
  const [moving, setMoving] = useState<CommitEntry | null>(null)

  const pr = state.pr
  const dot = pr ? PR_DOT[pr.state] : null
  const behind = state.git?.behind ?? 0
  const commits = state.commits
  const diff = state.diff

  return (
    <section
      className="relative"
      style={{ marginLeft: layer.depth * 16 }}
      data-stack-layer={layer.key}
    >
      <div
        className={
          'rounded-lg border ' +
          (layer.isAnchor
            ? 'border-[var(--accent-400)]/40 bg-[var(--accent-400)]/5'
            : 'border-[var(--border)] bg-[var(--surface)]')
        }
      >
        <div className="flex items-start gap-2 px-3 py-2">
          <button
            onClick={onToggle}
            aria-label={expanded ? 'Collapse this layer' : 'Expand this layer'}
            className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded text-neutral-500 hover:bg-[var(--surface-2)] hover:text-neutral-200"
          >
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>

          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="shrink-0 text-2xs uppercase tracking-wider text-neutral-500 tabular-nums">
                Layer {index + 1} of {total}
              </span>
              <span className="truncate text-sm text-neutral-100">{layer.label}</span>
            </div>

            <div className="mt-1 flex items-center gap-1.5 text-xs text-neutral-400">
              <GitBranch size={11} className="shrink-0 text-neutral-500" />
              <span className="truncate font-mono">{layer.branch}</span>
              <span aria-hidden="true" className="text-neutral-600">
                on
              </span>
              <span className="truncate font-mono text-neutral-500">{layer.baseBranch}</span>
            </div>

            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {diff && (
                <span
                  className={`${chipCls} text-neutral-400 bg-[var(--surface-2)] tabular-nums`}
                  title={`${diff.files} file${diff.files === 1 ? '' : 's'} changed against ${layer.baseBranch}`}
                >
                  <span className="text-[var(--success-400)]">+{diff.additions}</span>
                  <span className="text-[var(--danger-400)]">−{diff.deletions}</span>
                  <span className="text-neutral-500">
                    · {diff.files} file{diff.files === 1 ? '' : 's'}
                  </span>
                </span>
              )}
              {behind > 0 && (
                <span
                  className={`${chipCls} text-[var(--warning-300)] bg-[var(--warning-500)]/10 tabular-nums`}
                  title={`This layer is ${behind} commit${behind === 1 ? '' : 's'} behind ${layer.baseBranch}`}
                >
                  {behind} behind
                </span>
              )}
              {state.git?.conflicted && (
                <span
                  className={`${chipCls} text-[var(--danger-300)] bg-[var(--danger-500)]/10`}
                  title="This worktree has unresolved conflicts"
                >
                  Conflict
                </span>
              )}
              {layer.baseDrift && (
                <span
                  className={`${chipCls} text-[var(--warning-300)] bg-[var(--warning-500)]/10`}
                  title={`This layer records ${layer.baseDrift.actual} as its base, but the layer below it is ${layer.baseDrift.expected} — its diff will swallow the layer below.`}
                >
                  Base drifted
                </span>
              )}
              {layer.prBaseMismatch && (
                <span
                  className={`${chipCls} text-[var(--warning-300)] bg-[var(--warning-500)]/10`}
                  title={`Pull request #${layer.prBaseMismatch.prNumber} targets ${layer.prBaseMismatch.prBase}, not ${layer.prBaseMismatch.expectedBase}.`}
                >
                  PR base drifted
                </span>
              )}
              <TrainChip cell={state.train} />
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {pr && dot ? (
              <button
                onClick={() => void window.api.openExternal(pr.url)}
                title={`PR #${pr.number} — ${dot.label}. Open in your browser.`}
                className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-neutral-300 hover:bg-[var(--surface-2)] hover:text-neutral-100"
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot.dotClass}`} />
                <span className="tabular-nums">#{pr.number}</span>
                <ExternalLink size={11} className="text-neutral-500" />
              </button>
            ) : (
              <span
                className="px-1 text-2xs text-neutral-600"
                title="This layer has no pull request"
              >
                No PR
              </span>
            )}
            {workspace && layer.live && state.git && (
              <BaseSyncControl
                workspace={workspace}
                git={state.git}
                prState={pr?.state}
                prNeedsBaseUpdate={pr?.needsBaseUpdate}
                refresh={onRefresh}
              />
            )}
            {!branchMode && !layer.isAnchor && (
              <button
                onClick={() => void selectWorkspace(layer.workspaceId)}
                title="Open this layer's workspace (leaves the stack view)"
                className="h-7 shrink-0 rounded-md border border-[var(--border-2)] px-2 text-xs text-neutral-300 hover:bg-[var(--surface-2)]"
              >
                Open
              </button>
            )}
          </div>
        </div>

        {/* 이 층에 걸린 승인 배너들. 대화 화면에 있던 것을 그대로 데려온다 — 스택이 어긋난 것을
            여기서 보고 여기서 고칠 수 있어야, 지도와 액션이 갈라지지 않는다. */}
        {workspace && layer.live && (
          <div className="px-3 pb-1 empty:hidden">
            <StackSyncBanner workspace={workspace} />
            <StackBaseBanner workspace={workspace} />
          </div>
        )}

        {expanded && (
          <div className="border-t border-[var(--border)] px-3 py-2">
            {!layer.live ? (
              <p className="text-xs text-neutral-500">
                Commits and change totals are only available for the branch this worktree has
                checked out.
              </p>
            ) : loading && !commits ? (
              <p className="flex items-center gap-1.5 text-xs text-neutral-500">
                <Loader2 size={11} className="animate-spin" />
                Reading this layer…
              </p>
            ) : !commits || commits.length === 0 ? (
              <p className="text-xs text-neutral-500">No commits in this layer.</p>
            ) : (
              <ul className="divide-y divide-[var(--border)]">
                {commits.map((commit) => (
                  <li key={commit.sha} className="flex items-start gap-2.5 py-1.5">
                    <GitCommitVertical size={13} className="mt-0.5 shrink-0 text-neutral-600" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="shrink-0 font-mono text-2xs text-[var(--info-400)]">
                          {commit.shortSha}
                        </span>
                        <span className="truncate text-xs text-neutral-200">{commit.subject}</span>
                      </div>
                      <div className="mt-0.5 flex gap-1.5 text-2xs text-neutral-600">
                        <span className="truncate">{commit.authorName}</span>
                        <span aria-hidden="true">·</span>
                        <span
                          className="shrink-0"
                          title={new Date(commit.authoredAt).toLocaleString()}
                        >
                          {agoLabel(now - commit.authoredAt)}
                        </span>
                      </div>
                    </div>
                    {/* 커밋 내리기는 모델 A 에서, 아래 층이 있을 때만 가능하다(CommitsPanel 과 같은 조건). */}
                    {!branchMode && parentWorkspace && (
                      <button
                        onClick={() => setMoving(commit)}
                        title={`Move into ${parentWorkspace.branch}`}
                        className="shrink-0 rounded-md border border-[var(--border-2)] px-1.5 py-0.5 text-2xs text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-200"
                      >
                        Move down
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {moving && (
        <CommitMoveModal
          workspaceId={layer.workspaceId}
          commit={moving}
          onClose={() => {
            setMoving(null)
            void onRefresh()
          }}
        />
      )}
    </section>
  )
}
