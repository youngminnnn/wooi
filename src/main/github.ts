import { spawn } from 'node:child_process'
import type {
  DiffSide,
  PrCheck,
  PrCheckState,
  PrChecks,
  PrEditable,
  PrMergeMethod,
  PrState,
  PrStatus,
  ReviewPrCandidate,
  IssueCandidate,
  ReviewVerdict
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
  statusCheckRollup?: RollupItem[]
}

function runLoginShell(
  command: string,
  cwd?: string,
  opts?: { stdin?: string }
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

    // 본문을 stdin 으로 넘기는 통로. 코멘트 본문처럼 사용자가 편집한 임의의 마크다운을
    // 명령 문자열에 끼워 넣으면 따옴표 하나로 셸 이스케이프가 뚫린다($(...)·백틱 실행까지).
    // JSON 을 stdin 으로 흘려보내면 인용 문제가 아예 사라진다.
    // stdin 을 항상 닫는 것도 중요하다 — 열어둔 채로 두면 입력을 기다리는 명령이 영원히 멈춘다.
    proc.stdin.on('error', () => {
      // 자식이 stdin 을 읽기 전에 끝나면 EPIPE 가 난다. 종료 코드로 판단하면 되므로 무시한다.
    })
    proc.stdin.end(opts?.stdin ?? '')

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    proc.on('error', () => resolve({ stdout, stderr, code: 1 }))
    proc.on('close', (code) => resolve({ stdout, stderr, code }))
  })
}

// ── gh 연결 여부 ────────────────────────────────────────────────────────────
// gh 는 선택 연동이다 — 없어도 리포 연결·워크스페이스 생성·에이전트 실행 등 git 만으로 되는
// 기능은 전부 동작해야 한다. 그래서 여기서 한 번 걸러, 미연결이면 gh 를 아예 실행하지 않는다.
// 읽기 계열은 조용히 빈 값(null/[])을 돌려주고(에러 토스트·로그 스팸 없음), 쓰기 계열은
// 사용자에게 보여줄 수 있는 에러 메시지를 돌려준다(렌더러가 먼저 막지만 최후 방어선).

/** null = 아직 확인 전. auth.ts 의 상태 조회가 매번 최신 값으로 갱신한다. */
let ghConnected: boolean | null = null

/** 인증 상태 조회(auth.ts)가 확인한 gh 연결 여부를 캐시에 반영한다. */
export function setGithubConnected(connected: boolean): void {
  ghConnected = connected
}

/**
 * 지금까지 확인된 gh 연결 여부(확인 전이면 false). 조회 결과가 "정말 없음"인지 "물어보지도
 * 못했음"인지 구분해야 하는 캐시 계층용이다 — 미연결 상태의 빈 결과를 캐시하면, 연결한 뒤에도
 * 한동안 PR 이 없는 것처럼 보인다.
 */
export function isGithubConnected(): boolean {
  return ghConnected === true
}

/**
 * gh 가 설치·로그인돼 있는지 직접 확인한다(캐시 갱신 포함).
 * 앱 기동 직후에는 모든 워크스페이스의 PR 조회가 한꺼번에 몰리므로, 진행 중인 확인이 있으면
 * 그 결과를 함께 기다려 로그인 셸을 워크스페이스 수만큼 띄우지 않는다.
 */
let probing: Promise<boolean> | null = null
function probeGithub(): Promise<boolean> {
  probing ??= runLoginShell('command -v gh >/dev/null 2>&1 && gh auth status')
    .then(({ code }) => {
      ghConnected = code === 0
      return ghConnected
    })
    .finally(() => {
      probing = null
    })
  return probing
}

/** 읽기 계열용 — 캐시가 있으면 그대로 쓴다(폴링마다 셸을 띄우지 않기 위함). */
async function connected(): Promise<boolean> {
  return ghConnected ?? (await probeGithub())
}

/**
 * 쓰기 계열용 — 캐시가 "미연결" 이면 한 번 더 확인한다. 사용자가 앱 밖(터미널)에서 방금
 * 로그인해 캐시만 낡은 경우에 액션을 헛되이 막지 않기 위함이다.
 */
async function connectedFresh(): Promise<boolean> {
  if (ghConnected) return true
  return probeGithub()
}

// ghStack.ts 가 gh 를 부를 때 쓰는 통로. 복사하지 않고 빌려 쓰는 이유는 위의 두 가지 규칙 때문이다
// — 로그인 셸로 띄워야 GUI 앱 PATH 에 없는 gh 를 찾고, GITHUB_TOKEN/GH_TOKEN 을 지워야 SSO
// 미인증 토큰이 정상 자격증명을 가리지 않는다. 어느 한쪽만 다르게 구현되면 그쪽 조회만 조용히
// 실패한다. (스택 발행 계열은 여전히 ghStack.ts 밖으로 나가지 않는다 — 그쪽 경계는 그대로다.)
export { runLoginShell as runGh, connected as ghReadReady }

