import { randomUUID } from 'node:crypto'
import type {
  AgentBackendId,
  EffortSetting,
  Repo,
  ReviewActivityItem,
  ReviewArtifact,
  ReviewBundle,
  ReviewEvent,
  ReviewFailure,
  ReviewFinding,
  ReviewLayer,
  ReviewLayerDiff,
  ReviewSession,
  ReviewStatus,
  ReviewVerdict
} from '@shared/types'
import { EMPTY_RESUBMIT_BLOCKED, SELF_REVIEW_BLOCKED, layerFor, stackHead } from '@shared/types'
import { fileDiffHash, reviewDiffHash, viewedKey } from '@shared/reviewViewed'
import {
  getPrDiffRaw,
  getPrHeadSha,
  getPrReviewMeta,
  getViewerLogin,
  listIssueComments,
  listReviewComments,
  listReviewThreads,
  postInlineComment,
  postIssueComment,
  replyToReviewComment,
  submitPrReview
} from '../github'
import { reviewRefFor } from '../git'
import { log } from '../logger'
import { getStore } from '../store'
import { RATE_LIMIT_ERROR, rateLimitResetAt } from '../rateLimitText'
import {
  detectNewActivity,
  detectOutdatedComments,
  detectResolvedThreads,
  type ThreadState
} from './activity'
import { parseReviewDiff, resolveStackAnchor } from './diff'
import { getReviewBundles } from './store'
import { runReview } from './run'
import {
  buildFollowUpPrompt,
  buildResumePrompt,
  type PromptFinding,
  type ReviewPromptLayer
} from './prompt'
import { applyRevisions, findingHandle } from './revise'
import { MAX_STACK_LAYERS } from './stackResolve'
import { disposeReviewWorktree, prepareReviewWorktree, type ReviewWorktreeKey } from './worktree'

export interface StartReviewArgs {
  repo: Repo
  /** 리뷰할 PR 들, 아래(base 쪽)부터. 원소가 하나면 지금까지의 단일 PR 리뷰다. */
  prNumbers: number[]
  prompt: string
  /** 이 리뷰를 돌릴 에이전트. 세션에 박히고 후속 턴도 같은 것을 쓴다. */
  agentBackend: AgentBackendId
  model: string | null
  effort: EffortSetting | null
}

/** 판정 제출 1건 — PR 하나에 낼 판정과 본문. */
export interface SubmitEntry {
  prNumber: number
  verdict: ReviewVerdict
  body: string
}

export interface SubmitResult {
  submitted: number
  /** PR 별 실패. 하나가 실패해도 나머지는 그대로 올라간다. */
  errors: Array<{ prNumber: number; error: string }>
}

/**
 * 리뷰 세션의 수명을 관리한다.
 *
 * **영속 상태는 app.json 이 갖는다** — 사이드바가 워크스페이스와 같은 상태 방송으로 리뷰를
 * 그리고, 앱을 껐다 켜도 남아야 하기 때문이다. 이 클래스가 메모리에 들고 있는 건 프로세스와
 * 함께 사라져야 하는 것뿐이다(실행 중인 query 의 AbortController).
 *
 * 세션 하나가 **레이어 여러 개**를 본다(스택 리뷰). PR 하나짜리 리뷰는 레이어가 하나인 스택이라,
 * 아래 코드에 "단일 PR" 분기는 없다.
 */
export class ReviewManager {
  /** 실행 중인 리뷰의 중단 핸들. 재시작을 넘길 수 없으므로 메모리에만 둔다. */
  private running = new Map<string, AbortController>()

  constructor(
    private readonly dispatch: (event: { reviewId: string; event: ReviewEvent }) => void,
    private readonly broadcastState: () => void
  ) {}

  // ── 레코드 접근 ─────────────────────────────────────────────────────────

  private record(reviewId: string): ReviewSession | undefined {
    return getStore()
      .getState()
      .reviews.find((r) => r.id === reviewId)
  }

  /** 레코드를 갱신하고 디스크에 쓴 뒤 렌더러에 방송한다. */
  private patch(reviewId: string, mutate: (r: ReviewSession) => void): void {
    getStore().update((st) => {
      const r = st.reviews.find((x) => x.id === reviewId)
      if (r) {
        mutate(r)
        r.updatedAt = Date.now()
      }
    })
    this.broadcastState()
  }

  private keyFor(session: ReviewSession, repoPath: string): ReviewWorktreeKey {
    return { repoPath, prNumbers: session.layers.map((l) => l.prNumber), reviewId: session.id }
  }

  private repoPathFor(session: ReviewSession): string | null {
    return (
      getStore()
        .getState()
        .repos.find((r) => r.id === session.repoId)?.path ?? null
    )
  }

  /**
   * 앱을 켤 때 한 번 — 지난 실행에서 돌던 채로 끝난 리뷰를 정리한다.
   *
   * 실행 중이라는 사실은 프로세스와 함께 사라지는데(running 맵) 상태는 디스크에 남는다. 그래서
   * 리뷰 도중에 앱을 닫으면 다음 실행에서 **영원히 "Reviewing…"** 인 리뷰가 남았다 — 도는 것은
   * 없으니 끝나지도 않고, Stop 은 붙잡을 핸들이 없어 아무 일도 하지 않았다.
   * 멈춘 것으로 표시해 두면 사용자가 이어서 다시 돌릴 수 있다.
   */
  restore(): void {
    const stuck = getStore()
      .getState()
      .reviews.filter((r) => r.status === 'running' || r.status === 'preparing')
    if (!stuck.length) return
    for (const r of stuck) {
      this.patch(r.id, (rec) => {
        rec.status = 'cancelled'
        rec.lastError = {
          message: 'Wooi closed while this review was running.',
          rateLimited: false,
          resetsAt: null
        }
      })
    }
    log.info(`review: marked ${stuck.length} interrupted review(s) as stopped`)
  }

  // ── 시작 ────────────────────────────────────────────────────────────────

  async start(args: StartReviewArgs): Promise<{ reviewId: string } | { error: string }> {
    const { repo } = args
    const prNumbers = [...new Set(args.prNumbers)].filter((n) => Number.isInteger(n) && n > 0)
    if (prNumbers.length === 0) return { error: 'No pull request to review.' }
    if (prNumbers.length > MAX_STACK_LAYERS) {
      return {
        error: `That stack has ${prNumbers.length} pull requests — Wooi reviews at most ${MAX_STACK_LAYERS} as one unit.`
      }
    }

    // PR 을 못 찾으면 레코드를 만들기 전에 끝낸다 — 실패를 즉시, 정확히 알려주기 위함.
    // 내 계정은 캐시돼 있어 같이 물어봐도 비용이 없다.
    const [metas, viewerLogin] = await Promise.all([
      Promise.all(prNumbers.map((n) => getPrReviewMeta(repo.path, n))),
      getViewerLogin(repo.path)
    ])
    const missing = prNumbers.filter((_, i) => !metas[i])
    if (missing.length > 0) {
      return {
        error:
          missing.length === prNumbers.length
            ? `Couldn't find PR #${missing[0]}. Check the number and that GitHub is connected.`
            : `Couldn't find ${missing.map((n) => `#${n}`).join(', ')} in this stack.`
      }
    }

    const reviewId = randomUUID()
    const now = Date.now()
    const layers: ReviewLayer[] = metas.map((meta) => ({
      prNumber: meta!.number,
      prUrl: meta!.url,
      prTitle: meta!.title,
      prAuthor: meta!.author,
      viewerIsAuthor: !!viewerLogin && !!meta!.author && viewerLogin === meta!.author,
      headSha: meta!.headSha,
      headRefName: meta!.headRefName,
      baseRefName: meta!.baseRefName,
      merged: false,
      lastSeenAt: null,
      lastSeenHeadSha: meta!.headSha,
      summary: '',
      lastSubmission: null
    }))

    const session: ReviewSession = {
      id: reviewId,
      repoId: repo.id,
      agentBackend: args.agentBackend,
      // 시작할 때 해석해 둔 값을 그대로 박는다 — 후속 턴이 같은 모델·강도로 이어져야 한다.
      model: args.model,
      effort: args.effort,
      layers,
      truncatedFiles: 0,
      prompt: args.prompt,
      status: 'preparing',
      summary: '',
      archived: false,
      createdAt: now,
      updatedAt: now,
      agentSessionId: null,
      postedComments: [],
      unread: false,
      lastError: null
    }
    getStore().update((st) => {
      st.reviews.push(session)
    })
    this.broadcastState()

    // 나머지는 백그라운드로 — 워크트리 준비와 에이전트 실행은 수 분이 걸릴 수 있다.
    this.launch(reviewId, repo.path)

    return { reviewId }
  }

