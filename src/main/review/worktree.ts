import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { agentContextItems, applyCarryExcludes, carryIntoWorktree } from '../carry'
import {
  addDetachedWorktree,
  deleteReviewRefs,
  fetchPrHeads,
  fetchRemote,
  removeWorktree,
  resetDetachedWorktree,
  revParse,
  reviewRefFor,
  reviewWorktreePathFor
} from '../git'
import { log } from '../logger'
import { getStore } from '../store'

/**
 * 리뷰 워크트리를 가리키는 키. 리뷰 id 까지 있어야 같은 PR 의 다른 세션과 섞이지 않는다.
 *
 * `prNumbers` 는 아래→위. 워크트리는 **맨 위 레이어**로 체크아웃되고, 아래 레이어들은
 * 로컬 ref 로만 받아 둔다.
 */
export interface ReviewWorktreeKey {
  repoPath: string
  prNumbers: number[]
  reviewId: string
}

/** 워크트리 디렉토리 이름에 남길 PR 번호(맨 위 레이어). 눈으로 훑을 때 알아보기 위함이다. */
function headPr(key: ReviewWorktreeKey): number {
  return key.prNumbers[key.prNumbers.length - 1] ?? 0
}

/**
 * 리뷰 대상을 detached 상태로 체크아웃한 worktree 를 준비한다.
 *
 * 왜 체크아웃까지 하나: diff 만 넘겨서는 제대로 된 리뷰가 안 나온다. 에이전트가 hunk 바깥의
 * 코드를 읽고, 같은 함수를 부르는 다른 곳을 grep 하고, 이미 있는 헬퍼와 중복인지 확인할 수
 * 있어야 한다. 그러려면 PR head 시점의 트리가 디스크에 있어야 한다.
 *
 * **스택이어도 워크트리는 하나다** — 맨 위 레이어를 체크아웃하고, 모든 레이어의 head 를 로컬
 * ref 로 받아 둔다. 그러면 에이전트가 `git diff <아래ref>...<위ref>` 나 `git show <ref>:<path>`
 * 로 어느 레이어든 볼 수 있다. 레이어마다 워크트리를 만들면 디스크는 N 배가 되는데, 정작
 * "이 파일을 읽어라" 가 어느 트리를 뜻하는지 모호해져서 리뷰가 더 나빠진다.
 *
 * 원본 repo 체크아웃을 재사용하지 않는 이유: 사용자가 그 트리에서 실제로 작업 중일 수 있고,
 * 브랜치를 갈아끼우면 그 작업을 망가뜨린다.
 *
 * 아카이브했다가 다시 여는 경우도 이 함수를 그대로 탄다 — ref 를 남겨 뒀기 때문에 네트워크가
 * 없어도(또는 PR 브랜치가 지워졌어도) 리뷰가 봤던 트리를 그대로 복원할 수 있다.
 */
