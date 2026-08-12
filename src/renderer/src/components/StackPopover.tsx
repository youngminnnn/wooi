import { useEffect, useMemo, useRef, useState } from 'react'
import { Layers, GitBranch, ExternalLink, GitPullRequestCreate, Check, ScanEye } from 'lucide-react'
import { useStore } from '../store'
import { GithubMark } from './BrandIcons'
import { useGithubDisconnected } from '../lib/github'
import {
  DEFAULT_AGENT_BACKEND,
  isBranchStack,
  orderByStack,
  workspaceDisplayName,
  workspaceStack,
  workspaceStackMembers
} from '@shared/types'
import type { PrState, PrStatus, Workspace } from '@shared/types'

/**
 * PR 상태별 점 색 + 라벨(Sidebar 의 PR_DOT 와 색 일치). Tailwind v4 는 보간한 클래스명을 스캔하지
 * 못하므로 상태마다 전체 클래스 문자열을 그대로 둔다.
 */
const PR_DOT: Record<PrState, { dotClass: string; label: string }> = {
  draft: { dotClass: 'bg-neutral-400', label: 'Draft' },
  review_required: { dotClass: 'bg-[var(--warning-400)]', label: 'Review required' },
  changes_requested: { dotClass: 'bg-[var(--attention-400)]', label: 'Changes requested' },
  approved: { dotClass: 'bg-[var(--success-400)]', label: 'Ready to merge' },
  conflict: { dotClass: 'bg-[var(--danger-400)]', label: 'Conflict' },
  open: { dotClass: 'bg-[var(--accent-400)]', label: 'Open' },
  merged: { dotClass: 'bg-[var(--merged-400)]', label: 'Merged' },
  closed: { dotClass: 'bg-neutral-500', label: 'Closed' }
}

/** 정규화된 스택 행(모델 A·B 공통 렌더용). */
interface Row {
  key: string
  label: string
  branch: string
  depth: number
  isCurrent: boolean
  pr: PrStatus | null
  behind?: number
  ahead?: number
  /** GitHub 이 보고한 스택 내 1-기반 위치. GitHub 스택으로 발행된 PR 에만 있다. */
  ghPosition?: number | null
  onActivate: () => void
  onCreatePr: () => void
}

/**
 * 헤더의 stack 조망·전환 팝오버. 우측 패널을 열지 않고도 스택 전체의 PR 상태를 한눈에 본다.
 * - 모델 B(단일 worktree · N 브랜치): 스택 브랜치 나열 → 클릭 시 체크아웃 전환, PR 없으면 Create PR.
 * - 모델 A(워크스페이스 스택): 멤버 워크스페이스 나열 → 클릭 시 전환, PR 없으면 Create PR.
 * 스택이 아니면(단일 브랜치·워크스페이스) 렌더하지 않는다.
 */
