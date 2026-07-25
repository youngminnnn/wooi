import { spawn } from 'node:child_process'
import type {
  PrCheck,
  PrCheckState,
  PrChecks,
  PrMergeMethod,
  PrState,
  PrStatus
} from '@shared/types'

/**
 * GitHub PR 상태를 gh CLI 로 조회한다.
 *
 * 조회 기준은 workspace worktree 의 "현재 브랜치" 다 — worktree cwd 에서 인자 없이
 * `gh pr view` 를 실행하면 gh 가 현재 브랜치에 연결된 PR 을 찾아준다. 대화 기록에서 URL 을
 * 긁는 방식은 무관한 PR(다른 리포·예전 PR)을 잘못 집을 수 있어 쓰지 않는다.
 * gh 는 homebrew 경로라 GUI 앱 PATH 에 없으므로 로그인 셸로 실행한다.
 */

interface GhPr {
  number: number
  url: string
  title: string
  state: string // OPEN | CLOSED | MERGED
  isDraft: boolean
  reviewDecision: string // REVIEW_REQUIRED | CHANGES_REQUESTED | APPROVED | ''
  mergeable: string // MERGEABLE | CONFLICTING | UNKNOWN
  // BEHIND | BLOCKED | CLEAN | DIRTY | DRAFT | HAS_HOOKS | UNKNOWN | UNSTABLE
  mergeStateStatus: string
}

function runLoginShell(
  command: string,
  cwd?: string
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh'
    // gh 는 GITHUB_TOKEN/GH_TOKEN 이 있으면 keyring 로그인보다 우선해 그 토큰을 쓴다.
    // 앱이 dev 터미널·에이전트 환경에서 떠 이 변수를 물려받으면, SSO 미인증 토큰이
    // 정상 로그인 자격증명을 가려 모든 gh 조회가 조직 SAML 에러로 실패한다 → PR 이
    // 있어도 못 찾고 "Create PR" 이 계속 뜬다. 이 변수만 비워 gh 가 본래 자격증명
    // 체인(keyring 등)을 쓰게 한다.
    const env = { ...process.env }
    delete env.GITHUB_TOKEN
    delete env.GH_TOKEN
    const proc = spawn(shell, ['-lc', command], { ...(cwd ? { cwd } : {}), env })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    proc.on('error', () => resolve({ stdout, stderr, code: 1 }))
    proc.on('close', (code) => resolve({ stdout, stderr, code }))
  })
}

/**
 * PR 의 세분화된 상태를 도출한다.
 * 종결 상태(merged/closed) → draft 순으로 먼저 거르고, 열린 PR 중에서는 병합 충돌을
 * 리뷰 결정보다 우선한다 — 충돌은 리뷰 승인 여부와 무관하게 병합을 막는 실행 차단 요인이라
 * 가장 먼저 드러나야 한다.
 *
 * reviewDecision 만으로 'approved'(Ready to merge)를 판단하면 안 된다 — 빈 문자열은 "필수
 * 리뷰 없음"일 수도 있지만, 리포가 ruleset(신형 브랜치 보호)으로 필수 리뷰를 걸어둔 경우
 * gh 가 reviewDecision 을 빈 값으로 돌려주기도 한다. 즉 승인 전인데도 빈 값이 와서, 이를
 * 무조건 Ready to merge 로 보면 병합 불가 PR 이 Ready 로 잘못 뜬다.
 *
 * 그래서 실제 병합 가능 여부는 GitHub 가 계산하는 mergeStateStatus 를 권위 있는 신호로 쓴다.
 * BLOCKED(필수 리뷰·체크 미충족) 나 BEHIND(base 보다 뒤처짐) 면 reviewDecision 이 비어
 * 있어도 Ready to merge 로 보지 않는다.
 */