const NOT_CONNECTED =
  'GitHub is not connected. Connect the GitHub CLI (gh) in Settings → Integrations.'

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

  // BLOCKED 는 리뷰뿐 아니라 필수 CI 대기/실패에도 쓰인다. 승인된 PR 을 Review required 로
  // 되돌리지 않도록 실제 체크 결과를 먼저 분리한다. 실패와 실행 중이 섞이면 실패를 우선한다.
  const checkStates = (pr.statusCheckRollup ?? [])
    .map(toCheck)
    .filter((check): check is PrCheck => check !== null)
    .map((check) => check.state)
  if (checkStates.includes('failure')) return 'ci_failed'
  if (checkStates.includes('pending')) return 'ci_pending'

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
  ci_pending: 'CI running',
  ci_failed: 'CI failed',
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
  if (!(await connected())) return null
  const target = branch ? ` '${branch}'` : ''
  const { stdout, code } = await runLoginShell(
    `gh pr view${target} --json number,url,title,state,isDraft,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup`,
    worktreePath
  )
  if (code !== 0) return null
  try {
    const pr = JSON.parse(stdout.trim()) as GhPr
    const state = stateFor(pr)
    return {
      number: pr.number,
      url: pr.url,
      title: pr.title ?? '',
      state,
      label: PR_LABELS[state],
      // mergeStateStatus 는 종결된 PR 에도 과거 BEHIND 값을 남길 수 있다. 업데이트 액션은
      // 열린 PR 에만 의미가 있으므로 원본 lifecycle 상태로 함께 제한한다.
      needsBaseUpdate: pr.state === 'OPEN' && pr.mergeStateStatus === 'BEHIND'
    }
  } catch {
    return null
  }
}

/**
 * PR 1 개의 캐스케이드 판단용 메타데이터. selector 는 PR 번호 또는 브랜치명.
 * state 는 OPEN|CLOSED|MERGED 원문 그대로 쓴다 — 캐스케이드는 "머지됨"과 "닫힘"을 구분해야 한다
 * (닫힘 = base 브랜치 삭제로 GitHub 가 죽인 자식 → 복구 대상).
 *
 * baseRefOid 는 base 브랜치가 삭제된 뒤에도 GitHub 가 계속 돌려주며, 그 커밋도 API 로 접근 가능하다.
 * 닫힌 자식 PR 을 되살릴 때 base 브랜치를 이 sha 로 복원하는 것이 유일한 경로다
 * (닫힌 PR 은 base 변경이 거부되고, base 브랜치가 없으면 reopen 도 거부된다).
 */
export interface PrMeta {
  number: number
  state: string // OPEN | CLOSED | MERGED
  headRefName: string
  baseRefName: string
  baseRefOid: string
}

export async function getPrMeta(
  worktreePath: string,
  selector: string | number
): Promise<PrMeta | null> {
  if (!(await connected())) return null
  const { stdout, code } = await runLoginShell(
    `gh pr view '${selector}' --json number,state,headRefName,baseRefName,baseRefOid`,
    worktreePath
  )
  if (code !== 0) return null
  try {
    const pr = JSON.parse(stdout.trim()) as PrMeta
    return pr.number ? pr : null
  } catch {
    return null
  }
}

// ── 원격 브랜치 ref 조작 (닫힌 자식 PR 복구용) ────────────────────────────────
// gh api 는 cwd 의 리포로 {owner}/{repo} 를 치환해 준다.

/** 원격에 브랜치가 존재하는지. 없으면 gh 가 404 로 종료한다. */
export async function remoteRefExists(worktreePath: string, branch: string): Promise<boolean> {
  if (!(await connected())) return false
  const { code } = await runLoginShell(
    `gh api 'repos/{owner}/{repo}/git/ref/heads/${branch}'`,
    worktreePath
  )
  return code === 0
}

/**
 * 삭제된 브랜치를 지정 sha 로 되살린다(닫힌 자식 PR 을 reopen 하기 위한 발판).
 * 이미 존재하면 성공으로 본다.
 */
export async function restoreRemoteRef(
  worktreePath: string,
  branch: string,
  sha: string
): Promise<{ error?: string }> {
  if (!(await connectedFresh())) return { error: NOT_CONNECTED }
  const { stderr, code } = await runLoginShell(
    `gh api -X POST 'repos/{owner}/{repo}/git/refs' -f 'ref=refs/heads/${branch}' -f 'sha=${sha}'`,
    worktreePath
  )
  if (code !== 0) return { error: lastError(stderr, `Failed to restore branch ${branch}.`) }
  return {}
}

/** 복구용으로 되살린 발판 브랜치를 다시 지운다(retarget 이 끝나면 더 이상 base 가 아니라 안전). */
export async function deleteRemoteRef(worktreePath: string, branch: string): Promise<void> {
  if (!(await connectedFresh())) return
  await runLoginShell(
    `gh api -X DELETE 'repos/{owner}/{repo}/git/refs/heads/${branch}'`,
    worktreePath
  )
}

export interface OpenPr {
  number: number
  head: string
  base: string
}

// ── 열린 PR 목록 캐시 ──────────────────────────────────────────────────────
// `gh pr list` 는 worktree 가 아니라 리포 단위 질의라, 같은 리포의 워크스페이스마다 돌리면 완전히
// 똑같은 응답을 N 번 받아온다. PR 상태 갱신은 워크스페이스별로 스택을 재동기화하며 이 목록을 쓰므로,
// 전체 훑기 한 번에 중복 로그인 셸이 워크스페이스 수만큼 뜬다 — 폴링 주기를 줄이려면 여기부터
// 걷어내야 한다. 그래서 리포 단위로 짧게 캐시하고, 진행 중인 요청에는 뒤따르는 호출을 붙인다
// (probeGithub 와 같은 방식). TTL 은 훑기 한 번을 덮되 사람이 낡음을 느끼지 못할 만큼만 잡는다.
//
// 이 목록은 **사이드바 PR 칩의 공급원이기도 하다.** 예전에는 워크스페이스마다 `gh pr view` 를
// 따로 돌렸는데(측정: 1건당 ~0.6초), 열린 PR 이라면 어차피 여기 다 들어 있다. 그래서 상태 판정에
// 필요한 필드까지 한 번에 받아 두고, 워크스페이스별 조회는 이 목록에서 브랜치로 찾아 답한다 —
// 워크스페이스가 몇 개든 리포당 1회다. (`--state all` 은 리포 히스토리 전체를 페이지네이션해
// 오히려 느리다 — 측정: 100건에 6.5초. 병합·닫힘 PR 은 여기 없고, 호출부가 개별로 메운다.)
const OPEN_PRS_TTL_MS = 10_000
const openPrsCache = new Map<string, { at: number; prs: OpenPrRow[] }>()
const openPrsInFlight = new Map<string, { epoch: number; promise: Promise<OpenPrRow[]> }>()
/** 무효화 세대. 무효화 시점에 이미 날아간 요청의 낡은 응답이 캐시에 눌러앉지 않게 한다. */
let openPrsEpoch = 0

