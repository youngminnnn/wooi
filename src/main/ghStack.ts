import { runGh, ghReadReady } from './github'

/**
 * GitHub 의 stacked pull request 를 **읽기만** 하는 모듈.
 *
 * GitHub 스택은 base 링크에서 추론한 것이 아니라 서버에 실재하는 객체다. Wooi 가 그걸 읽으면
 * 흡수(adopt)가 더 정확해진다 — 위치가 명시적이라, 리타겟 도중 base 체인이 잠시 끊겨도 순서가
 * 살아남는다. 그래서 stack.ts 의 `buildStackFromPrs`(base 링크 복원)보다 **먼저** 본다.
 *
 * ── 왜 gh 확장(`gh stack`)을 쓰지 않는가 ──────────────────────────────────
 * 확장은 스택 추적 상태를 `<git-dir>/gh-stack` 에 둔다. 그 경로는 worktree 마다 갈리므로
 * (linked worktree 에서는 `.git/worktrees/<name>/`), 워크스페이스마다 worktree 를 두는 Wooi
 * 에서는 스택이 워크스페이스마다 따로 놀고 영영 화해하지 않는다. 그래서 이 모듈은 `gh api`
 * (REST/GraphQL)만 쓴다 — 둘 다 공개 스키마고 preview 헤더도 필요 없다.
 *
 * ── 왜 기능 감지가 없는가 ──────────────────────────────────────────────────
 * 스택이 없는 PR 은 오류가 아니라 `stack: null` 을, 스택이 없는 리포는 `[]` 를 돌려준다.
 * 즉 "이 리포에 스택 기능이 있는가"를 따로 물어볼 필요 없이, 빈 결과가 곧 폴백 신호다.
 */

/** REST `repos/{o}/{r}/stacks` 응답의 PR 1건(필요한 필드만). */
export interface GhStackPr {
  number: number
  /** open | closed (REST 는 병합도 closed 로 준다 — 순서 판정에는 GraphQL 쪽을 쓴다). */
  state: string
  headRef: string
}

/** 리포가 들고 있는 스택 1개(목록 조회 결과). 어떤 PR 이 스택에 속하는지 거르는 용도다. */
export interface GhRepoStack {
  number: number
  baseRef: string
  open: boolean
  /**
   * 이 스택에 속한 PR 들. **순서를 신뢰하지 않는다** — REST 응답의 정렬은 문서화돼 있지 않다.
   * 순서가 필요하면 `getStackForPr` 의 position 을 쓴다.
   */
  pullRequests: GhStackPr[]
}

/** GraphQL `PullRequestStack.entries` 의 엔트리 1개. */
export interface GhStackEntry {
  /** 1-기반. 1 이 base 에 가장 가깝다(GitHub 문서의 정의 그대로). */
  position: number
  prNumber: number
  headRef: string
  baseRef: string
  /** OPEN | CLOSED | MERGED. */
  state: string
}

/** 한 PR 이 속한 GitHub 스택의 전체 모습. */
export interface GhStackInfo {
  number: number
  size: number
  /** 스택 맨 아래가 향하는 base 브랜치. */
  baseRef: string
  /** position 오름차순(아래→위)으로 정렬해 돌려준다. */
  entries: GhStackEntry[]
}

// ── 리포 스택 목록 캐시 ─────────────────────────────────────────────────────
// github.ts 의 열린 PR 목록과 같은 이유·같은 방식이다 — 리포 단위 질의라 같은 리포의
// 워크스페이스마다 돌리면 똑같은 응답을 N 번 받아온다. TTL 이 그쪽(10초)보다 긴 것은 스택
// 멤버십이 PR 상태보다 훨씬 덜 바뀌기 때문이다: 스택 객체는 명시적 호출로만 생기고 없어진다.
const STACKS_TTL_MS = 60_000
const stacksCache = new Map<string, { at: number; stacks: GhRepoStack[] }>()
const stacksInFlight = new Map<string, { epoch: number; promise: Promise<GhRepoStack[]> }>()
let stacksEpoch = 0

/** 스택을 바꿀 수 있는 동작 뒤에 캐시를 버린다(지금은 읽기 전용이라 호출부가 없지만 대칭을 맞춘다). */
export function invalidateRepoStacks(): void {
  stacksCache.clear()
  stacksEpoch++
}

/** REST 응답 원문(필요한 필드만). */
interface RawRepoStack {
  number?: number
  base?: { ref?: string }
  open?: boolean
  pull_requests?: Array<{ number?: number; state?: string; head?: { ref?: string } }>
}