function stateFor(pr: GhPr): PrState {
  if (pr.state === 'MERGED') return 'merged'
  if (pr.state === 'CLOSED') return 'closed'
  if (pr.isDraft) return 'draft'
  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') return 'conflict'

  // 명시적 리뷰 결정이 있으면 그대로 따른다(필수 리뷰가 정상 노출되는 경우).
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changes_requested'
  if (pr.reviewDecision === 'REVIEW_REQUIRED') return 'review_required'

  // 여기까지 오면 reviewDecision 은 APPROVED 또는 ''(필수 리뷰 없음/ruleset 로 미노출).
  // 병합 차단 여부는 mergeStateStatus 로 확정한다.
  switch (pr.mergeStateStatus) {
    case 'CLEAN':
    case 'HAS_HOOKS':
    case 'UNSTABLE':
      // 병합 가능(UNSTABLE = 필수 외 체크만 실패/대기 → GitHub 도 병합 허용).
      return 'approved'
    case 'BLOCKED':
      // 필수 리뷰·체크 미충족으로 병합 차단 → 아직 Ready 아님.
      return 'review_required'
    case 'BEHIND':
      // base 보다 뒤처져 업데이트 필요 → 아직 Ready 아님.
      return 'open'
    default:
      // UNKNOWN 등 GitHub 가 아직 계산 중 → 명시적 승인이 있으면 approved,
      // 아니면 보수적으로 open 으로 둔다(섣불리 Ready to merge 로 띄우지 않는다).
      return pr.reviewDecision === 'APPROVED' ? 'approved' : 'open'
  }
}

const PR_LABELS: Record<PrState, string> = {
  draft: 'Draft',
  review_required: 'Review required',
  changes_requested: 'Changes requested',
  approved: 'Ready to merge',
  conflict: 'Conflict',
  open: 'Open',
  merged: 'Merged',
  closed: 'Closed'
}

/**
 * PR 상태를 조회한다. branch 를 주면 그 브랜치의 PR 을(worktree 의 현재 브랜치가 아니어도), 없으면
 * 현재 브랜치의 PR 을 조회한다(모델 B 스택 조망은 브랜치별로 호출). 브랜치명은 sanitize 되어 있어
 * 안전하지만 셸 해석 방지를 위해 작은따옴표로 감싼다.
 */
export async function getPrStatus(worktreePath: string, branch?: string): Promise<PrStatus | null> {
  const target = branch ? ` '${branch}'` : ''
  const { stdout, code } = await runLoginShell(
    `gh pr view${target} --json number,url,title,state,isDraft,reviewDecision,mergeable,mergeStateStatus`,
    worktreePath
  )
  if (code !== 0) return null
  try {
    const pr = JSON.parse(stdout.trim()) as GhPr
    const state = stateFor(pr)
    return { number: pr.number, url: pr.url, title: pr.title ?? '', state, label: PR_LABELS[state] }
  } catch {
    return null
  }
}

/** 리포의 열린 PR 을 head/base 브랜치와 함께 나열한다. worktree 안의 브랜치 스택을 자동 감지할 때 쓴다. */
export async function listOpenPrs(
  worktreePath: string
): Promise<Array<{ number: number; head: string; base: string }>> {
  const { stdout, code } = await runLoginShell(
    `gh pr list --state open --json number,headRefName,baseRefName --limit 200`,
    worktreePath
  )
  if (code !== 0) return []
  try {
    const arr = JSON.parse(stdout.trim()) as Array<{
      number: number
      headRefName: string
      baseRefName: string
    }>
    return arr.map((p) => ({ number: p.number, head: p.headRefName, base: p.baseRefName }))
  } catch {
    return []
  }
}

// ── PR/CI 체크 (Check 탭) ──────────────────────────────────────────────────

/** GitHub statusCheckRollup 항목. CheckRun(워크플로) 과 StatusContext(레거시 status) 두 모양이 섞여 온다. */
interface RollupItem {
  __typename?: string
  // CheckRun
  name?: string
  status?: string // QUEUED | IN_PROGRESS | COMPLETED | WAITING | PENDING | REQUESTED
  conclusion?: string // SUCCESS | FAILURE | NEUTRAL | CANCELLED | SKIPPED | TIMED_OUT | ...
  detailsUrl?: string
  workflowName?: string
  // StatusContext
  context?: string
  state?: string // SUCCESS | FAILURE | ERROR | PENDING | EXPECTED
  targetUrl?: string
}