/** 캐시에 담기는 열린 PR 1건 — 스택 감지용 필드와 상태 칩용 필드를 모두 담는다. */
interface OpenPrRow extends GhPr {
  headRefName: string
  baseRefName: string
}

/** PR 을 바꾸는 액션 뒤에는 캐시가 낡는다 — 즉시 버려 다음 조회가 실제 상태를 받게 한다. */
export function invalidateOpenPrs(): void {
  openPrsCache.clear()
  openPrsEpoch++
}

async function fetchOpenPrs(worktreePath: string): Promise<OpenPrRow[]> {
  const { stdout, code } = await runLoginShell(
    `gh pr list --state open --limit 200 --json number,url,title,state,isDraft,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup,headRefName,baseRefName`,
    worktreePath
  )
  if (code !== 0) return []
  try {
    const arr = JSON.parse(stdout.trim()) as OpenPrRow[]
    return arr.filter((p) => !!p.headRefName)
  } catch {
    return []
  }
}

/** 캐시된 행을 사이드바·헤더가 쓰는 PrStatus 로 옮긴다. */
function statusFromRow(pr: GhPr): PrStatus {
  const state = stateFor(pr)
  return {
    number: pr.number,
    url: pr.url,
    title: pr.title ?? '',
    state,
    label: PR_LABELS[state],
    needsBaseUpdate: pr.state === 'OPEN' && pr.mergeStateStatus === 'BEHIND'
  }
}

/**
 * 리포의 열린 PR 목록에서 해당 브랜치의 PR 상태를 찾는다. 목록은 리포 단위로 캐시·합류되므로
 * 워크스페이스가 몇 개든 실제 조회는 리포당 1회다. 열린 PR 이 아니면(없거나 병합·닫힘) null.
 */
export async function findOpenPrStatus(
  worktreePath: string,
  cacheKey: string,
  branch: string
): Promise<PrStatus | null> {
  if (!branch) return null
  const rows = await listOpenPrRows(worktreePath, cacheKey)
  const row = rows.find((p) => p.headRefName === branch)
  return row ? statusFromRow(row) : null
}

/**
 * 리포의 열린 PR 을 head/base 브랜치와 함께 나열한다. worktree 안의 브랜치 스택을 자동 감지할 때 쓴다.
 * cacheKey(리포 식별자)를 주면 그 키로 묶어 캐시·합류한다 — 같은 리포의 워크스페이스들이 잇따라
 * 부르는 경우가 이에 해당한다. 생략하면 캐시 없이 매번 새로 조회한다.
 */
export async function listOpenPrs(worktreePath: string, cacheKey?: string): Promise<OpenPr[]> {
  const rows = cacheKey
    ? await listOpenPrRows(worktreePath, cacheKey)
    : (await connected())
      ? await fetchOpenPrs(worktreePath)
      : []
  return rows.map((p) => ({ number: p.number, head: p.headRefName, base: p.baseRefName }))
}

/** 캐시·합류를 거쳐 리포의 열린 PR 원본 행을 돌려준다(listOpenPrs 와 findOpenPrStatus 의 공용 경로). */
async function listOpenPrRows(worktreePath: string, cacheKey: string): Promise<OpenPrRow[]> {
  if (!(await connected())) return []

  const hit = openPrsCache.get(cacheKey)
  if (hit && Date.now() - hit.at < OPEN_PRS_TTL_MS) return hit.prs
  // 같은 세대의 진행 중인 요청이 있으면 결과를 함께 기다린다(무효화 이전 요청에는 붙지 않는다).
  const inFlight = openPrsInFlight.get(cacheKey)
  if (inFlight && inFlight.epoch === openPrsEpoch) return inFlight.promise

  const epoch = openPrsEpoch
  const promise = fetchOpenPrs(worktreePath)
    .then((prs) => {
      // 조회 도중 무효화됐다면(그 사이 PR 을 만들었거나 병합했다) 이 응답은 이미 낡았다.
      if (epoch === openPrsEpoch) openPrsCache.set(cacheKey, { at: Date.now(), prs })
      return prs
    })
    .finally(() => {
      if (openPrsInFlight.get(cacheKey)?.promise === promise) openPrsInFlight.delete(cacheKey)
    })
  openPrsInFlight.set(cacheKey, { epoch, promise })
  return promise
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
  if (!(await connected())) return null
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
  if (!(await connectedFresh())) return { error: NOT_CONNECTED }
  // stacked 면 부모 브랜치를 PR base 로 명시한다(--base). 없으면 gh 가 리포 기본 브랜치를 쓴다.
  // head 를 주면(모델 B: 현재 체크아웃되지 않은 스택 브랜치) 그 브랜치로 PR 을 연다(--head).
  // 브랜치명은 sanitizeBranch 로 정규화돼 있어 안전하지만, 셸 해석을 막기 위해 작은따옴표로 감싼다.
  const baseFlag = opts?.base ? ` --base '${opts.base}'` : ''
  const headFlag = opts?.head ? ` --head '${opts.head}'` : ''
  const { stderr, code } = await runGhWrite(
    `gh pr create --web --fill${baseFlag}${headFlag}`,
    worktreePath
  )
  if (code !== 0) {
    const msg = stderr.trim().split('\n').filter(Boolean).pop()
    return { error: msg || 'Failed to open the PR creation page.' }
  }
  return {}
}

