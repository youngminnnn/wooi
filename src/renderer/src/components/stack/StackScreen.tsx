import { useEffect, useMemo, useState } from 'react'
import { GitMerge, Layers, Loader2, RefreshCw, ScanEye, X } from 'lucide-react'
import { isBranchStack } from '@shared/types'
import type { CommitEntry, PrStatus, StackTrainPlan } from '@shared/types'
import {
  buildStackLayers,
  diffTotals,
  reviewablePrNumbers,
  stackSummary,
  trainCellFor
} from '../../lib/stackView'
import type { StackDiffTotals, StackLayerState } from '../../lib/stackView'
import { useDefaultBackend } from '../../lib/backends'
import { useStore } from '../../store'
import StackTrainModal from '../StackTrainModal'
import StackLayerCard from './StackLayerCard'

/** 층별로 따로 읽어 오는 것(커밋·변경 요약). PR·git 은 스토어가 이미 들고 있다. */
interface FetchedLayer {
  commits: CommitEntry[]
  diff: StackDiffTotals | null
}

const chipCls = 'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs'

/**
 * 스택 전체를 한 화면으로 본다. 층을 세로로 이어 놓고 층마다 브랜치·PR 상태·커밋·변경 요약·
 * base 어긋남·behind·머지 트레인 상태를 같은 자리에 둔다.
 *
 * 새로 만드는 화면이 아니라 **모으는 화면**이다 — 데이터는 이미 있던 채널에서, 액션은 이미
 * 있던 컴포넌트(`BaseSyncControl`·`StackTrainModal`·`CommitMoveModal`·배너들)에서 온다.
 * 기존 진입점(헤더의 `StackPopover` 등)은 그대로 남는다.
 */