  /**
   * 실패하거나 중단된 리뷰를 이어서 다시 돌린다.
   *
   * 사용량 제한이 이 기능의 존재 이유다 — 제한은 리뷰의 결론과 아무 상관이 없는데도 세션을
   * 통째로 버리게 만들었다. 다시 시작하면 워크트리를 새로 만들고, 같은 diff 를 또 태우고,
   * 앞서 읽은 것을 처음부터 다시 읽는다.
   *
   * **이어받을 에이전트 세션이 있으면 그 대화를 잇고**(끊긴 턴을 마저 끝내게 한다), 없으면
   * (에이전트가 result 를 내기도 전에 죽었거나, 워크트리·diff 단계에서 실패한 경우) 같은
   * 프롬프트로 처음부터 다시 돌린다. 어느 쪽이든 세션의 정체성·게시 기록·"봤음" 표시는 그대로다.
   */
  async resume(reviewId: string): Promise<{ error?: string }> {
    const session = this.record(reviewId)
    if (!session) return { error: 'Review session not found.' }
    if (
      this.running.has(reviewId) ||
      session.status === 'running' ||
      session.status === 'preparing'
    )
      return { error: 'This review is already running.' }
    const repoPath = this.repoPathFor(session)
    if (!repoPath) return { error: 'Repository not found.' }

    // 아카이브된 채로 이어 가면 워크트리는 살아나는데 목록에서는 여전히 보관함에 있어, 도는 것을
    // 볼 방법이 없다. 되살리는 것까지가 "이어서 돌린다" 의 일부다.
    this.patch(reviewId, (r) => {
      r.archived = false
      r.lastError = null
    })
    this.launch(reviewId, repoPath, { resume: true })
    return {}
  }

  /** 파이프라인을 백그라운드로 띄운다. 실패는 레코드에 남겨 화면이 이어서 돌릴 수 있게 한다. */
  private launch(reviewId: string, repoPath: string, opts: { resume?: boolean } = {}): void {
    void this.run(reviewId, repoPath, opts).catch((err) => {
      log.error('review: pipeline failed', err)
      this.fail(reviewId, String(err))
    })
  }

  /**
   * 리뷰 한 번의 실행. **처음 돌리는 것과 이어서 돌리는 것이 같은 경로**다 — 다른 것은 프롬프트
   * (새 리뷰냐, 끊긴 턴을 마저 끝내라는 지시냐)뿐이고, 나머지(워크트리·diff·결과 반영)는 같다.
   */
  private async run(
    reviewId: string,
    repoPath: string,
    opts: { resume?: boolean } = {}
  ): Promise<void> {
    const session = this.record(reviewId)
    if (!session) return
    // 이어서 돌릴 때만 앞선 대화를 잇는다. 세션 id 가 없으면(에이전트가 result 도 못 내고 죽었다면)
    // 이어받을 것이 없으므로 처음부터 다시 돌린다.
    const resumeSessionId = opts.resume ? session.agentSessionId : null

    const abort = new AbortController()
    this.running.set(reviewId, abort)
    // 이어서 돌릴 때는 상태가 error/cancelled 에서 시작하므로 여기서 되돌려 놔야 화면이
    // "다시 도는 중" 으로 바뀐다(처음 돌 때는 start 가 이미 preparing 으로 만들어 둔다).
    if (session.status !== 'preparing') this.setStatus(reviewId, 'preparing')
    try {
      const prepared = await prepareReviewWorktree(this.keyFor(session, repoPath))
      if ('error' in prepared) return this.fail(reviewId, prepared.error)
      if (abort.signal.aborted) return

      // 이어서 돌 때도 diff 를 다시 받는다 — 멈춰 있는 동안 새 커밋이 올라왔을 수 있고,
      // 그러면 앵커가 옛 줄을 가리킨다.
      const diffs = await this.fetchDiffs(reviewId, repoPath, session.layers)
      if ('error' in diffs) return this.fail(reviewId, diffs.error)
      if (abort.signal.aborted) return

      this.setStatus(reviewId, 'running')
      const result = await runReview({
        backend: session.agentBackend,
        cwd: prepared.path,
        repoPath,
        model: session.model,
        effort: session.effort,
        userPrompt: session.prompt,
        ...(resumeSessionId
          ? {
              resumeSessionId,
              promptOverride: buildResumePrompt(
                session.prompt,
                this.recentContext(session, getReviewBundles().load(reviewId).activity)
              )
            }
          : {}),
        meta: { layers: promptLayers(session) },
        diffs: diffs.diffs,
        abort,
        onProgress: (item) => this.emit(reviewId, { type: 'progress', item })
      })

      if (abort.signal.aborted) return this.setStatus(reviewId, 'cancelled')

      // **세션 id 는 실패해도 남긴다.** 실패한 턴에도 그때까지의 맥락은 그대로 살아 있어서,
      // 이걸 버리면 사용량 제한 한 번에 리뷰를 처음부터 다시 돌리는 수밖에 없어진다.
      if (result.sessionId) {
        const sessionId = result.sessionId
        this.patch(reviewId, (r) => {
          r.agentSessionId = sessionId
        })
      }
      if (result.error) return this.fail(reviewId, result.error)

      // 구조화 출력이 없으면 원문이라도 살려서 총평 하나로 보여준다. 리뷰를 통째로 잃는 것보다 낫다.
      const artifact: ReviewArtifact = result.artifact ?? {
        summary: result.rawText.trim() || 'The review result could not be structured.',
        reply: '',
        general: [],
        inline: [],
        stack: [],
        layers: [],
        updates: [],
        discards: []
      }

      // 이어서 돈 턴은 앞선 지적을 고쳐 쓰거나 거둬들일 수 있다(최초 리뷰에서는 가리킬
      // 대상이 없어 아무 일도 일어나지 않는다).
      const revised = this.reviseFindings(reviewId, artifact)
      const findings = buildFindings(diffs.diffs, artifact, session.layers)
      const bundles = getReviewBundles()
      for (const f of findings) bundles.upsertFinding(reviewId, f)

      this.patch(reviewId, (r) => {
        // 이어서 돈 턴이 총평을 비워 냈다면 앞서 받아 둔 총평을 지우지 않는다 — 끊긴 것이
        // 후속 질문이었다면 이 턴의 일은 답변이지 총평 교체가 아니다.
        if (artifact.summary || !resumeSessionId) r.summary = artifact.summary
        // 프롬프트를 새로 짓지 않은 턴(resume)은 예산 보고가 0 이라, 그대로 쓰면 앞선 경고가 사라진다.
        if (!resumeSessionId) r.truncatedFiles = result.truncatedFiles
        for (const l of r.layers) {
          const summary = artifact.layers.find((x) => x.prNumber === l.prNumber)?.summary ?? ''
          if (summary || !resumeSessionId) l.summary = summary
        }
        r.lastError = null
      })
      // 끊긴 것이 후속 질문이었다면 그 답이 여기 온다 — 타임라인에 남겨야 사용자가 읽는다.
      if (resumeSessionId && artifact.reply.trim()) {
        this.addActivity(reviewId, {
          id: randomUUID(),
          kind: 'turn',
          role: 'agent',
          text: artifact.reply.trim(),
          ts: Date.now()
        })
      }
      this.emit(reviewId, {
        type: 'findings',
        findings: [...revised.updated, ...findings],
        removed: revised.removed
      })
      this.setStatus(reviewId, 'done')
    } finally {
      this.running.delete(reviewId)
    }
  }