function mapCheckRun(item: RollupItem): PrCheckState {
  if (item.status && item.status !== 'COMPLETED') return 'pending'
  switch (item.conclusion) {
    case 'SUCCESS':
      return 'success'
    case 'FAILURE':
    case 'TIMED_OUT':
    case 'STARTUP_FAILURE':
    case 'ACTION_REQUIRED':
      return 'failure'
    case 'SKIPPED':
      return 'skipped'
    default:
      return 'neutral'
  }
}

function mapStatusContext(state: string | undefined): PrCheckState {
  switch (state) {
    case 'SUCCESS':
      return 'success'
    case 'FAILURE':
    case 'ERROR':
      return 'failure'
    case 'PENDING':
    case 'EXPECTED':
      return 'pending'
    default:
      return 'neutral'
  }
}

function toCheck(item: RollupItem): PrCheck | null {
  if (item.__typename === 'StatusContext') {
    if (!item.context) return null
    return {
      name: item.context,
      state: mapStatusContext(item.state),
      url: item.targetUrl || undefined
    }
  }
  // CheckRun (기본). name 앞에 워크플로명을 붙여 동명 잡(job)을 구분한다.
  if (!item.name) return null
  const label = item.workflowName ? `${item.workflowName} / ${item.name}` : item.name
  return { name: label, state: mapCheckRun(item), url: item.detailsUrl || undefined }
}

/**
 * worktree 의 현재 브랜치에 연결된 PR 의 CI 체크 롤업을 조회한다.
 * `gh pr view --json statusCheckRollup` 한 번으로 PR 번호·URL·체크 목록을 함께 받는다.
 */
export async function getPrChecks(worktreePath: string): Promise<PrChecks | null> {
  const { stdout, code } = await runLoginShell(
    `gh pr view --json number,url,statusCheckRollup`,
    worktreePath
  )
  if (code !== 0) return null
  try {
    const pr = JSON.parse(stdout.trim()) as {
      number: number
      url: string
      statusCheckRollup?: RollupItem[]
    }
    const checks = (pr.statusCheckRollup ?? []).map(toCheck).filter((c): c is PrCheck => c !== null)
    return { prNumber: pr.number, prUrl: pr.url, checks }
  } catch {
    return null
  }
}

/**
 * GitHub PR 작성 화면을 브라우저로 연다(`gh pr create --web --fill`).
 * 실제 생성은 사용자가 브라우저에서 확정하므로 앱이 PR 을 바로 만들지 않는다.
 * 현재 브랜치가 리모트에 push 돼 있지 않거나 커밋이 없으면 gh 가 에러를 내며,
 * 그 메시지를 그대로 돌려준다.
 */
export async function createPrWeb(
  worktreePath: string,
  opts?: { base?: string; head?: string }
): Promise<{ error?: string }> {
  // stacked 면 부모 브랜치를 PR base 로 명시한다(--base). 없으면 gh 가 리포 기본 브랜치를 쓴다.
  // head 를 주면(모델 B: 현재 체크아웃되지 않은 스택 브랜치) 그 브랜치로 PR 을 연다(--head).
  // 브랜치명은 sanitizeBranch 로 정규화돼 있어 안전하지만, 셸 해석을 막기 위해 작은따옴표로 감싼다.
  const baseFlag = opts?.base ? ` --base '${opts.base}'` : ''
  const headFlag = opts?.head ? ` --head '${opts.head}'` : ''
  const { stderr, code } = await runLoginShell(
    `gh pr create --web --fill${baseFlag}${headFlag}`,
    worktreePath
  )
  if (code !== 0) {
    const msg = stderr.trim().split('\n').filter(Boolean).pop()
    return { error: msg || 'Failed to open the PR creation page.' }
  }
  return {}
}