async function fetchRepoStacks(repoPath: string): Promise<GhRepoStack[]> {
  // 공개 REST 색인에는 없지만 살아 있는 엔드포인트다. gh 가 {owner}/{repo} 를 cwd 리포로 치환한다.
  const { stdout, code } = await runGh(`gh api 'repos/{owner}/{repo}/stacks'`, repoPath)
  if (code !== 0) return []
  try {
    const raw = JSON.parse(stdout.trim()) as RawRepoStack[]
    if (!Array.isArray(raw)) return []
    return raw
      .filter((s) => typeof s.number === 'number')
      .map((s) => ({
        number: s.number!,
        baseRef: s.base?.ref ?? '',
        open: s.open !== false,
        pullRequests: (s.pull_requests ?? [])
          .filter((p) => typeof p.number === 'number' && !!p.head?.ref)
          .map((p) => ({ number: p.number!, state: p.state ?? '', headRef: p.head!.ref! }))
      }))
  } catch {
    return []
  }
}

/**
 * 리포의 GitHub 스택을 전부 나열한다. 스택이 없으면(대부분의 리포) `[]`.
 * cacheKey 를 주면 그 키로 묶어 캐시·합류한다(같은 리포의 워크스페이스들이 잇따라 부르는 경우).
 * 생략하면 repoPath 를 키로 쓴다.
 *
 * 이 목록은 **게이트**로 쓰라고 있는 것이다 — 스택이 하나도 없으면 여기서 끝내고, GraphQL 을
 * 워크스페이스마다 띄우지 않는다.
 */
export async function getRepoStacks(repoPath: string, cacheKey?: string): Promise<GhRepoStack[]> {
  if (!(await ghReadReady())) return []
  const key = cacheKey ?? repoPath

  const hit = stacksCache.get(key)
  if (hit && Date.now() - hit.at < STACKS_TTL_MS) return hit.stacks
  const inFlight = stacksInFlight.get(key)
  if (inFlight && inFlight.epoch === stacksEpoch) return inFlight.promise

  const epoch = stacksEpoch
  const promise = fetchRepoStacks(repoPath)
    .then((stacks) => {
      if (epoch === stacksEpoch) stacksCache.set(key, { at: Date.now(), stacks })
      return stacks
    })
    .finally(() => {
      if (stacksInFlight.get(key)?.promise === promise) stacksInFlight.delete(key)
    })
  stacksInFlight.set(key, { epoch, promise })
  return promise
}

// ── PR 1건이 속한 스택 (GraphQL) ────────────────────────────────────────────

/**
 * `-F owner={owner}` 형태의 치환은 엔드포인트뿐 아니라 필드 값에서도 동작한다(실측 확인).
 * 덕분에 owner/repo 를 알아내는 사전 조회 없이 cwd 만으로 GraphQL 을 쏠 수 있다.
 */
const STACK_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      stack{
        number size baseRefName
        entries(first:50){nodes{position pullRequest{number state headRefName baseRefName}}}
      }
    }
  }
}`.replace(/\s+/g, ' ')

interface RawStackResponse {
  data?: {
    repository?: {
      pullRequest?: {
        stack?: {
          number?: number
          size?: number
          baseRefName?: string
          entries?: {
            nodes?: Array<{
              position?: number
              pullRequest?: {
                number?: number
                state?: string
                headRefName?: string
                baseRefName?: string
              }
            } | null>
          }
        } | null
      } | null
    } | null
  }
}

/**
 * PR 이 속한 GitHub 스택을 읽는다. 스택이 아니면 null(오류가 아니다 — GraphQL 이 `stack: null`
 * 을 돌려준다). base 로만 연결된 PR 은 스택 객체를 만들지 않으므로, 오늘 Wooi 가 연 PR 들은
 * 여기서 전부 null 로 떨어지고 호출부가 폴백을 탄다.
 */
export async function getStackForPr(
  worktreePath: string,
  prNumber: number
): Promise<GhStackInfo | null> {
  // 셸 문자열에 그대로 들어가므로 정수임을 확인한다(호출부는 저장된 값을 넘긴다).
  if (!Number.isInteger(prNumber) || prNumber <= 0) return null
  if (!(await ghReadReady())) return null

  const { stdout, code } = await runGh(
    `gh api graphql -F owner='{owner}' -F name='{repo}' -F number=${prNumber} -f query='${STACK_QUERY}'`,
    worktreePath
  )
  if (code !== 0) return null
  try {
    const raw = JSON.parse(stdout.trim()) as RawStackResponse
    const stack = raw.data?.repository?.pullRequest?.stack
    if (!stack || typeof stack.number !== 'number') return null

    const entries: GhStackEntry[] = (stack.entries?.nodes ?? [])
      .flatMap((n) =>
        n?.pullRequest && typeof n.position === 'number' ? [{ n, pr: n.pullRequest }] : []
      )
      .filter(({ pr }) => typeof pr.number === 'number' && !!pr.headRefName)
      .map(({ n, pr }) => ({
        position: n.position!,
        prNumber: pr.number!,
        headRef: pr.headRefName!,
        baseRef: pr.baseRefName ?? '',
        state: pr.state ?? ''
      }))
      .sort((a, b) => a.position - b.position)

    return {
      number: stack.number,
      size: typeof stack.size === 'number' ? stack.size : entries.length,
      baseRef: stack.baseRefName ?? '',
      entries
    }
  } catch {
    return null
  }
}