  /**
   * 레이어들의 diff 를 받아 사이드카에 남기고 화면에 흘린다.
   *
   * 한 레이어라도 못 받으면 실패로 본다 — 스택 리뷰의 결론은 레이어 사이의 관계에서 나오므로,
   * 하나가 비면 남은 것으로 낸 판단이 틀린다. 조용히 빠뜨리는 쪽이 더 나쁘다.
   */
  private async fetchDiffs(
    reviewId: string,
    repoPath: string,
    layers: ReviewLayer[]
  ): Promise<{ diffs: ReviewLayerDiff[] } | { error: string }> {
    const bundles = getReviewBundles()
    const diffs: ReviewLayerDiff[] = []
    for (const layer of layers) {
      const raw = await getPrDiffRaw(repoPath, layer.prNumber)
      if (raw === null) return { error: `Failed to fetch the diff for PR #${layer.prNumber}.` }
      const diff = parseReviewDiff(raw)
      if (diff.files.length === 0) {
        return { error: `PR #${layer.prNumber} has no changed files.` }
      }
      bundles.setDiff(reviewId, layer.prNumber, diff)
      diffs.push({ prNumber: layer.prNumber, diff })
    }
    this.emit(reviewId, { type: 'diff', diffs })
    return { diffs }
  }

  // ── 조회 ────────────────────────────────────────────────────────────────

  /** 리뷰 화면 진입 시 사이드카를 통째로 읽어 준다. */
  loadBundle(reviewId: string): ReviewBundle {
    return getReviewBundles().load(reviewId)
  }

  /**
   * 파일 1건의 "봤음" 표시를 켜고 끈다.
   *
   * 지문은 **여기 있는 diff 로 계산한다** — 표시를 켜는 순간의 내용이 기준이어야, 그 뒤 새
   * 커밋으로 파일이 바뀌었을 때 표시가 풀린다. 계산된 지문을 돌려주므로, 렌더러가 아직 못 받은
   * 새 diff 가 main 에 먼저 도착해 있어도 양쪽이 같은 값으로 맞춰진다.
   *
   * 표시는 **레이어별**이다 — 스택에서는 같은 경로가 여러 레이어에 있고 서로 다른 변경이다.
   */
  setFileViewed(
    reviewId: string,
    path: string,
    viewed: boolean,
    prNumber?: number
  ): { key?: string; hash?: string; error?: string } {
    const bundles = getReviewBundles()
    const key = viewedKey(path, prNumber)
    if (!viewed) {
      bundles.setFileViewed(reviewId, key, null)
      return { key }
    }
    const diffs = bundles.load(reviewId).diffs
    const layer = prNumber === undefined ? diffs[0] : diffs.find((d) => d.prNumber === prNumber)
    const file = layer?.diff.files.find((f) => f.path === path)
    if (!file) return { error: 'That file is no longer part of this diff.' }
    const hash = fileDiffHash(file)
    bundles.setFileViewed(reviewId, key, hash)
    return { key, hash }
  }

  // ── 수명 관리 ───────────────────────────────────────────────────────────

  /**
   * 실행 중인 리뷰를 중단한다. 결과·워크트리는 그대로 둔다.
   *
   * 붙잡을 핸들이 없어도 상태는 내린다 — 핸들과 상태가 어긋난 리뷰(지난 실행에서 넘어온 것 등)에
   * Stop 이 아무 일도 하지 않으면 사용자는 그 리뷰를 영영 손댈 수 없다.
   */
  cancel(reviewId: string): void {
    this.running.get(reviewId)?.abort()
    const status = this.record(reviewId)?.status
    if (status === 'running' || status === 'preparing') this.setStatus(reviewId, 'cancelled')
  }

  /**
   * 아카이브 — 파생물(워크트리)만 지우고 정체성·기록은 남긴다.
   *
   * ref 를 유지하는 게 핵심이다. 레이어들의 head 커밋을 붙잡아 둬 GC 되지 않으므로, 되살릴 때
   * 네트워크 없이도 리뷰가 봤던 트리를 그대로 복원할 수 있다.
   */
  async archive(reviewId: string): Promise<void> {
    const session = this.record(reviewId)
    if (!session) return
    this.cancel(reviewId)
    const repoPath = this.repoPathFor(session)
    if (repoPath) {
      await disposeReviewWorktree(this.keyFor(session, repoPath), { keepRef: true }).catch((err) =>
        log.warn('review: failed to clean up worktree on archive', err)
      )
    }
    this.patch(reviewId, (r) => {
      r.archived = true
      r.unread = false
      if (r.status === 'running' || r.status === 'preparing') r.status = 'cancelled'
    })
  }

  async unarchive(reviewId: string): Promise<{ error?: string }> {
    const session = this.record(reviewId)
    if (!session) return { error: 'Review session not found.' }
    const repoPath = this.repoPathFor(session)
    if (!repoPath) return { error: 'Repository not found.' }

    const prepared = await prepareReviewWorktree(this.keyFor(session, repoPath))
    if ('error' in prepared) return { error: prepared.error }
    this.patch(reviewId, (r) => {
      r.archived = false
    })
    return {}
  }

  /** 완전 삭제 — 워크트리·ref·사이드카·레코드를 모두 없앤다. */
  async remove(reviewId: string): Promise<void> {
    const session = this.record(reviewId)
    if (!session) return
    this.cancel(reviewId)
    const repoPath = this.repoPathFor(session)
    if (repoPath) {
      await disposeReviewWorktree(this.keyFor(session, repoPath)).catch((err) =>
        log.warn('review: failed to clean up worktree on delete', err)
      )
    }
    getReviewBundles().remove(reviewId)
    getStore().update((st) => {
      st.reviews = st.reviews.filter((r) => r.id !== reviewId)
    })
    this.broadcastState()
  }

  /** 현재 아카이브된 리뷰만 스냅샷해 모두 완전 삭제한다. */
  async removeArchived(): Promise<{ count: number }> {
    const ids = getStore()
      .getState()
      .reviews.filter((review) => review.archived)
      .map((review) => review.id)
    for (const id of ids) await this.remove(id)
    return { count: ids.length }
  }

  /**
   * 앱 종료 시 — **워크트리만** 정리하고 레코드·ref·사이드카는 남긴다.
   * 여기서 지워 버리면 다음 실행에 리뷰가 사라져 영속화가 무의미해진다.
   */
  async disposeWorktreesOnQuit(): Promise<void> {
    const sessions = getStore()
      .getState()
      .reviews.filter((r) => !r.archived)
    for (const s of sessions) {
      this.running.get(s.id)?.abort()
      const repoPath = this.repoPathFor(s)
      if (!repoPath) continue
      await disposeReviewWorktree(this.keyFor(s, repoPath), { keepRef: true }).catch(() => {})
    }
  }