/** 만들어진 PR 의 최소 식별자. 번호는 store 에, URL 은 모델·사용자에게 필요하다. */
export interface CreatedPr {
  number: number
  url: string
}

/**
 * PR 을 **실제로** 만든다(`gh pr create`).
 *
 * createPrWeb 과 갈라 둔 이유: 저쪽은 `--web` 이라 브라우저를 열 뿐 PR 을 만들지 않는다.
 * 에이전트는 사용자 화면을 뺏지 않고 스스로 끝내야 하므로 생성까지 여기서 한다.
 *
 * 본문은 인자가 아니라 stdin(`--body-file -`)으로 넘긴다 — 모델이 쓴 임의의 마크다운을 명령
 * 문자열에 끼워 넣으면 따옴표 하나로 셸 인용이 뚫린다(runLoginShell 의 stdin 주석과 같은 이유).
 * 나머지 인자는 작은따옴표로 감싸되, 내부 작은따옴표까지 탈출시킨다 — 제목도 모델이 쓴 문자열이라
 * 브랜치명처럼 sanitize 돼 있다고 가정할 수 없다.
 *
 * runGhWrite 를 쓰므로 열린 PR 캐시가 곧바로 무효화된다 — 방금 만든 PR 이 다음 상태 갱신에
 * 바로 잡혀야 사이드바가 몇 초 동안 "PR 없음" 으로 남지 않는다.
 */
