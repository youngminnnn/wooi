import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import {
  addDetachedWorktree,
  deleteRef,
  fetchPrHead,
  fetchRemote,
  removeWorktree,
  resetDetachedWorktree,
  revParse,
  reviewRefFor,
  reviewWorktreePathFor
} from '../git'
import { log } from '../logger'

/** 리뷰 워크트리를 가리키는 키. 리뷰 id 까지 있어야 같은 PR 의 다른 세션과 섞이지 않는다. */
export interface ReviewWorktreeKey {
  repoPath: string
  prNumber: number
  reviewId: string
}

/**
 * 리뷰 대상 PR 을 detached 상태로 체크아웃한 worktree 를 준비한다.
 *
 * 왜 체크아웃까지 하나: diff 만 넘겨서는 제대로 된 리뷰가 안 나온다. 에이전트가 hunk 바깥의
 * 코드를 읽고, 같은 함수를 부르는 다른 곳을 grep 하고, 이미 있는 헬퍼와 중복인지 확인할 수
 * 있어야 한다. 그러려면 PR head 시점의 트리가 디스크에 있어야 한다.
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
  const { repoPath, prNumber, reviewId } = key
  const path = reviewWorktreePathFor(repoPath, prNumber, reviewId)
  const ref = reviewRefFor(reviewId)

  // base 브랜치도 최신으로 — 에이전트가 직접 `git diff <base>...HEAD` 를 돌려볼 수 있게.
  await fetchRemote(repoPath)

  if (!(await fetchPrHead(repoPath, prNumber, reviewId))) {
    // 이미 이 리뷰의 ref 를 갖고 있으면 fetch 실패는 치명적이지 않다 — 오프라인이거나 PR
    // 브랜치가 지워진 경우로, 우리가 붙잡아 둔 커밋으로 그대로 복원하면 된다.
    const have = await revParse(repoPath, ref)
    if (!have) {
      return {
        error:
          `Couldn't fetch the commits for PR #${prNumber}. ` +
          `Check that origin points at the repository this PR was opened against, and that you have access.`
      }
    }
    log.warn(`review: fetch failed for PR #${prNumber}; using the ref kept locally`)
  }

  try {
    if (existsSync(path)) {
      // 재리뷰 — 새 커밋이 올라왔을 수 있으니 제자리에서 최신으로 옮긴다.
      await resetDetachedWorktree(path, ref)
    } else {
      await addDetachedWorktree(repoPath, path, ref)
    }
    return { path }
  } catch (err) {
    // 디렉토리는 남았는데 worktree 등록이 깨진 경우(앱 강제 종료 등) 한 번 정리하고 재시도한다.
    log.warn(`review: worktree setup failed, cleaning up and retrying (${reviewId})`, err)
    await disposeReviewWorktree(key, { keepRef: true })
    try {
      await addDetachedWorktree(repoPath, path, ref)
      return { path }
    } catch (err2) {
      return { error: `Failed to create the review worktree: ${String(err2)}` }
    }
  }
}

/**
 * 리뷰 worktree 를 정리한다.
 *
 * `keepRef` 는 아카이브용이다 — 워크트리(파생물)만 지우고 ref 는 남겨, PR head 커밋이 GC 되지
 * 않게 붙잡아 둔다. 되살릴 때 네트워크 없이 같은 트리를 복원할 수 있는 근거가 이 ref 다.
 * 완전 삭제일 때만 ref 까지 지운다.
 */
export async function disposeReviewWorktree(
  key: ReviewWorktreeKey,
  opts?: { keepRef?: boolean }
): Promise<void> {
  const { repoPath, prNumber, reviewId } = key
  const path = reviewWorktreePathFor(repoPath, prNumber, reviewId)
  await removeWorktree(repoPath, path, '', false)
  // worktree remove 가 실패해도 디렉토리는 반드시 치운다(다음 준비가 같은 자리에서 막히지 않도록).
  await rm(path, { recursive: true, force: true }).catch(() => {})
  if (!opts?.keepRef) await deleteRef(repoPath, reviewRefFor(reviewId))
}