  // ── 게시 ────────────────────────────────────────────────────────────────

  /**
   * 지적 1건을 실제 PR 에 게시한다.
   *
   * **어느 PR 인지는 지적이 들고 있다** — 인라인이면 앵커가 확정한 레이어, 전반 지적이면
   * 에이전트가 지목한 레이어, 스택 지적이면 그것이 관련짓는 가장 아래 레이어다. 세션에서
   * 임의로 고르면 코멘트가 다른 PR 에 달린다.
   *
   * 편집된 본문을 렌더러가 그대로 넘겨준다 — 사용자가 고친 문장이 게시되어야 하기 때문이다.
   * 성공하면 코멘트 id 를 레코드에 남긴다. 나중에 이 id 로 답글을 찾는다.
   */
  async post(
    reviewId: string,
    findingId: string,
    body: string
  ): Promise<{ url?: string; error?: string }> {
    const session = this.record(reviewId)
    if (!session) return { error: 'Review session not found.' }
    const repoPath = this.repoPathFor(session)
    if (!repoPath) return { error: 'Repository not found.' }

    const finding = getReviewBundles()
      .load(reviewId)
      .findings.find((f) => f.id === findingId)
    if (!finding) return { error: 'Finding not found.' }

    const layer = layerFor(session, finding.anchor?.prNumber ?? finding.prNumber)
    if (!layer) return { error: 'That finding points at a pull request no longer in this review.' }

    const text = body.trim()
    if (!text) return { error: 'The comment body is empty.' }

    const res = finding.anchor
      ? await postInlineComment(repoPath, layer.prNumber, {
          body: text,
          commitId: layer.headSha,
          path: finding.anchor.file,
          line: finding.anchor.line,
          side: finding.anchor.side,
          startLine: finding.anchor.startLine
        })
      : await postIssueComment(repoPath, layer.prNumber, text)

    if (res.error) return { error: res.error }

    if (res.id !== undefined) {
      const commentId = res.id
      const kind = finding.anchor ? ('inline' as const) : ('issue' as const)
      const createdAt = res.createdAt ?? new Date().toISOString()
      const htmlUrl = res.url ?? ''
      const prNumber = layer.prNumber
      this.patch(reviewId, (r) => {
        r.postedComments = [
          ...r.postedComments.filter((c) => c.findingId !== findingId),
          { findingId, commentId, htmlUrl, kind, prNumber, createdAt }
        ]
      })
    }
    return { url: res.url }
  }

  /**
   * 지적 1건을 목록에서 버린다.
   *
   * 에이전트가 낸 제안이 전부 달 만한 것은 아니다 — 안 달 것을 남겨 두면 "아직 안 단 코멘트"
   * 를 세는 곳(닫기 확인·제출 모달)이 계속 그것들을 세어 사용자를 붙잡는다.
   */
  dismissFinding(reviewId: string, findingId: string): { error?: string } {
    const session = this.record(reviewId)
    if (!session) return { error: 'Review session not found.' }
    // 이미 PR 에 올라간 코멘트는 여기서 지울 수 없다. 목록에서만 사라지면 GitHub 에 남은
    // 코멘트를 우리가 잊어버리는 셈이라, 사용자는 지웠다고 생각하고 상대는 계속 보게 된다.
    if (session.postedComments.some((c) => c.findingId === findingId)) {
      return { error: 'That comment is already on the pull request — delete it on GitHub.' }
    }
    getReviewBundles().dismissFinding(reviewId, findingId)
    return {}
  }

  /**
   * 에이전트가 자기 지적을 고쳐 쓰거나 거둬들인 것을 반영한다.
   *
   * 사용자의 Discard 와 **같은 자리로 떨어진다**(store.dismissFinding) — 둘 다 "이 지적은 이제
   * 목록에 없다" 는 하나의 사실이고, 저장 경로가 갈리면 한쪽으로 지운 것이 다른 쪽 로드에서
   * 되살아난다.
   *
   * 거둬들인 것은 **타임라인에 한 줄 남긴다.** 카드가 말없이 사라지면 사용자는 무엇이 왜
   * 없어졌는지 알 방법이 없고, 에이전트가 틀렸을 때 되짚을 근거도 사라진다.
   */
  private reviseFindings(
    reviewId: string,
    artifact: ReviewArtifact | null
  ): { updated: ReviewFinding[]; removed: string[] } {
    const empty = { updated: [] as ReviewFinding[], removed: [] as string[] }
    if (!artifact || (artifact.updates.length === 0 && artifact.discards.length === 0)) return empty
    const session = this.record(reviewId)
    if (!session) return empty

    const bundles = getReviewBundles()
    const result = applyRevisions({
      findings: bundles.load(reviewId).findings,
      postedIds: session.postedComments.map((c) => c.findingId),
      updates: artifact.updates,
      discards: artifact.discards
    })

    for (const f of result.updated) bundles.upsertFinding(reviewId, f)
    for (const { finding, reason } of result.discarded) {
      bundles.dismissFinding(reviewId, finding.id)
      this.addActivity(reviewId, {
        id: randomUUID(),
        kind: 'withdrawn',
        title: finding.title,
        reason,
        ts: Date.now()
      })
    }
    for (const { id, reason } of result.ignored) {
      log.info(`review: ignored a revision for "${id}" (${reason})`)
    }

    return { updated: result.updated, removed: result.discarded.map((d) => d.finding.id) }
  }

  /**
   * 판정을 제출한다(Approve / Request changes / Comment).
   *
   * GitHub 에 "스택을 승인" 하는 API 는 없다 — 판정은 PR 단위다. 그래서 **레이어마다 한 번씩**
   * 낸다. 그 팬아웃을 감추지 않고 드러내는 대신, 실패에 강하게 만든다:
   *
   * - 순차로 낸다(같은 리포에 병렬 제출은 2차 레이트리밋에 걸린다).
   * - **성공한 레이어는 그 자리에서 기록한다** — 3번째가 실패해도 1·2번째는 제출된 상태로 남고,
   *   다시 낼 때 나머지만 보내면 된다.
   * - 자기 PR 차단·빈 본문 재제출 차단은 레이어마다 따로 건다. 둘이 함께 쌓은 스택이면 내 것과
   *   남의 것이 섞여 있다.
   */
  async submitReview(reviewId: string, entries: SubmitEntry[]): Promise<SubmitResult> {
    const session = this.record(reviewId)
    if (!session) return { submitted: 0, errors: [{ prNumber: 0, error: 'Review not found.' }] }
    const repoPath = this.repoPathFor(session)
    if (!repoPath)
      return { submitted: 0, errors: [{ prNumber: 0, error: 'Repository not found.' }] }

    const errors: SubmitResult['errors'] = []
    let submitted = 0
    const viewerLogin = await getViewerLogin(repoPath)

    for (const entry of entries) {
      const layer = layerFor(session, entry.prNumber)
      if (!layer) {
        errors.push({ prNumber: entry.prNumber, error: 'That pull request is not in this review.' })
        continue
      }
      if (layer.merged) {
        errors.push({ prNumber: entry.prNumber, error: 'That pull request is already merged.' })
        continue
      }
      // UI 는 이미 선택지를 감추지만, 여기서도 막는다 — 세션을 만들 때 내 계정을 몰랐거나
      // (gh 미연결) 옛 레코드라 플래그가 비어 있을 수 있고, 그때 GitHub 이 돌려주는 건
      // 사용자가 해석할 수 없는 GraphQL 에러다.
      if (entry.verdict !== 'comment' && isOwn(layer, viewerLogin)) {
        errors.push({ prNumber: entry.prNumber, error: SELF_REVIEW_BLOCKED })
        continue
      }
      // 이미 한 번 낸 리뷰를 빈 본문으로 또 내는 건 같은 말의 반복이다. 승인은 GitHub 이 본문
      // 없이도 받아 주므로 여기서만 걸린다.
      if (layer.lastSubmission && !entry.body.trim()) {
        errors.push({ prNumber: entry.prNumber, error: EMPTY_RESUBMIT_BLOCKED })
        continue
      }

      const res = await submitPrReview(repoPath, entry.prNumber, entry.verdict, entry.body)
      if (res.error) {
        errors.push({ prNumber: entry.prNumber, error: res.error })
        continue
      }
      submitted++
      // 총평은 방금 PR 로 갔다. 여기서 비워야 제출 모달이 빈 본문으로 다시 열리고, 같은 말이
      // 무심코 또 올라가지 않는다(코멘트·변경 요청은 본문 없이는 나가지 않는다).
      this.patch(reviewId, (r) => {
        const l = r.layers.find((x) => x.prNumber === entry.prNumber)
        if (l) {
          l.lastSubmission = { verdict: entry.verdict, at: Date.now() }
          l.summary = ''
        }
      })
    }

    // 스택 총평은 맨 위 레이어에 한 번만 실린다. 그 레이어가 나갔으면 비운다.
    const head = stackHead(session)
    if (
      head &&
      entries.some(
        (e) => e.prNumber === head.prNumber && !errors.some((x) => x.prNumber === e.prNumber)
      )
    ) {
      this.patch(reviewId, (r) => {
        r.summary = ''
      })
    }
    return { submitted, errors }
  }