/**
 * PR base 를 newBase 로 바꾼다(`gh pr edit [selector] --base`). selector 를 주면 그 PR(브랜치/번호)을,
 * 없으면 현재 브랜치의 PR 을 대상으로 한다. 부모 PR 이 병합돼 자식 PR 을 조부모로 옮길 때 쓴다.
 */
export async function retargetPr(
  worktreePath: string,
  newBase: string,
  selector?: string
): Promise<{ error?: string }> {
  const target = selector ? ` '${selector}'` : ''
  const { stderr, code } = await runLoginShell(
    `gh pr edit${target} --base '${newBase}'`,
    worktreePath
  )
  if (code !== 0) return { error: lastError(stderr, 'Failed to retarget the pull request.') }
  return {}
}

// ── PR 라이프사이클 액션 (merge / close / reopen / ready-for-review) ─────────
// 전부 worktree 의 현재 브랜치에 연결된 PR 을 대상으로 한다(인자 없는 gh pr 서브커맨드).
// gh 종료 코드가 0 이 아니면 마지막 stderr 줄을 사용자에게 그대로 보여 준다.

/** gh 명령의 마지막 의미 있는 오류 줄을 추린다. */
function lastError(stderr: string, fallback: string): string {
  return stderr.trim().split('\n').filter(Boolean).pop() || fallback
}

/**
 * 현재 브랜치의 PR 을 병합한다. method 로 squash/merge/rebase 를 고른다.
 * 로컬 브랜치는 worktree 에서 체크아웃돼 있어 삭제할 수 없으므로 --delete-branch 는 쓰지 않는다
 * (병합 후 워크스페이스를 아카이브하면 worktree·브랜치 정리는 그쪽 흐름이 담당한다).
 */
export async function mergePr(
  worktreePath: string,
  method: PrMergeMethod
): Promise<{ error?: string }> {
  const flag = method === 'merge' ? '--merge' : method === 'rebase' ? '--rebase' : '--squash'
  const { stderr, code } = await runLoginShell(`gh pr merge ${flag}`, worktreePath)
  if (code !== 0) return { error: lastError(stderr, 'Failed to merge the pull request.') }
  return {}
}

/** 현재 브랜치의 PR 을 닫는다(병합하지 않고 종료). */
export async function closePr(worktreePath: string): Promise<{ error?: string }> {
  const { stderr, code } = await runLoginShell('gh pr close', worktreePath)
  if (code !== 0) return { error: lastError(stderr, 'Failed to close the pull request.') }
  return {}
}

/** 닫힌 PR 을 다시 연다. */
export async function reopenPr(worktreePath: string): Promise<{ error?: string }> {
  const { stderr, code } = await runLoginShell('gh pr reopen', worktreePath)
  if (code !== 0) return { error: lastError(stderr, 'Failed to reopen the pull request.') }
  return {}
}

/** Draft PR 을 리뷰 가능 상태로 전환한다(gh pr ready). */
export async function markPrReady(worktreePath: string): Promise<{ error?: string }> {
  const { stderr, code } = await runLoginShell('gh pr ready', worktreePath)
  if (code !== 0) return { error: lastError(stderr, 'Failed to mark the pull request as ready.') }
  return {}
}

// ── GitHub 소유자 아바타 ────────────────────────────────────────────────────

/**
 * GitHub 소유자(owner)의 아바타 이미지를 받아 data: URL 로 돌려준다(실패 시 null).
 * `https://github.com/<owner>.png` 는 인증 없이 접근 가능한 공개 엔드포인트로,
 * 실제 아바타(avatars.githubusercontent.com)로 리다이렉트된다(fetch 가 자동 추적).
 * 렌더러 CSP(img-src 'self' data:)를 그대로 두기 위해 원격 URL 이 아니라 인라인 data URL 로 저장한다.
 */
export async function fetchOwnerAvatarDataUrl(owner: string): Promise<string | null> {
  try {
    const res = await fetch(`https://github.com/${encodeURIComponent(owner)}.png?size=64`)
    if (!res.ok) return null
    const type = res.headers.get('content-type') || 'image/png'
    if (!type.startsWith('image/')) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length === 0) return null
    return `data:${type};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}