export default function StackPopover({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const workspaces = useStore((s) => s.app!.workspaces)
  const gitStatus = useStore((s) => s.gitStatus)
  const prStatusMap = useStore((s) => s.prStatus)
  const select = useStore((s) => s.selectWorkspace)
  const refreshGit = useStore((s) => s.refreshGit)
  const refreshPr = useStore((s) => s.refreshPr)
  const setPrStatus = useStore((s) => s.setPrStatus)
  const pushToast = useStore((s) => s.pushToast)
  const requireGithub = useStore((s) => s.requireGithub)
  const startReview = useStore((s) => s.startReview)
  const defaultBackend = useStore(
    (s) => s.app?.settings.defaultAgentBackend ?? DEFAULT_AGENT_BACKEND
  )
  const githubDisconnected = useGithubDisconnected()

  const branchMode = isBranchStack(workspace)
  const entries = useMemo(
    () => (branchMode ? workspaceStack(workspace) : []),
    [branchMode, workspace]
  )
  const members = useMemo(() => {
    if (branchMode) return []
    const active = workspaces.filter((w) => w.repoId === workspace.repoId && !w.archived)
    return workspaceStackMembers(active, workspace.id)
  }, [branchMode, workspaces, workspace.repoId, workspace.id])

  // 모델 B: 현재 체크아웃되지 않은 스택 브랜치의 PR 상태는 브랜치별로 따로 조회해 로컬 캐시한다.
  const [branchPr, setBranchPr] = useState<Record<string, PrStatus | null>>({})
  const entryBranches = entries.map((e) => e.branch).join(',')
  const memberIds = members.map((m) => m.id).join(',')

  useEffect(() => {
    if (!open) return
    if (branchMode) {
      void refreshGit(workspace.id)
      for (const b of entryBranches.split(',').filter(Boolean)) {
        void window.api.pr
          .statusForBranch(workspace.id, b)
          .then((st) => setBranchPr((prev) => ({ ...prev, [b]: st })))
      }
    } else {
      for (const id of memberIds.split(',').filter(Boolean)) {
        void refreshGit(id)
        void refreshPr(id)
      }
    }
  }, [open, branchMode, workspace.id, entryBranches, memberIds, refreshGit, refreshPr])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const switchTo = async (branch: string): Promise<void> => {
    // 캐시해 둔 대상 브랜치 PR 로 헤더를 즉시(낙관적) 갱신해 체감 지연을 없앤다(값이 있을 때만).
    if (branch in branchPr) setPrStatus(workspace.id, branchPr[branch])
    const res = await window.api.workspace.switchBranch(workspace.id, branch)
    setOpen(false)
    if (res.error) {
      pushToast('error', res.error)
      void refreshPr(workspace.id) // 실패 시 낙관적 값을 실제 상태로 되돌린다.
      return
    }
    // 현재 브랜치가 바뀌었으니 헤더의 PR 배지·git 배지를 새 브랜치 기준으로 확정 새로고침한다.
    void refreshGit(workspace.id)
    void refreshPr(workspace.id)
  }

  // PR 생성은 gh 를 쓴다 — 미연결이면 연결 모달을 띄우고, 연결이 끝나면 그대로 이어서 연다.
  const createPrFor = (id: string, branch?: string): void => {
    void requireGithub('Opening a pull request needs GitHub.', async () => {
      const res = await window.api.pr.create(id, branch)
      if (res.error) {
        pushToast('error', res.error)
        return
      }
      pushToast('info', 'Opened the PR page in your browser…')
      if (branch) {
        setTimeout(() => {
          void window.api.pr
            .statusForBranch(id, branch)
            .then((st) => setBranchPr((prev) => ({ ...prev, [branch]: st })))
        }, 4000)
      } else {
        setTimeout(() => void refreshPr(id), 4000)
      }
    })
  }

  // 두 모델을 같은 모양의 행 배열로 정규화한다.
  const rows: Row[] = useMemo(() => {
    if (branchMode) {
      const byBranch = new Map(entries.map((e) => [e.branch, e]))
      const depthOf = (branch: string): number => {
        let d = 0
        let cur = byBranch.get(branch)
        const seen = new Set<string>()
        while (cur && byBranch.has(cur.baseBranch) && !seen.has(cur.branch)) {
          seen.add(cur.branch)
          d++
          cur = byBranch.get(cur.baseBranch)
        }
        return d
      }
      return entries.map((e) => ({
        key: e.branch,
        label: e.branch,
        branch: e.branch,
        depth: depthOf(e.branch),
        isCurrent: e.branch === workspace.branch,
        pr: branchPr[e.branch] ?? null,
        // 모델 B 는 워크스페이스 하나가 브랜치 전부를 들고 있어, 저장된 위치는 현재
        // 체크아웃된 브랜치의 것 하나뿐이다. 나머지 행에 순서를 지어내지 않는다 — 이 목록의
        // 배열 순서 자체가 이미 GitHub 이 준 순서다(팝오버 머리글이 그렇게 밝힌다).
        ghPosition: e.branch === workspace.branch ? (workspace.ghStackPosition ?? null) : null,
        onActivate: () => void switchTo(e.branch),
        onCreatePr: () => createPrFor(workspace.id, e.branch)
      }))
    }
    return orderByStack(members).map(({ workspace: m, depth }) => {
      const pr = prStatusMap[m.id] ?? null
      const git = gitStatus[m.id]
      return {
        key: m.id,
        label: workspaceDisplayName(m, pr?.title),
        branch: m.branch,
        depth,
        isCurrent: m.id === workspace.id,
        pr,
        behind: git?.behind,
        ahead: git?.ahead,
        ghPosition: m.ghStackPosition ?? null,
        onActivate: () => {
          if (m.id !== workspace.id) void select(m.id)
          setOpen(false)
        },
        onCreatePr: () => createPrFor(m.id)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    branchMode,
    entries,
    members,
    branchPr,
    prStatusMap,
    gitStatus,
    workspace.id,
    workspace.branch
  ])

  const count = branchMode ? entries.length : members.length

  /**
   * 리뷰가 볼 PR 들. **행 순서 그대로**(아래→위) 뽑는다 — 이 팝오버가 이미 두 스택 모델을
   * 같은 순서로 정규화해 두었으므로, 화면이 보여 준 스택과 리뷰가 보는 스택이 어긋나지 않는다.
   * 병합·닫힘은 리뷰할 것이 없으므로 뺀다.
   */
  const stackPrNumbers = rows
    .filter((r) => r.pr && r.pr.state !== 'merged' && r.pr.state !== 'closed')
    .map((r) => r.pr!.number)
  const missingPrCount = count - stackPrNumbers.length

  const reviewStack = async (): Promise<void> => {
    if (stackPrNumbers.length < 2) return
    await requireGithub('Reviewing a stack needs GitHub.', async () => {
      await startReview({
        repoId: workspace.repoId,
        prNumbers: stackPrNumbers,
        prompt: 'Review this stack.',
        agentBackend: defaultBackend
      })
    })
  }

  if (count < 2) return <></>

  const openPrCount = stackPrNumbers.length

  // GitHub 이 서버에 스택 객체를 들고 있으면 그 번호를 밝힌다. 이 스택의 순서가 Wooi 의 추측이
  // 아니라 GitHub 이 알려 준 것이라는 뜻이라, 사용자가 github.com 에서 같은 스택을 찾을 수 있다.
  // 모델 A 는 멤버마다 값이 따로 있으므로 아무 멤버에게서나 집는다(같은 스택이면 번호가 같다).
  const ghStackNumber =
    workspace.ghStackNumber ?? members.find((m) => m.ghStackNumber != null)?.ghStackNumber ?? null

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1.5 text-xs px-2 py-1 rounded-md bg-[var(--surface)] border border-[var(--border)] text-neutral-300 hover:border-[var(--border-strong)]"
        title={
          branchMode
            ? 'Branch stack in this worktree — view PRs & switch branches'
            : 'Stacked PRs in this stack — view status & switch'
        }
      >
        <Layers size={12} className="text-[var(--accent-400)]" />
        <span className="font-medium">Stack</span>
        <span className="opacity-60 tabular-nums">
          {count}
          {openPrCount > 0 ? ` · ${openPrCount} PR` : ''}
        </span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-1 w-80 overflow-hidden rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] py-1 shadow-xl"
        >
          <div className="px-3 py-1.5 text-[11px] uppercase tracking-wider text-neutral-500">
            {branchMode ? `Branch stack · ${count} branches` : `Stack · ${count} workspaces`}
            {ghStackNumber != null && (
              <span
                className="ml-1 text-[var(--accent-300)]/80"
                title="This chain is a stack on GitHub — the order below is GitHub's, not inferred from PR base links"
              >
                · GitHub stack #{ghStackNumber}
              </span>
            )}
          </div>

          {/* 스택 전체를 한 번에 리뷰한다. 여기 두는 이유는 이 팝오버가 이미 **두 스택 모델을
              같은 목록으로 정규화**해 두었기 때문이다 — 리뷰가 볼 PR 은 그 목록에서 그대로 나온다. */}
          <button
            onClick={() => {
              setOpen(false)
              void reviewStack()
            }}
            disabled={stackPrNumbers.length < 2}
            title={
              stackPrNumbers.length < 2
                ? 'At least two layers of this stack need a pull request to review it as a stack.'
                : `Review #${stackPrNumbers.join(', #')} as one stack — is the split correct?`
            }
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-neutral-200 hover:bg-[var(--surface-2)] disabled:cursor-not-allowed disabled:text-neutral-600"
          >
            <ScanEye size={13} className="shrink-0 text-[var(--info-400)]" />
            <span className="min-w-0 flex-1">
              Review the whole stack
              {missingPrCount > 0 && (
                <span className="ml-1 text-neutral-500">
                  ({stackPrNumbers.length} of {count} have a PR)
                </span>
              )}
            </span>
          </button>
          <div className="my-1 border-t border-[var(--border)]" />
          <div className="max-h-96 overflow-y-auto">
            {rows.map((r) => {
              const dot = r.pr ? PR_DOT[r.pr.state] : null
              return (
                <div
                  key={r.key}
                  className={
                    'group/row flex items-center gap-2 pr-2 py-1.5 ' +
                    (r.isCurrent ? 'bg-[var(--surface-2)]' : 'hover:bg-[var(--surface-2)]')
                  }
                  style={{ paddingLeft: 12 + r.depth * 14 }}
                >
                  <button
                    onClick={r.onActivate}
                    className="flex-1 min-w-0 text-left flex flex-col gap-0.5"
                    title={
                      r.isCurrent
                        ? 'Current'
                        : branchMode
                          ? 'Switch to this branch (checkout)'
                          : 'Switch to this workspace'
                    }
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className={
                          'h-2 w-2 rounded-full shrink-0 ' + (dot ? dot.dotClass : 'bg-neutral-600')
                        }
                        title={dot ? dot.label : 'No pull request'}
                      />
                      <span
                        className={
                          'truncate text-xs ' +
                          (r.isCurrent ? 'text-neutral-100' : 'text-neutral-300')
                        }
                      >
                        {r.label}
                      </span>
                      {r.isCurrent && (
                        <Check size={11} className="shrink-0 text-[var(--accent-400)]" />
                      )}
                    </div>
                    <div className="flex items-center gap-1 text-[11px] text-neutral-500 min-w-0">
                      <GitBranch size={9} className="shrink-0" />
                      <span className="truncate">{r.branch}</span>
                      {r.pr && (
                        <span className="shrink-0 tabular-nums opacity-80">
                          · #{r.pr.number} {r.pr.label}
                        </span>
                      )}
                      {r.ghPosition != null && (
                        <span
                          className="shrink-0 tabular-nums text-[var(--accent-300)]/70"
                          title={`Position ${r.ghPosition} in GitHub's stack (1 is closest to the base branch)`}
                        >
                          · L{r.ghPosition}
                        </span>
                      )}
                      {r.behind !== undefined && r.behind > 0 && (
                        <span
                          className="shrink-0 tabular-nums text-[var(--warning-400)]/80"
                          title={`${r.behind} behind`}
                        >
                          ↓{r.behind}
                        </span>
                      )}
                      {r.ahead !== undefined && r.ahead > 0 && (
                        <span className="shrink-0 tabular-nums" title={`${r.ahead} ahead`}>
                          ↑{r.ahead}
                        </span>
                      )}
                    </div>
                  </button>
                  {r.pr ? (
                    <button
                      onClick={() => void window.api.openExternal(r.pr!.url)}
                      className="shrink-0 grid h-6 w-6 place-items-center rounded text-neutral-500 hover:bg-[var(--surface-3)] hover:text-neutral-200"
                      title={`Open PR #${r.pr.number} in browser`}
                    >
                      <ExternalLink size={13} />
                    </button>
                  ) : (
                    // gh 미연결이면 버튼을 숨기지 않고 "Connect" 로 바꿔 노출한다 — 누르면 연결
                    // 모달이 뜨고, 연결이 끝나면 원래대로 PR 페이지가 열린다.
                    <button
                      onClick={r.onCreatePr}
                      className={
                        'shrink-0 flex items-center gap-1 text-[11px] px-1.5 py-1 rounded hover:bg-[var(--surface-3)] ' +
                        (githubDisconnected ? 'text-neutral-400' : 'text-[var(--accent-300)]')
                      }
                      title={
                        githubDisconnected
                          ? 'Connect GitHub to open a pull request for this branch'
                          : 'Open a pull request for this branch'
                      }
                    >
                      {githubDisconnected ? (
                        <>
                          <GithubMark size={11} />
                          Connect
                        </>
                      ) : (
                        <>
                          <GitPullRequestCreate size={12} />
                          PR
                        </>
                      )}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