  // ── 상대방 활동 추적 ────────────────────────────────────────────────────

  /**
   * 내가 단 코멘트의 답글과 새 커밋을 가져온다.
   *
   * 레이어마다 따로 돈다 — 코멘트도 커밋도 PR 단위이기 때문이다. 다만 **아래 레이어에 커밋이
   * 올라가면 위쪽은 전부 rebase 되어** head sha 가 함께 바뀐다. 그것을 레이어마다 "새 커밋"
   * 으로 알리면 진짜 바뀐 것이 소음에 묻히므로, 여기서는 sha 변화를 모아 두고 diff 를 다시 받아
   * 내용이 같은지 확인한 뒤 하나로 알린다([[review/manager]] refreshChangedLayers).
   */
  async pollActivity(reviewId: string): Promise<void> {
    const session = this.record(reviewId)
    if (!session || session.archived) return
    const repoPath = this.repoPathFor(session)
    if (!repoPath) return

    const viewerLogin = await getViewerLogin(repoPath)
    const movedLayers: number[] = []

    for (const layer of session.layers) {
      if (layer.merged) continue
      const posted = session.postedComments.filter(
        (c) => (c.prNumber ?? stackHead(session)?.prNumber) === layer.prNumber
      )
      // 코멘트를 하나도 안 달았으면 따라갈 스레드가 없다. 그래도 리뷰를 제출했다면 새 커밋은
      // 계속 봐야 한다 — 내 지적에 대한 응답이 커밋으로 오기 때문이다.
      const tracksReplies = posted.length > 0
      if (!tracksReplies && !layer.lastSubmission) continue

      // 밀려남(outdated)과 접힘(resolved) 은 둘 다 **인라인 코멘트에만** 있는 개념이다.
      const postedInlineIds = posted.filter((c) => c.kind === 'inline').map((c) => c.commentId)
      const tracksThreads = postedInlineIds.length > 0
      const [reviewComments, issueComments, headSha, threads] = await Promise.all([
        tracksReplies ? listReviewComments(repoPath, layer.prNumber) : null,
        tracksReplies ? listIssueComments(repoPath, layer.prNumber) : null,
        getPrHeadSha(repoPath, layer.prNumber),
        tracksThreads ? listReviewThreads(repoPath, layer.prNumber) : null
      ])
      if (!reviewComments && !issueComments && !headSha && !threads) continue

      // 워터마크가 아직 없으면 "내가 처음 코멘트를 단 시각" 을 기준으로 삼는다. 그러지 않으면
      // PR 의 오래된 대화가 통째로 새 활동으로 쏟아진다.
      const since =
        layer.lastSeenAt ??
        posted.map((c) => c.createdAt).sort()[0] ??
        new Date(session.createdAt).toISOString()

      const { items, nextSince, nextHeadSha } = detectNewActivity({
        reviewComments: reviewComments ?? [],
        issueComments: issueComments ?? [],
        headSha,
        postedCommentIds: postedInlineIds,
        viewerLogin,
        since,
        lastSeenHeadSha: layer.lastSeenHeadSha
      })

      // 새 커밋 항목은 여기서 넣지 않는다 — 위쪽 레이어가 단순 restack 인지 확인한 뒤에
      // 한 번에 정리한다. 답글은 그대로 흘린다.
      //
      // 스레드 답글은 이제 **매번 전부** 올라온다(놓친 것을 채우기 위해). 그래서 이미 같은
      // 내용으로 담아 둔 것은 걸러야 한다 — 그러지 않으면 폴링마다 사이드카에 같은 줄이 쌓이고,
      // 아무것도 바뀌지 않은 폴링이 상태 방송을 일으켜 화면이 계속 다시 그려진다.
      const known = new Map(
        getReviewBundles()
          .load(reviewId)
          .activity.map((a) => [a.id, a])
      )
      let added = 0
      let news = 0
      for (const item of items) {
        if (item.kind === 'commits') {
          movedLayers.push(layer.prNumber)
          continue
        }
        const next = item.kind === 'reply' ? { ...item, prNumber: layer.prNumber } : item
        const before = known.get(next.id)
        if (before && JSON.stringify(before) === JSON.stringify(next)) continue
        this.addActivity(reviewId, next)
        added++
        // 내가 쓴 말은 나에게 새 소식이 아니다. 미확인 점은 남이 한 말에만 붙는다 —
        // 내 답글로도 켜지면 GitHub 에서 답장하고 돌아올 때마다 읽지 않은 점이 붙는다.
        if (!(next.kind === 'reply' && next.author === viewerLogin)) news++
      }

      // 내가 단 코멘트가 최신 diff 에서 밀려났는지도 같은 응답으로 알 수 있다 — 이걸 안 보면
      // 상대가 이미 고쳐 놓은 자리를 두고 사용자는 아직 살아 있는 지적으로 착각한다.
      const outdated = reviewComments
        ? detectOutdatedComments(reviewComments, postedInlineIds)
        : new Map<number, boolean>()
      const outdatedChanged = posted.some(
        (c) => outdated.has(c.commentId) && !!c.outdated !== outdated.get(c.commentId)
      )

      // 스레드가 접혔다는 것은 **상대가 이 지적을 처리했다**는 뜻이다. 답글 없이 조용히 접히는
      // 일이 흔해서, 이것을 따라가지 않으면 끝난 지적과 무시당한 지적이 화면에서 똑같아 보인다.
      const threadStates = threads
        ? detectResolvedThreads(threads, postedInlineIds)
        : new Map<number, ThreadState>()
      const threadChanged = posted.some((c) => {
        const state = threadStates.get(c.commentId)
        return !!state && (!!c.resolved !== state.resolved || c.threadId !== state.threadId)
      })
      // 방금 접힌 것만 알린다. 이미 접혀 있던 것을 매 폴링마다 다시 알리면 타임라인이 무너진다.
      const newlyResolved = posted.filter(
        (c) => !c.resolved && threadStates.get(c.commentId)?.resolved
      )
      for (const c of newlyResolved) {
        const finding = getReviewBundles()
          .load(reviewId)
          .findings.find((f) => f.id === c.findingId)
        this.addActivity(reviewId, {
          id: `resolved-${c.commentId}`,
          kind: 'resolved',
          commentId: c.commentId,
          findingId: c.findingId,
          ...(finding?.anchor ? { path: finding.anchor.file } : {}),
          prNumber: layer.prNumber,
          ts: Date.now()
        })
      }

      if (
        added > 0 ||
        outdatedChanged ||
        threadChanged ||
        nextSince !== layer.lastSeenAt ||
        nextHeadSha !== layer.lastSeenHeadSha
      ) {
        this.patch(reviewId, (r) => {
          const l = r.layers.find((x) => x.prNumber === layer.prNumber)
          if (l) {
            l.lastSeenAt = nextSince
            l.lastSeenHeadSha = nextHeadSha
            l.headSha = nextHeadSha || l.headSha
          }
          if (outdatedChanged) {
            r.postedComments = r.postedComments.map((c) =>
              outdated.has(c.commentId) ? { ...c, outdated: outdated.get(c.commentId) } : c
            )
          }
          if (threadChanged) {
            r.postedComments = r.postedComments.map((c) => {
              const state = threadStates.get(c.commentId)
              return state ? { ...c, threadId: state.threadId, resolved: state.resolved } : c
            })
          }
          if (news > 0 || newlyResolved.length > 0) r.unread = true
        })
      }
    }

    if (movedLayers.length > 0) await this.refreshChangedLayers(reviewId, repoPath, movedLayers)
  }