export async function createPr(
  worktreePath: string,
  opts: { base: string; title: string; body: string; draft?: boolean }
): Promise<{ pr?: CreatedPr; error?: string }> {
  if (!(await connectedFresh())) return { error: NOT_CONNECTED }
  const draftFlag = opts.draft ? ' --draft' : ''
  const { stdout, stderr, code } = await runGhWrite(
    `gh pr create --base ${shellQuote(opts.base)} --title ${shellQuote(opts.title)} --body-file -${draftFlag}`,
    worktreePath,
    { stdin: opts.body }
  )
  if (code !== 0) return { error: lastError(stderr, 'Failed to open the pull request.') }

  // gh 는 만든 PR 의 URL 을 stdout 마지막 줄에 찍는다. 번호를 여기서 뽑는 이유는, 곧바로 다시
  // 조회하면 방금 만든 PR 이 아직 목록에 안 잡히는 경합이 생기기 때문이다.
  const url = stdout.trim().split('\n').filter(Boolean).pop() ?? ''
  const m = url.match(/\/pull\/(\d+)/)
  if (!m) return { error: 'The pull request was created, but Wooi could not read its URL.' }
  return { pr: { number: parseInt(m[1], 10), url } }
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
  if (!(await connectedFresh())) return { error: NOT_CONNECTED }
  const target = selector ? ` '${selector}'` : ''
  const { stderr, code } = await runGhWrite(`gh pr edit${target} --base '${newBase}'`, worktreePath)
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
 * 명령 문자열에 끼워 넣을 값을 작은따옴표로 감싼다. 내부 작은따옴표는 POSIX 방식('\'')으로
 * 닫았다 다시 여는데, 이게 있어야 감싸기가 실제로 방어가 된다 — 그냥 감싸기만 하면 따옴표
 * 하나로 인용이 끝나고 뒤가 명령으로 해석된다.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * PR 을 바꾸는 gh 명령 실행기. 실행 뒤 열린 PR 목록 캐시를 버린다 — 방금 만들거나 병합·종료한 PR 이
 * 다음 상태 갱신에 곧바로 반영돼야 한다. 실패했더라도 버린다(한 번 더 조회할 뿐, 잘못될 여지가 없다).
 */
async function runGhWrite(
  command: string,
  cwd: string,
  opts?: { stdin?: string }
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const res = await runLoginShell(command, cwd, opts)
  invalidateOpenPrs()
  return res
}

/**
 * PR 을 병합한다. method 로 squash/merge/rebase 를 고른다.
 * selector(PR 번호)를 주면 그 PR 을, 없으면 worktree 현재 브랜치의 PR 을 병합한다.
 * 호출부는 UI 가 보여 준 PR 을 그대로 병합하도록 항상 번호를 넘긴다 — 모델 B 스택에서는
 * 에이전트가 배경에서 브랜치를 옮길 수 있어, selector 없는 병합은 "지금 체크아웃된 브랜치"라는
 * 흔들리는 대상을 집는다.
 *
 * 로컬 브랜치는 worktree 에서 체크아웃돼 있어 삭제할 수 없으므로 --delete-branch 는 쓰지 않는다
 * (병합 후 워크스페이스를 아카이브하면 worktree·브랜치 정리는 그쪽 흐름이 담당한다).
 */
export async function mergePr(
  worktreePath: string,
  method: PrMergeMethod,
  selector?: string | number
): Promise<{ error?: string }> {
  if (!(await connectedFresh())) return { error: NOT_CONNECTED }
  const flag = method === 'merge' ? '--merge' : method === 'rebase' ? '--rebase' : '--squash'
  const target = selector ? ` '${selector}'` : ''
  const { stderr, code } = await runGhWrite(`gh pr merge${target} ${flag}`, worktreePath)
  if (code !== 0) return { error: lastError(stderr, 'Failed to merge the pull request.') }
  return {}
}

/** 현재 브랜치의 PR 을 닫는다(병합하지 않고 종료). */
export async function closePr(worktreePath: string): Promise<{ error?: string }> {
  if (!(await connectedFresh())) return { error: NOT_CONNECTED }
  const { stderr, code } = await runGhWrite('gh pr close', worktreePath)
  if (code !== 0) return { error: lastError(stderr, 'Failed to close the pull request.') }
  return {}
}

/**
 * 닫힌 PR 을 다시 연다. selector 를 주면 그 PR 을, 없으면 현재 브랜치의 PR 을 대상으로 한다.
 * base 브랜치가 삭제된 상태면 GitHub 가 reopen 을 거부하므로, 캐스케이드 복구는 먼저
 * restoreRemoteRef 로 base 를 되살린 뒤 호출한다.
 */
export async function reopenPr(
  worktreePath: string,
  selector?: string | number
): Promise<{ error?: string }> {
  if (!(await connectedFresh())) return { error: NOT_CONNECTED }
  const target = selector ? ` '${selector}'` : ''
  const { stderr, code } = await runGhWrite(`gh pr reopen${target}`, worktreePath)
  if (code !== 0) return { error: lastError(stderr, 'Failed to reopen the pull request.') }
  return {}
}

/** Draft PR 을 리뷰 가능 상태로 전환한다(gh pr ready). */
export async function markPrReady(worktreePath: string): Promise<{ error?: string }> {
  if (!(await connectedFresh())) return { error: NOT_CONNECTED }
  const { stderr, code } = await runGhWrite('gh pr ready', worktreePath)
  if (code !== 0) return { error: lastError(stderr, 'Failed to mark the pull request as ready.') }
  return {}
}

// ── PR 제목·본문 편집 ────────────────────────────────────────────────────────

/**
 * 편집 모달이 채워 넣을 원문. 본문은 PrStatus 에 싣지 않는다 — 상태 조회는 워크스페이스마다
 * 폴링으로 돌아, 매번 PR 본문 전체를 IPC 로 실어 나르게 된다. 편집을 시작할 때만 따로 읽는다.
 *
 * 제목도 같이 읽는다. PrStatus 의 제목은 리포 단위 목록 캐시에서 온 값이라 몇 분 낡을 수 있고,
 * 그 낡은 제목을 그대로 저장하면 사용자가 손대지 않은 변경을 되돌려 버린다.
 */
export async function getPrEditable(worktreePath: string): Promise<PrEditable | null> {
  if (!(await connected())) return null
  const { stdout, code } = await runLoginShell('gh pr view --json title,body', worktreePath)
  if (code !== 0) return null
  try {
    const pr = JSON.parse(stdout.trim()) as { title?: string; body?: string }
    return { title: pr.title ?? '', body: pr.body ?? '' }
  } catch {
    return null
  }
}

/** 현재 브랜치에 연결된 PR 번호. 편집 대상 엔드포인트를 만들 때만 쓴다. */
async function currentPrNumber(worktreePath: string): Promise<number | null> {
  const { stdout, code } = await runLoginShell('gh pr view --json number', worktreePath)
  if (code !== 0) return null
  try {
    const pr = JSON.parse(stdout.trim()) as { number?: number }
    return typeof pr.number === 'number' ? safePrNumber(pr.number) : null
  } catch {
    return null
  }
}

/**
 * PR 제목·본문을 고친다. 준 필드만 보낸다 — `title` 만 주면 본문은 GitHub 에 있는 그대로 남는다.
 * 빈 문자열은 "비우기" 라는 정당한 편집이므로 미지정과 구분해 그대로 전달한다.
 *
 * `gh pr edit --title/--body` 가 아니라 REST PATCH 를 쓰는 이유는 인용이다 — 제목·본문은 사용자가
 * 무엇이든 쓸 수 있는 문자열이라, 명령 문자열에 끼워 넣으면 따옴표 하나로 셸 인용이 뚫린다.
 * ghApiSend 는 값을 전부 stdin(JSON)으로 넘기므로 백틱·`$(...)`·개행이 있어도 안전하다.
 *
 * prNumber 를 알면 넘긴다 — 모를 때만 현재 브랜치에서 한 번 더 조회한다.
 */
export async function editPr(
  worktreePath: string,
  edits: { title?: string; body?: string },
  prNumber?: number
): Promise<{ error?: string }> {
  const payload: Record<string, string> = {}
  if (edits.title !== undefined) payload.title = edits.title
  if (edits.body !== undefined) payload.body = edits.body
  if (Object.keys(payload).length === 0) return {}

  if (!(await connectedFresh())) return { error: NOT_CONNECTED }
  const n =
    (prNumber !== undefined ? safePrNumber(prNumber) : null) ??
    (await currentPrNumber(worktreePath))
  if (n === null) return { error: 'Wooi could not find a pull request for this branch.' }

  const res = await ghApiSend(
    worktreePath,
    'PATCH',
    `repos/{owner}/{repo}/pulls/${n}`,
    payload,
    'Failed to update the pull request.'
  )
  // 제목은 리포 단위 열린 PR 목록에도 실려 있다 — 버리지 않으면 사이드바가 옛 제목을 계속 보여 준다.
  // 실패했더라도 버린다(runGhWrite 와 같은 이유로, 한 번 더 조회할 뿐 잘못될 여지가 없다).
  invalidateOpenPrs()
  return res.error ? { error: res.error } : {}
}

// ── PR 리뷰 모드 ────────────────────────────────────────────────────────────
// 위 함수들이 "내 worktree 의 현재 브랜치에 달린 PR" 을 다루는 것과 달리, 여기는 **임의의 PR**
// 을 번호로 지목한다. 그래서 cwd 는 항상 원본 repo 경로이고 PR 번호를 명시적으로 넘긴다.

/** 셸에 숫자만 들어가도록 강제한다. PR 번호는 사용자 입력에서 오므로 반드시 통과시킨다. */
function safePrNumber(prNumber: number): number | null {
  return Number.isInteger(prNumber) && prNumber > 0 ? prNumber : null
}

/** 리뷰 화면 헤더 + 인라인 코멘트의 commit_id 에 필요한 PR 메타데이터. */
export interface PrReviewMeta {
  number: number
  title: string
  url: string
  state: string
  isDraft: boolean
  headRefName: string
  baseRefName: string
  /** 인라인 코멘트는 이 커밋을 기준으로 달린다. */
  headSha: string
  /** PR 작성자 로그인. 내 PR 이면 GitHub 이 승인·변경 요청을 거부하므로 미리 알아야 한다. */
  author: string
}

export async function getPrReviewMeta(
  repoPath: string,
  prNumber: number
): Promise<PrReviewMeta | null> {
  if (!(await connected())) return null
  const n = safePrNumber(prNumber)
  if (n === null) return null
  const { stdout, code } = await runLoginShell(
    `gh pr view ${n} --json number,title,url,state,isDraft,headRefName,baseRefName,headRefOid,author`,
    repoPath
  )
  if (code !== 0) return null
  try {
    const pr = JSON.parse(stdout.trim()) as {
      number: number
      title: string
      url: string
      state: string
      isDraft: boolean
      headRefName: string
      baseRefName: string
      headRefOid: string
      author?: { login?: string }
    }
    if (!pr.number || !pr.headRefOid) return null
    return {
      number: pr.number,
      title: pr.title ?? '',
      url: pr.url,
      state: pr.state,
      isDraft: pr.isDraft,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
      headSha: pr.headRefOid,
      author: pr.author?.login ?? ''
    }
  } catch {
    return null
  }
}

/**
 * PR diff 원문을 가져온다.
 *
 * 로컬 `git diff base...head` 가 아니라 `gh pr diff` 를 쓰는 이유: GitHub 이 직접 계산한
 * diff 여야 "코멘트를 걸 수 있는 줄" 집합이 서버와 정확히 일치한다. 로컬 base ref 가 낡았거나
 * merge-base 가 다르면 조용히 어긋나서, 멀쩡해 보이는 코멘트가 게시 시점에 422 로 튕긴다.
 */
export async function getPrDiffRaw(repoPath: string, prNumber: number): Promise<string | null> {
  if (!(await connected())) return null
  const n = safePrNumber(prNumber)
  if (n === null) return null
  const { stdout, code } = await runLoginShell(`gh pr diff ${n}`, repoPath)
  if (code !== 0) return null
  return stdout
}

/** 리뷰 시작 모달의 열린 PR 드롭다운용. listOpenPrs 와 달리 제목·작성자까지 가져온다. */
export async function listOpenPrsForReview(repoPath: string): Promise<ReviewPrCandidate[]> {
  if (!(await connected())) return []
  const { stdout, code } = await runLoginShell(
    `gh pr list --state open --json number,title,headRefName,baseRefName,author --limit 100`,
    repoPath
  )
  if (code !== 0) return []
  try {
    const arr = JSON.parse(stdout.trim()) as Array<{
      number: number
      title: string
      headRefName: string
      baseRefName: string
      author?: { login?: string }
    }>
    return arr.map((p) => ({
      number: p.number,
      title: p.title ?? '',
      head: p.headRefName,
      base: p.baseRefName,
      author: p.author?.login ?? ''
    }))
  } catch {
    return []
  }
}

/** 열린 이슈 선택 UI와 에이전트 도구가 공유하는 가벼운 목록. 본문은 선택 뒤 따로 읽는다. */
export async function listOpenIssues(repoPath: string): Promise<IssueCandidate[]> {
  if (!(await connected())) return []
  const { stdout, code } = await runLoginShell(
    'gh issue list --state open --json number,title,author,labels,url --limit 100',
    repoPath
  )
  if (code !== 0) return []
  try {
    const arr = JSON.parse(stdout.trim()) as Array<{
      number: number
      title: string
      author?: { login?: string }
      labels?: Array<{ name?: string }>
      url: string
    }>
    return arr.map((issue) => ({
      number: issue.number,
      title: issue.title ?? '',
      author: issue.author?.login ?? '',
      labels: (issue.labels ?? []).map((label) => label.name ?? '').filter(Boolean),
      url: issue.url ?? ''
    }))
  } catch {
    return []
  }
}

/** 선택한 이슈 하나의 본문만 가져온다. */
export async function getIssueBody(repoPath: string, issueNumber: number): Promise<string | null> {
  if (!(await connected())) return null
  const n = safePrNumber(issueNumber)
  if (n === null) return null
  const { stdout, code } = await runLoginShell(`gh issue view ${n} --json body`, repoPath)
  if (code !== 0) return null
  try {
    const parsed = JSON.parse(stdout.trim()) as { body?: string }
    return typeof parsed.body === 'string' ? parsed.body : ''
  } catch {
    return null
  }
}

/** 게시된 코멘트 1건의 식별자. 게시 자체가 성공했으면 파싱에 실패해도 빈 객체를 돌려준다. */
export interface PostedCommentResult {
  /** GitHub 코멘트 id. 인라인 답글이 in_reply_to_id 로 가리키는 값이라, 답글 추적의 조인 키다. */
  id?: number
  url?: string
  /** ISO 8601. 이 시각 이후의 남의 코멘트만 새 활동으로 본다. */
  createdAt?: string
  /** 답글이면 GitHub 이 정해 준 **스레드 루트** id. 어느 스레드에 붙었는지의 유일한 근거다. */
  inReplyToId?: number
  error?: string
}

/**
 * gh api 로 JSON 본문을 보낸다(POST/PATCH). 본문은 전부 stdin(JSON)으로 넘어가므로 사용자가
 * 무엇을 쓰든 안전하다. 성공하면 gh 가 찍은 응답 본문(stdout)을 그대로 돌려준다.
 *
 * 오류 메시지는 stdout 을 먼저 본다 — gh 는 GitHub 이 돌려준 오류 본문(JSON)을 stdout 에
 * 찍는데, 사용자에게 실제로 필요한 문장("line must be part of the diff" 같은)이 거기 있다.
 */
async function ghApiSend(
  repoPath: string,
  method: 'POST' | 'PATCH',
  endpoint: string,
  payload: Record<string, unknown>,
  fallbackError: string
): Promise<{ stdout?: string; error?: string }> {
  if (!(await connectedFresh())) return { error: NOT_CONNECTED }
  const { stdout, stderr, code } = await runLoginShell(
    `gh api --method ${method} ${endpoint} --input -`,
    repoPath,
    { stdin: JSON.stringify(payload) }
  )
  if (code !== 0) {
    let message: string | null = null
    try {
      const body = JSON.parse(stdout.trim()) as { message?: string; errors?: Array<unknown> }
      if (body.message) {
        const detail =
          Array.isArray(body.errors) && body.errors.length ? describeErrors(body.errors) : ''
        message = detail ? `${body.message} (${detail})` : body.message
      }
    } catch {
      // stdout 이 JSON 이 아니면 stderr 로 넘어간다.
    }
    return { error: message || lastError(stderr, fallbackError) }
  }
  return { stdout }
}

async function ghApiPost(
  repoPath: string,
  endpoint: string,
  payload: Record<string, unknown>
): Promise<PostedCommentResult> {
  const sent = await ghApiSend(repoPath, 'POST', endpoint, payload, 'Failed to post the comment.')
  if (sent.error) return { error: sent.error }
  const stdout = sent.stdout ?? ''
  try {
    const created = JSON.parse(stdout.trim()) as {
      id?: number
      html_url?: string
      created_at?: string
      in_reply_to_id?: number | null
    }
    return {
      id: created.id,
      url: created.html_url,
      createdAt: created.created_at,
      inReplyToId: created.in_reply_to_id ?? undefined
    }
  } catch {
    // 게시 자체는 성공했으므로 식별자만 비운다.
    return {}
  }
}

function describeErrors(errors: Array<unknown>): string {
  return errors
    .map((e) => {
      if (typeof e === 'string') return e
      const o = e as { field?: string; message?: string; code?: string }
      return o.message || [o.field, o.code].filter(Boolean).join(' ')
    })
    .filter(Boolean)
    .join('; ')
}

export interface InlineCommentInput {
  body: string
  /** PR head 커밋 sha. */
  commitId: string
  path: string
  line: number
  side: DiffSide
  /** 여러 줄 코멘트의 시작 줄. line 보다 작아야 한다. */
  startLine?: number | null
}

/** diff 의 특정 줄에 인라인 코멘트를 단다(리뷰로 묶지 않고 즉시 게시). */
export async function postInlineComment(
  repoPath: string,
  prNumber: number,
  input: InlineCommentInput
): Promise<PostedCommentResult> {
  const n = safePrNumber(prNumber)
  if (n === null) return { error: 'Invalid pull request number.' }
  if (!/^[0-9a-f]{7,40}$/i.test(input.commitId)) return { error: 'Invalid commit sha.' }

  const payload: Record<string, unknown> = {
    body: input.body,
    commit_id: input.commitId,
    path: input.path,
    line: input.line,
    side: input.side
  }
  // start_line 을 줄 때는 start_side 도 같이 줘야 GitHub 이 받는다.
  if (typeof input.startLine === 'number' && input.startLine < input.line) {
    payload.start_line = input.startLine
    payload.start_side = input.side
  }
  return ghApiPost(repoPath, `repos/{owner}/{repo}/pulls/${n}/comments`, payload)
}

/** PR 타임라인에 일반 코멘트를 단다(전반적인 지적용). */
export async function postIssueComment(
  repoPath: string,
  prNumber: number,
  body: string
): Promise<PostedCommentResult> {
  const n = safePrNumber(prNumber)
  if (n === null) return { error: 'Invalid pull request number.' }
  return ghApiPost(repoPath, `repos/{owner}/{repo}/issues/${n}/comments`, { body })
}

/** PR 인라인 리뷰 코멘트(스레드 루트 또는 답글). */
export interface GhReviewComment {
  id: number
  /** 답글이면 **스레드 루트**의 id. 최상위 코멘트면 없음/null. */
  in_reply_to_id?: number | null
  user?: { login?: string }
  body: string
  created_at: string
  path?: string
  /** 코멘트가 붙은 줄. diff 에서 밀려나면 null 이 온다 → original_line 으로 폴백. */
  line?: number | null
  original_line?: number | null
  /** diff 안에서의 위치. 코멘트가 밀려나면(= GitHub 의 Outdated) null 이 온다. */
  position?: number | null
  html_url: string
}

/** PR 타임라인(issue) 코멘트. 스레딩이 없다. */
export interface GhIssueComment {
  id: number
  user?: { login?: string }
  body: string
  created_at: string
  html_url: string
}

/**
 * gh api 로 GET 한다. 읽기 계열이므로 조용한 캐시 게이트(connected)를 쓴다 —
 * connectedFresh 는 매번 로그인 셸을 하나 더 띄우므로 폴링에 쓰면 안 된다.
 *
 * `--paginate` 는 JSON 문서를 연달아 뱉어 JSON.parse 하나로 못 읽으므로 쓰지 않는다.
 * 대신 per_page=100 으로 받고, 꽉 찼으면 다음 페이지를 이어 받는다.
 */
async function ghApiGetAll<T>(repoPath: string, path: string): Promise<T[] | null> {
  if (!(await connected())) return null
  const out: T[] = []
  for (let page = 1; page <= 10; page++) {
    const sep = path.includes('?') ? '&' : '?'
    const { stdout, code } = await runLoginShell(
      `gh api "${path}${sep}per_page=100&page=${page}"`,
      repoPath
    )
    if (code !== 0) return out.length ? out : null
    let batch: T[]
    try {
      batch = JSON.parse(stdout.trim()) as T[]
    } catch {
      return out.length ? out : null
    }
    if (!Array.isArray(batch)) return out
    out.push(...batch)
    if (batch.length < 100) break
  }
  return out
}

/** PR 의 인라인 리뷰 코멘트 전체(스레드 루트 + 답글). */
export async function listReviewComments(
  repoPath: string,
  prNumber: number
): Promise<GhReviewComment[] | null> {
  const n = safePrNumber(prNumber)
  if (n === null) return null
  return ghApiGetAll<GhReviewComment>(repoPath, `repos/{owner}/{repo}/pulls/${n}/comments`)
}

/** PR 타임라인 코멘트 전체. */
export async function listIssueComments(
  repoPath: string,
  prNumber: number
): Promise<GhIssueComment[] | null> {
  const n = safePrNumber(prNumber)
  if (n === null) return null
  return ghApiGetAll<GhIssueComment>(repoPath, `repos/{owner}/{repo}/issues/${n}/comments`)
}

/** 현재 PR head sha. 달라졌으면 새 커밋이 올라온 것이다. */
export async function getPrHeadSha(repoPath: string, prNumber: number): Promise<string | null> {
  if (!(await connected())) return null
  const n = safePrNumber(prNumber)
  if (n === null) return null
  const { stdout, code } = await runLoginShell(
    `gh pr view ${n} --json headRefOid --jq .headRefOid`,
    repoPath
  )
  if (code !== 0) return null
  const sha = stdout.trim()
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null
}

/**
 * 로그인한 계정의 이름. 내가 단 답장이 "새 활동" 으로 잡히지 않게 거르는 데 쓴다.
 * 실행 중 바뀌지 않으므로 한 번만 조회해 캐시한다.
 */
let viewerLogin: string | null | undefined
export async function getViewerLogin(repoPath: string): Promise<string | null> {
  if (viewerLogin !== undefined) return viewerLogin
  if (!(await connected())) return null
  const { stdout, code } = await runLoginShell('gh api user --jq .login', repoPath)
  viewerLogin = code === 0 && stdout.trim() ? stdout.trim() : null
  return viewerLogin
}

/**
 * 인라인 코멘트 스레드에 답글을 단다.
 *
 * 새 최상위 코멘트가 아니라 **기존 스레드에 붙는** 전용 엔드포인트다 — 그냥 코멘트를 새로
 * 만들면 대화가 이어지지 않고 별도 스레드로 흩어진다.
 */
export async function replyToReviewComment(
  repoPath: string,
  prNumber: number,
  commentId: number,
  body: string
): Promise<PostedCommentResult> {
  const n = safePrNumber(prNumber)
  if (n === null) return { error: 'Invalid pull request number.' }
  if (!Number.isInteger(commentId) || commentId <= 0) return { error: 'Invalid comment id.' }
  const text = body.trim()
  if (!text) return { error: 'The reply body is empty.' }

  const res = await ghApiPost(
    repoPath,
    `repos/{owner}/{repo}/pulls/${n}/comments/${commentId}/replies`,
    { body: text }
  )
  if (!res.error) return res

  // 전용 /replies 엔드포인트가 막히면 생성 엔드포인트의 in_reply_to 로 떨어진다.
  // 둘 다 공식 경로이고 결과(같은 스레드에 붙는 답글)도 같다 — 한쪽이 막혔다고 답장을
  // 통째로 못 하게 둘 이유가 없다.
  const fallback = await ghApiPost(repoPath, `repos/{owner}/{repo}/pulls/${n}/comments`, {
    body: text,
    in_reply_to: commentId
  })
  // 폴백도 실패하면 원래(더 구체적인) 오류를 보여 준다.
  return fallback.error ? res : fallback
}

/**
 * PR 리뷰를 제출한다(Approve / Request changes / Comment).
 *
 * 개별 인라인 코멘트와는 별개의 행위다 — 코멘트는 "여기 이게 문제다" 이고, 이건 PR 전체에
 * 대한 판정이라 GitHub 에서도 다른 엔드포인트다.
 *
 * 본문은 `--body-file -` 로 stdin 에 흘린다(코멘트 게시와 같은 이유 — 사용자가 쓴 임의의
 * 마크다운을 명령 문자열에 끼워 넣으면 따옴표 하나로 셸 인용이 뚫린다).
 */
export async function submitPrReview(
  repoPath: string,
  prNumber: number,
  verdict: ReviewVerdict,
  body: string
): Promise<{ error?: string }> {
  if (!(await connectedFresh())) return { error: NOT_CONNECTED }
  const n = safePrNumber(prNumber)
  if (n === null) return { error: 'Invalid pull request number.' }

  const text = body.trim()
  // GitHub 은 request-changes·comment 에 본문을 요구한다. 빈 채로 보내면 422 가 나므로 먼저 막는다.
  if (!text && verdict !== 'approve') {
    return { error: 'A message is required to request changes or comment.' }
  }

  const flag =
    verdict === 'approve'
      ? '--approve'
      : verdict === 'request-changes'
        ? '--request-changes'
        : '--comment'
  // approve 는 본문이 없어도 되므로, 비었으면 --body-file 자체를 빼서 빈 본문을 보내지 않는다.
  const bodyFlag = text ? ' --body-file -' : ''

  const { stdout, stderr, code } = await runLoginShell(
    `gh pr review ${n} ${flag}${bodyFlag}`,
    repoPath,
    text ? { stdin: text } : undefined
  )
  if (code !== 0) {
    // gh 는 GitHub 오류 본문을 stdout 에 찍기도 한다("Can not approve your own pull request" 등).
    const detail = stdout.trim().split('\n').filter(Boolean).pop()
    return { error: lastError(stderr, detail || 'Failed to submit the review.') }
  }
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