export default function StackScreen({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const workspaces = useStore((s) => s.app!.workspaces)
  const gitStatus = useStore((s) => s.gitStatus)
  const prStatusMap = useStore((s) => s.prStatus)
  const stackProgress = useStore((s) => s.stackProgress)
  const closeStackView = useStore((s) => s.closeStackView)
  const refreshGit = useStore((s) => s.refreshGit)
  const refreshPr = useStore((s) => s.refreshPr)
  const requireGithub = useStore((s) => s.requireGithub)
  const startReview = useStore((s) => s.startReview)
  const defaultBackend = useDefaultBackend()

  const anchor = workspaces.find((w) => w.id === workspaceId)
  // 손으로 memo 하지 않는다 — React Compiler 가 맡는다. 층 목록이 매 렌더 새 배열이어도
  // effect 는 아래의 문자열 서명에 걸려 있어 다시 돌지 않는다.
  const layers = buildStackLayers(workspaces, workspaceId)
  const branchMode = !!anchor && isBranchStack(anchor)

  const [fetched, setFetched] = useState<Record<string, FetchedLayer>>({})
  const [branchPr, setBranchPr] = useState<Record<string, PrStatus | null>>({})
  const [plan, setPlan] = useState<StackTrainPlan | null>(null)
  const [loading, setLoading] = useState(true)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [trainOpen, setTrainOpen] = useState(false)
  const [nonce, setNonce] = useState(0)

  /**
   * 읽어 올 대상을 문자열로 굳혀 effect 의 의존성으로 쓴다 — `layers` 는 매 렌더 새 배열이라
   * 그대로 의존성에 넣으면 효과가 끝없이 다시 돈다(스택 팝오버가 같은 이유로 같은 모양을 쓴다).
   */
  const liveTargets = layers
    .filter((l) => l.live)
    .map((l) => `${l.key} ${l.workspaceId}`)
    .join('|')
  const allBranches = layers.map((l) => l.branch).join(',')
  /** 트레인은 "바닥부터 여기까지" 를 머지한다 — 꼭대기 층을 목표로 잡아야 스택 전체를 덮는다. */
  const trainTargetId = layers.at(-1)?.workspaceId ?? null
  const trainTargetBranch = layers.at(-1)?.branch ?? null

  useEffect(() => {
    let alive = true
    const targets = liveTargets
      .split('|')
      .filter(Boolean)
      .map((entry) => entry.split(' ') as [string, string])
    void (async () => {
      setLoading(true)
      const rows = await Promise.all(
        targets.map(async ([key, id]) => {
          try {
            const [commits, diff] = await Promise.all([
              window.api.stack.commitsList(id),
              window.api.git.diff(id)
            ])
            return [key, { commits, diff: diffTotals(diff) }] as const
          } catch {
            // 한 층을 못 읽었다고 나머지를 비우지 않는다 — 그 칸만 빈 채로 둔다.
            return [key, { commits: [], diff: null }] as const
          }
        })
      )
      if (!alive) return
      setFetched(Object.fromEntries(rows))
      setLoading(false)
    })()
    return () => {
      alive = false
    }
  }, [liveTargets, nonce])

  // 모델 B: 체크아웃되지 않은 층의 PR 은 스토어에 없다 — 브랜치별로 따로 읽는다.
  useEffect(() => {
    if (!branchMode) return
    let alive = true
    for (const branch of allBranches.split(',').filter(Boolean)) {
      void window.api.pr.statusForBranch(workspaceId, branch).then((status) => {
        if (alive) setBranchPr((prev) => ({ ...prev, [branch]: status }))
      })
    }
    return () => {
      alive = false
    }
  }, [branchMode, allBranches, workspaceId, nonce])

  useEffect(() => {
    if (!trainTargetId) return
    let alive = true
    void window.api.stack
      .trainPlan(trainTargetId)
      .then((next) => {
        // 층이 하나뿐이면 계획이 서지 않는다(에러 문자열). 그건 보여 줄 상태가 아니라 없음이다.
        if (alive) setPlan(next.error ? null : next)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [trainTargetId, nonce])

  const refreshAll = async (): Promise<void> => {
    const ids = new Set(layers.map((l) => l.workspaceId))
    await Promise.all([...ids].flatMap((id) => [refreshGit(id), refreshPr(id)]))
    setNonce((n) => n + 1)
  }

  const trainProgress = trainTargetId ? stackProgress[trainTargetId] : null

  const states: Record<string, StackLayerState> = useMemo(() => {
    const out: Record<string, StackLayerState> = {}
    for (const layer of layers) {
      out[layer.key] = {
        pr: branchMode
          ? (branchPr[layer.branch] ?? null)
          : (prStatusMap[layer.workspaceId] ?? null),
        git: layer.live ? (gitStatus[layer.workspaceId] ?? null) : null,
        commits: fetched[layer.key]?.commits ?? null,
        diff: fetched[layer.key]?.diff ?? null,
        train: trainCellFor(layer.branch, plan, trainProgress)
      }
    }
    return out
  }, [layers, branchMode, branchPr, prStatusMap, gitStatus, fetched, plan, trainProgress])

  const summary = useMemo(() => stackSummary(layers, states), [layers, states])
  const prNumbers = useMemo(() => reviewablePrNumbers(layers, states), [layers, states])

  const reviewStack = async (): Promise<void> => {
    if (!anchor || prNumbers.length < 2) return
    await requireGithub('Reviewing a stack needs GitHub.', async () => {
      await startReview({
        repoId: anchor.repoId,
        prNumbers,
        prompt: 'Review this stack.',
        agentBackend: defaultBackend
      })
    })
  }

  const byId = useMemo(() => new Map(workspaces.map((w) => [w.id, w])), [workspaces])

  return (
    <div className="flex flex-1 flex-col min-w-0 bg-[var(--bg)]">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3">
        <Layers size={14} className="shrink-0 text-[var(--accent-400)]" />
        <span className="shrink-0 text-sm font-medium text-neutral-100">Stack</span>
        <span className="shrink-0 text-xs text-neutral-500 tabular-nums">
          {summary.layers} layer{summary.layers === 1 ? '' : 's'}
        </span>

        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {summary.openPrs > 0 && (
            <span
              className={`${chipCls} text-[var(--open-400)] bg-[var(--surface-2)] tabular-nums`}
              title="Layers with a pull request that is still open"
            >
              {summary.openPrs} PR open
            </span>
          )}
          {summary.missingPrs > 0 && (
            <span
              className={`${chipCls} text-neutral-400 bg-[var(--surface-2)] tabular-nums`}
              title="Layers that have no pull request yet"
            >
              {summary.missingPrs} without a PR
            </span>
          )}
          {summary.behind > 0 && (
            <span
              className={`${chipCls} text-[var(--warning-300)] bg-[var(--warning-500)]/10 tabular-nums`}
              title="Layers that are behind the layer below them"
            >
              {summary.behind} behind
            </span>
          )}
          {summary.drifted > 0 && (
            <span
              className={`${chipCls} text-[var(--warning-300)] bg-[var(--warning-500)]/10 tabular-nums`}
              title="Layers whose base is not the layer below them"
            >
              {summary.drifted} base drifted
            </span>
          )}
          {summary.blocked > 0 && (
            <span
              className={`${chipCls} text-[var(--danger-300)] bg-[var(--danger-500)]/10 tabular-nums`}
              title="Layers the merge train cannot merge yet"
            >
              {summary.blocked} blocked
            </span>
          )}
          {(summary.additions > 0 || summary.deletions > 0) && (
            <span
              className={`${chipCls} text-neutral-400 bg-[var(--surface-2)] tabular-nums`}
              title="Total change across every layer of this stack"
            >
              <span className="text-[var(--success-400)]">+{summary.additions}</span>
              <span className="text-[var(--danger-400)]">&minus;{summary.deletions}</span>
            </span>
          )}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <button
            onClick={() => void reviewStack()}
            disabled={prNumbers.length < 2}
            title={
              prNumbers.length < 2
                ? 'Reviewing a stack needs at least two open pull requests'
                : `Review #${prNumbers.join(' to #')} as one stack`
            }
            className="flex h-7 items-center gap-1.5 rounded-md border border-[var(--border-2)] px-2 text-xs text-neutral-300 hover:bg-[var(--surface-2)] disabled:cursor-not-allowed disabled:text-neutral-600 disabled:hover:bg-transparent"
          >
            <ScanEye size={12} />
            Review stack
          </button>
          <button
            onClick={() => setTrainOpen(true)}
            disabled={!trainTargetId}
            title={
              trainTargetBranch
                ? `Merge this stack from the bottom up to ${trainTargetBranch}`
                : 'There is no layer to merge'
            }
            className="flex h-7 items-center gap-1.5 rounded-md border border-[var(--border-2)] px-2 text-xs text-neutral-300 hover:bg-[var(--surface-2)] disabled:cursor-not-allowed disabled:text-neutral-600 disabled:hover:bg-transparent"
          >
            <GitMerge size={12} />
            Merge train
          </button>
          <button
            onClick={() => void refreshAll()}
            title="Re-read every layer"
            aria-label="Refresh the stack"
            className="grid h-7 w-7 place-items-center rounded-md text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100 active:scale-90"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          </button>
          <button
            onClick={closeStackView}
            title="Close the stack view"
            aria-label="Close the stack view"
            className="grid h-7 w-7 place-items-center rounded-md text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100 active:scale-90"
          >
            <X size={15} />
          </button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {layers.length === 0 ? (
          <p className="grid h-full place-items-center text-sm text-neutral-500">
            This workspace is gone.
          </p>
        ) : layers.length < 2 ? (
          <p className="grid h-full place-items-center text-sm text-neutral-500">
            {layers[0].label} is not stacked on anything &mdash; there is nothing to lay out.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {layers.map((layer, index) => (
              <StackLayerCard
                key={layer.key}
                layer={layer}
                index={index}
                total={layers.length}
                state={states[layer.key]}
                workspace={byId.get(layer.workspaceId)}
                parentWorkspace={layer.parentKey ? byId.get(layer.parentKey) : undefined}
                branchMode={branchMode}
                loading={loading}
                expanded={!collapsed[layer.key]}
                onToggle={() =>
                  setCollapsed((prev) => ({ ...prev, [layer.key]: !prev[layer.key] }))
                }
                onRefresh={refreshAll}
              />
            ))}
          </div>
        )}
      </main>

      {trainOpen && trainTargetId && (
        <StackTrainModal workspaceId={trainTargetId} onClose={() => setTrainOpen(false)} />
      )}
    </div>
  )
}