  /**
   * head 가 움직인 레이어와 **그 위쪽 전부**의 diff 를 다시 받아, 실제로 바뀐 것과 rebase 만 된
   * 것을 갈라 놓는다.
   *
   * 아래 레이어에 커밋 하나가 올라가면 위쪽은 전부 sha 가 바뀌지만 내용은 그대로인 것이 보통이다.
   * sha 로는 그 둘을 구분할 수 없으므로 **내용 지문**으로 구분한다. 아래 레이어는 base 가 움직이지
   * 않았으므로 다시 받지 않는다.
   */
  private async refreshChangedLayers(
    reviewId: string,
    repoPath: string,
    movedPrNumbers: number[]
  ): Promise<void> {
    const session = this.record(reviewId)
    if (!session) return
    const lowest = Math.min(
      ...session.layers.map((l, i) => (movedPrNumbers.includes(l.prNumber) ? i : Infinity))
    )
    if (!Number.isFinite(lowest)) return

    const affected = session.layers.slice(lowest).filter((l) => !l.merged)
    const bundles = getReviewBundles()
    const before = new Map(
      bundles.load(reviewId).diffs.map((d) => [d.prNumber, reviewDiffHash(d.diff)])
    )

    const changed: number[] = []
    const restacked: number[] = []
    for (const layer of affected) {
      const raw = await getPrDiffRaw(repoPath, layer.prNumber)
      if (raw === null) continue
      const diff = parseReviewDiff(raw)
      bundles.setDiff(reviewId, layer.prNumber, diff)
      if (before.get(layer.prNumber) === reviewDiffHash(diff)) restacked.push(layer.prNumber)
      else changed.push(layer.prNumber)
    }

    this.emit(reviewId, { type: 'diff', diffs: bundles.load(reviewId).diffs })

    for (const prNumber of changed) {
      this.addActivity(reviewId, {
        id: `commits-${prNumber}-${Date.now()}`,
        kind: 'commits',
        headSha: session.layers.find((l) => l.prNumber === prNumber)?.headSha ?? '',
        prNumber,
        ts: Date.now()
      })
    }
    // rebase 만 된 레이어는 한 줄로 묶는다. N 줄로 알리면 진짜 바뀐 것이 묻힌다.
    if (restacked.length > 0) {
      this.addActivity(reviewId, {
        id: `restack-${restacked.join('-')}-${Date.now()}`,
        kind: 'restack',
        prNumbers: restacked,
        causedBy: session.layers[lowest].prNumber,
        ts: Date.now()
      })
    }
    if (changed.length > 0 || restacked.length > 0) {
      this.patch(reviewId, (r) => {
        r.unread = true
      })
    }
  }

  /** 사용자가 리뷰를 열어 확인했다 — 미확인 표시를 끈다. */
  markSeen(reviewId: string): void {
    const session = this.record(reviewId)
    if (!session?.unread) return
    this.patch(reviewId, (r) => {
      r.unread = false
    })
  }

  /** 인라인 스레드에 답장한다. 새 코멘트가 아니라 기존 대화에 붙는다. */
  async replyToThread(
    reviewId: string,
    commentId: number,
    body: string
  ): Promise<{ url?: string; error?: string }> {
    const session = this.record(reviewId)
    if (!session) return { error: 'Review session not found.' }
    const repoPath = this.repoPathFor(session)
    if (!repoPath) return { error: 'Repository not found.' }

    // 답장은 **그 코멘트가 달린 PR** 로 가야 한다. 스레드 id 는 PR 마다 따로 노는 값이라,
    // 다른 PR 에 보내면 GitHub 이 모르는 스레드라며 거절한다.
    const posted = session.postedComments.find((c) => c.commentId === commentId)
    const layer = layerFor(session, posted?.prNumber)
    if (!layer) return { error: 'Could not tell which pull request that thread belongs to.' }

    const res = await replyToReviewComment(repoPath, layer.prNumber, commentId, body)
    if (res.error) return { error: res.error }

    // 내가 쓴 답장도 타임라인에 남긴다 — 폴링은 남의 것만 가져오므로 여기서 넣지 않으면
    // 방금 보낸 말이 화면에서 사라진 것처럼 보인다.
    //
    // 스레드는 **GitHub 이 알려준 루트**로 묶는다. 답글에 답장하면 내가 넘긴 commentId 는
    // 스레드 루트가 아니라 그 답글이라, 그대로 쓰면 내 말만 다른 스레드로 떨어져 나간다
    // (폴링은 내 코멘트를 걸러내므로 영영 바로잡히지 않는다).
    this.addActivity(reviewId, {
      id: res.id ? `reply-${res.id}` : `local-reply-${Date.now()}`,
      kind: 'reply',
      threadRootId: res.inReplyToId ?? commentId,
      commentId: res.id ?? 0,
      author: (await getViewerLogin(repoPath)) ?? 'you',
      body: body.trim(),
      htmlUrl: res.url ?? '',
      prNumber: layer.prNumber,
      ts: Date.now()
    })
    return { url: res.url }
  }

  // ── 후속 대화 ───────────────────────────────────────────────────────────