export async function prepareReviewWorktree(
  key: ReviewWorktreeKey
): Promise<{ path: string } | { error: string }> {
  const { repoPath, prNumbers, reviewId } = key
  if (prNumbers.length === 0) return { error: 'This review has no pull request to check out.' }
  const top = headPr(key)
  const path = reviewWorktreePathFor(repoPath, top, reviewId)
  const ref = reviewRefFor(reviewId, top)

  // base 브랜치도 최신으로 — 에이전트가 직접 `git diff <base>...HEAD` 를 돌려볼 수 있게.
  await fetchRemote(repoPath)

  if (!(await fetchPrHeads(repoPath, prNumbers, reviewId))) {
    // 이미 이 리뷰의 ref 를 갖고 있으면 fetch 실패는 치명적이지 않다 — 오프라인이거나 PR
    // 브랜치가 지워진 경우로, 우리가 붙잡아 둔 커밋으로 그대로 복원하면 된다.
    // 맨 위 레이어만 확인한다: 체크아웃할 수 있으면 리뷰는 시작할 수 있고, 아래 레이어가
    // 빠졌다면 그건 프롬프트를 지을 때 diff 가 비는 것으로 드러난다.
    const have = await revParse(repoPath, ref)
    if (!have) {
      return {
        error:
          `Couldn't fetch the commits for PR #${top}. ` +
          `Check that origin points at the repository this PR was opened against, and that you have access.`
      }
    }
    log.warn(`review: fetch failed for PR #${top}; using the refs kept locally`)
  }

  try {
    if (existsSync(path)) {
      // 재리뷰 — 새 커밋이 올라왔을 수 있으니 제자리에서 최신으로 옮긴다.
      await resetDetachedWorktree(path, ref)
    } else {
      await addDetachedWorktree(repoPath, path, ref)
    }
  } catch (err) {
    // 디렉토리는 남았는데 worktree 등록이 깨진 경우(앱 강제 종료 등) 한 번 정리하고 재시도한다.
    log.warn(`review: worktree setup failed, cleaning up and retrying (${reviewId})`, err)
    await disposeReviewWorktree(key, { keepRef: true })
    try {
      await addDetachedWorktree(repoPath, path, ref)
    } catch (err2) {
      return { error: `Failed to create the review worktree: ${String(err2)}` }
    }
  }

  // 체크아웃이 **끝난 뒤에** 전달한다 — 재리뷰 경로의 resetDetachedWorktree 가 `git clean -fd`
  // 로 추적되지 않는 파일을 지우므로, 순서가 뒤집히면 두 번째 리뷰부터 조용히 사라진다.
  await carryAgentContext(repoPath, path)
  return { path }
}

/**
 * 리포의 전달 목록 중 에이전트 컨텍스트만 리뷰 워크트리로 옮긴다.
 *
 * 리뷰야말로 프로젝트 규칙(코딩 컨벤션, 리뷰 기준)을 알아야 하는 작업인데, worktree 는
 * `git worktree add` 결과 그대로라 gitignore 된 `CLAUDE.local.md` 같은 파일이 하나도 딸려오지
 * 않는다. 그대로 두면 에이전트가 규칙을 못 읽은 채 리뷰하고, 사용자는 그 사실을 알 방법이 없다.
 *
 * 전달 실패는 리뷰를 막지 않는다 — 지침 없이라도 도는 편이 리뷰 자체를 잃는 것보다 낫다.
 */
async function carryAgentContext(repoPath: string, worktreePath: string): Promise<void> {
  const repo = getStore()
    .getState()
    .repos.find((r) => r.path === repoPath)
  const items = agentContextItems(repo?.carryItems ?? [])
  if (items.length === 0) return

  try {
    const { carried, failures } = carryIntoWorktree(repoPath, worktreePath, items)
    await applyCarryExcludes(worktreePath, carried)
    for (const f of failures) log.warn(`review: 컨텍스트 전달 실패: ${f.path} — ${f.reason}`)
  } catch (err) {
    log.error('review: 컨텍스트 전달 단계 실패', err)
  }
}

/**
 * 리뷰 worktree 를 정리한다.
 *
 * `keepRef` 는 아카이브용이다 — 워크트리(파생물)만 지우고 ref 는 남겨, 레이어들의 head 커밋이
 * GC 되지 않게 붙잡아 둔다. 되살릴 때 네트워크 없이 같은 트리를 복원할 수 있는 근거가 이 ref 다.
 * 완전 삭제일 때만 이 리뷰의 ref 네임스페이스를 통째로 지운다.
 */
export async function disposeReviewWorktree(
  key: ReviewWorktreeKey,
  opts?: { keepRef?: boolean }
): Promise<void> {
  const { repoPath, reviewId } = key
  const path = reviewWorktreePathFor(repoPath, headPr(key), reviewId)
  await removeWorktree(repoPath, path, '', false)
  // worktree remove 가 실패해도 디렉토리는 반드시 치운다(다음 준비가 같은 자리에서 막히지 않도록).
  await rm(path, { recursive: true, force: true }).catch(() => {})
  if (!opts?.keepRef) await deleteReviewRefs(repoPath, reviewId)
}