  /**
   * 앞선 리뷰 맥락 위에서 추가 질문·지시를 던진다.
   *
   * 아카이브된 리뷰라면 워크트리를 먼저 되살린다 — 아카이브 때 ref 를 남겨 둔 이유가
   * 여기서 쓰인다(네트워크 없이 리뷰가 봤던 트리를 그대로 복원).
   */
  async followUp(
    reviewId: string,
    text: string,
    opts: { model: string | null; effort: EffortSetting | null }
  ): Promise<{ error?: string }> {
    const session = this.record(reviewId)
    if (!session) return { error: 'Review session not found.' }
    if (!session.agentSessionId) {
      return { error: 'This review has no agent session to continue — start a new review instead.' }
    }
    if (this.running.has(reviewId)) return { error: 'The agent is still working on this review.' }
    const repoPath = this.repoPathFor(session)
    if (!repoPath) return { error: 'Repository not found.' }

    const message = text.trim()
    if (!message) return { error: 'Nothing to send.' }

    // 사용자의 말을 남기고 상태를 올리는 일이 **가장 먼저** 와야 한다. 워크트리 준비는 원격
    // fetch 라 몇 초씩 걸리는데, 그 뒤로 밀면 보낸 티가 그동안 아무 데도 안 나 화면이 멈춘 것처럼
    // 보인다(입력창도 안 잠겨 같은 말을 또 보내게 된다).
    this.addActivity(reviewId, {
      id: randomUUID(),
      kind: 'turn',
      role: 'user',
      text: message,
      ts: Date.now()
    })

    const abort = new AbortController()
    this.running.set(reviewId, abort)
    this.setStatus(reviewId, 'preparing')
    try {
      const prepared = await prepareReviewWorktree(this.keyFor(session, repoPath))
      if ('error' in prepared) {
        this.fail(reviewId, prepared.error)
        return { error: prepared.error }
      }
      if (abort.signal.aborted) {
        this.setStatus(reviewId, 'cancelled')
        return {}
      }

      const bundle = getReviewBundles().load(reviewId)
      // **diff 를 다시 받는다.** 워크트리는 방금 최신 head 로 옮겨졌는데(prepareReviewWorktree)
      // diff 만 옛 것이면, "고쳤으니 다시 봐줘" 로 나온 새 지적이 옛 줄 번호에 고정된다 —
      // 엉뚱한 줄에 달리거나, 앵커에 실패해 전반 지적으로 강등된다.
      // 못 받으면 갖고 있던 것으로 돈다. 답 하나 때문에 턴 전체를 버릴 이유는 없다.
      const refreshed = await this.fetchDiffs(reviewId, repoPath, session.layers)
      const diffs = 'error' in refreshed ? bundle.diffs : refreshed.diffs
      if ('error' in refreshed)
        log.warn(`review: follow-up kept the cached diff (${refreshed.error})`)
      if (abort.signal.aborted) {
        this.setStatus(reviewId, 'cancelled')
        return {}
      }

      this.setStatus(reviewId, 'running')
      const result = await runReview({
        backend: session.agentBackend,
        cwd: prepared.path,
        repoPath,
        model: opts.model,
        effort: opts.effort,
        userPrompt: message,
        promptOverride: buildFollowUpPrompt(
          message,
          this.recentContext(session, bundle.activity),
          promptFindings(session, bundle.findings)
        ),
        resumeSessionId: session.agentSessionId,
        meta: { layers: promptLayers(session) },
        diffs,
        abort,
        onProgress: (item) => this.emit(reviewId, { type: 'progress', item })
      })

      if (abort.signal.aborted) {
        this.setStatus(reviewId, 'cancelled')
        return {}
      }

      // 실패한 턴의 세션 id 도 남긴다 — 이 질문을 이어서 다시 돌리려면 그 맥락이 있어야 한다.
      if (result.sessionId) {
        const sessionId = result.sessionId
        this.patch(reviewId, (r) => {
          r.agentSessionId = sessionId
        })
      }
      if (result.error) {
        this.fail(reviewId, result.error)
        return { error: result.error }
      }

      const answer = result.artifact?.reply?.trim() || result.rawText.trim()
      if (answer) {
        this.addActivity(reviewId, {
          id: randomUUID(),
          kind: 'turn',
          role: 'agent',
          text: answer,
          ts: Date.now()
        })
      }

      // 앞선 지적을 **먼저** 정리한다 — 고쳐 쓰기·거둬들이기가 새 지적보다 뒤로 밀리면,
      // 방금 낸 지적을 같은 턴 안에서 거둬들이라는 지시가 통해 버린다.
      const revised = this.reviseFindings(reviewId, result.artifact)

      // 새 지적은 **덧붙인다** — 앞선 지적은 이미 게시됐을 수 있어 통째로 교체하면 추적이 끊긴다.
      const extra = result.artifact
        ? buildFindings(
            diffs,
            {
              ...result.artifact,
              summary: '',
              reply: '',
              layers: []
            },
            session.layers
          )
        : []
      if (extra.length) {
        const bundles = getReviewBundles()
        for (const f of extra) bundles.upsertFinding(reviewId, f)
      }
      if (extra.length || revised.updated.length || revised.removed.length) {
        this.emit(reviewId, {
          type: 'findings',
          findings: [...revised.updated, ...extra],
          removed: revised.removed
        })
      }

      // 다시 본 결과 총평이 달라졌다면 그것으로 갈아 끼운다. **빈 값은 무시한다** — 질문 하나에
      // 답한 턴까지 총평을 비우면, 제출 모달이 리뷰의 결론을 잃은 채로 열린다.
      const artifact = result.artifact
      this.patch(reviewId, (r) => {
        if (artifact?.summary.trim()) r.summary = artifact.summary
        for (const l of r.layers) {
          const summary = artifact?.layers.find((x) => x.prNumber === l.prNumber)?.summary
          if (summary?.trim()) l.summary = summary
        }
        r.lastError = null
      })
      this.setStatus(reviewId, 'done')
      return {}
    } finally {
      this.running.delete(reviewId)
    }
  }

  /**
   * 후속 턴에 곁들일 최근 활동 요약(가져온 답글·새 커밋·restack). 모델이 맥락을 놓치지 않게.
   *
   * 스택에서는 **어느 레이어의 일인지**가 곧 맥락이다 — "#12 에 새 커밋" 과 "#14 에 새 커밋" 은
   * 다음에 무엇을 다시 봐야 하는지가 완전히 다르다.
   */
  private recentContext(session: ReviewSession, activity: ReviewActivityItem[]): string[] {
    const at = (prNumber?: number): string =>
      prNumber && session.layers.length > 1 ? ` on #${prNumber}` : ''
    return activity
      .slice(-12)
      .map((a) => {
        if (a.kind === 'reply') {
          const where = a.path ? ` on ${a.path}${a.line ? `:${a.line}` : ''}` : at(a.prNumber)
          return `@${a.author} replied${where}:\n${a.body}`
        }
        if (a.kind === 'commits') {
          return `New commits were pushed${at(a.prNumber)} (head is now ${a.headSha.slice(0, 12)}).`
        }
        if (a.kind === 'restack') {
          return (
            `${a.prNumbers.map((n) => `#${n}`).join(', ')} were restacked onto the new #${a.causedBy}. ` +
            `Their diffs are unchanged — nothing in them needs re-reading.`
          )
        }
        return ''
      })
      .filter(Boolean)
  }

  // ── 이벤트 ──────────────────────────────────────────────────────────────

  private emit(reviewId: string, event: ReviewEvent): void {
    this.dispatch({ reviewId, event })
  }

  /** 활동 항목을 사이드카에 남기고 화면에도 흘린다. */
  addActivity(reviewId: string, item: ReviewActivityItem): void {
    getReviewBundles().addActivity(reviewId, item)
    this.emit(reviewId, { type: 'activity', item })
  }

  private setStatus(reviewId: string, status: ReviewStatus): void {
    this.patch(reviewId, (r) => {
      r.status = status
    })
    this.emit(reviewId, { type: 'status', status })
  }

  /**
   * 실행이 실패했다. 이유를 **레코드에 남기고** 상태를 error 로 내린다.
   *
   * 남기는 이유는 이어서 돌릴 수 있기 때문이다 — 사용자는 "왜 멈췄나"(사용량 제한이면 언제
   * 풀리나)를 보고 다시 누를지 정한다. 이벤트로만 흘리면 그 판단 근거가 앱을 껐다 켜는 순간
   * 사라진다.
   */
  private fail(reviewId: string, message: string): void {
    const rateLimited = RATE_LIMIT_ERROR.test(message)
    const failure: ReviewFailure = {
      message,
      rateLimited,
      resetsAt: rateLimited ? rateLimitResetAt(message, Date.now()) : null
    }
    this.patch(reviewId, (r) => {
      r.lastError = failure
    })
    this.emit(reviewId, { type: 'error', message })
    this.setStatus(reviewId, 'error')
  }
}

/** 내가 쓴 PR 인가. 세션에 박아 둔 판정을 먼저 믿고, 비어 있으면 지금 계정과 비교한다. */
function isOwn(layer: ReviewLayer, viewerLogin: string | null): boolean {
  if (layer.viewerIsAuthor) return true
  if (!layer.prAuthor) return false
  return viewerLogin === layer.prAuthor
}

/**
 * 세션 레코드에서 프롬프트가 쓸 레이어 정보를 만든다.
 *
 * base ref 는 **아래 레이어가 있으면 그 레이어의 로컬 ref**다 — PR 의 base 브랜치 이름
 * (`origin/<base>`)은 아래 레이어가 아직 병합되지 않았다면 그 레이어의 head 와 다르고, 그 상태로
 * `git diff` 를 돌리면 아래 레이어의 변경까지 섞여 나온다.
 */
function promptLayers(session: ReviewSession): ReviewPromptLayer[] {
  return session.layers.map((layer, i) => ({
    number: layer.prNumber,
    title: layer.prTitle,
    baseRefName: layer.baseRefName,
    headRefName: layer.headRefName,
    headSha: layer.headSha,
    localRef: reviewRefFor(session.id, layer.prNumber),
    baseRef:
      i > 0
        ? reviewRefFor(session.id, session.layers[i - 1].prNumber)
        : `origin/${layer.baseRefName}`
  }))
}

/**
 * 후속 턴 프롬프트에 실을 지적 목록.
 *
 * 에이전트가 자기 지적을 다시 가리키려면 **핸들과 지금 상태**가 둘 다 필요하다 — 핸들이 없으면
 * 고쳐 쓸 대상을 지목할 수 없고, 상태가 없으면 이미 게시돼 손댈 수 없는 것까지 거둬들이려 든다.
 */
function promptFindings(session: ReviewSession, findings: ReviewFinding[]): PromptFinding[] {
  const stacked = session.layers.length > 1
  const posted = new Map(session.postedComments.map((c) => [c.findingId, c]))
  return findings.map((f) => {
    const at = posted.get(f.id)
    const marks = at
      ? ['posted', ...(at.resolved ? ['resolved'] : []), ...(at.outdated ? ['outdated'] : [])]
      : ['pending']
    return {
      handle: findingHandle(f.id),
      severity: f.severity,
      title: f.title,
      where: describeWhere(f, stacked),
      state: marks.join(' · '),
      locked: !!at
    }
  })
}

/** 지적이 걸린 자리를 한 조각으로 — 목록에서 같은 제목 둘을 가르는 것이 대개 이 값이다. */
function describeWhere(finding: ReviewFinding, stacked: boolean): string {
  if (finding.anchor) {
    const at = stacked && finding.anchor.prNumber ? `#${finding.anchor.prNumber} ` : ''
    return `${at}${finding.anchor.file}:${finding.anchor.line}`
  }
  if (finding.stackPrNumbers?.length) {
    return `stack ${finding.stackPrNumbers.map((n) => `#${n}`).join('→')}`
  }
  return stacked && finding.prNumber ? `#${finding.prNumber} general` : 'general'
}

/**
 * 에이전트가 준 지적을 diff 의 실제 줄에 고정한다.
 *
 * 앵커에 실패한 인라인 지적은 **버리지 않고** 전반 지적으로 강등하면서 원래 위치를 본문에
 * 남긴다. 위치를 못 찾았다는 이유로 리뷰 내용까지 사라지면 사용자는 무엇을 놓쳤는지도 모른다.
 */
export function buildFindings(
  diffs: ReviewLayerDiff[],
  artifact: ReviewArtifact,
  layers: Array<Pick<ReviewLayer, 'prNumber'>>
): ReviewFinding[] {
  const out: ReviewFinding[] = []
  const known = new Set(layers.map((l) => l.prNumber))
  const fallback = layers[layers.length - 1]?.prNumber
  /** 에이전트가 지목한 PR 이 이 리뷰의 것이 아니면 무시한다 — 남의 PR 에 코멘트를 달 수는 없다. */
  const target = (n: number | undefined): number | undefined =>
    n !== undefined && known.has(n) ? n : fallback

  for (const input of artifact.inline) {
    const { anchor, reason } = resolveStackAnchor(diffs, input)
    if (anchor) {
      out.push({
        id: randomUUID(),
        severity: input.severity,
        title: input.title,
        body: input.body,
        anchor,
        ...(anchor.prNumber === undefined ? {} : { prNumber: anchor.prNumber })
      })
      continue
    }
    const where = input.prNumber ? `#${input.prNumber} ` : ''
    const origin = input.file
      ? `\`${where}${input.file}${typeof input.line === 'number' ? `:${input.line}` : ''}\` — `
      : ''
    out.push({
      id: randomUUID(),
      severity: input.severity,
      title: input.title,
      body: `${origin}${input.body}`,
      anchor: null,
      ...(target(input.prNumber) === undefined ? {} : { prNumber: target(input.prNumber)! })
    })
    if (reason) log.info(`review: demoted an inline finding to general (${reason})`)
  }

  for (const input of artifact.general) {
    out.push({
      id: randomUUID(),
      severity: input.severity,
      title: input.title,
      body: input.body,
      anchor: null,
      ...(target(input.prNumber) === undefined ? {} : { prNumber: target(input.prNumber)! })
    })
  }

  for (const input of artifact.stack) {
    // 이 리뷰가 보는 레이어만 남긴다. 모델이 없는 번호를 지어내면 게시 대상이 사라진다.
    const mentioned = (input.stackPrNumbers ?? []).filter((n) => known.has(n))
    const ordered = layers.map((l) => l.prNumber).filter((n) => mentioned.includes(n))
    // 가장 아래 레이어에 단다 — 먼저 바뀌어야 하는 쪽이고, 순서·경계 문제는 거기서 시작한다.
    const prNumber = ordered[0] ?? target(undefined)
    out.push({
      id: randomUUID(),
      severity: input.severity,
      title: input.title,
      body: stackBody(input.body, ordered),
      anchor: null,
      ...(prNumber === undefined ? {} : { prNumber }),
      ...(ordered.length > 0 ? { stackPrNumbers: ordered } : {})
    })
  }

  return out
}

/**
 * 스택 지적의 본문 앞에 어느 레이어들에 대한 말인지 한 줄을 박는다.
 *
 * 게시된 코멘트는 PR 하나의 타임라인에 홀로 놓인다. "이건 스택 전체에 대한 말" 이라는 사실이
 * 본문 안에 없으면, 받는 사람은 이 PR 하나에 대한 지적으로 읽는다. 본문에 넣어 두면 게시는
 * 지금까지처럼 **그대로(verbatim)** 나가고, 사용자가 화면에서 보고 고칠 수도 있다
 * (인라인 지적을 강등할 때 원래 위치를 붙이는 것과 같은 방식이다).
 */
function stackBody(body: string, prNumbers: number[]): string {
  if (prNumbers.length === 0) return body
  return `**Stack review** · ${prNumbers.map((n) => `#${n}`).join(' → ')}\n\n${body}`
}
