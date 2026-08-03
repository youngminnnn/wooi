import { randomUUID } from 'node:crypto'
import type {
  AgentBackendId,
  EffortSetting,
  Repo,
  ReviewActivityItem,
  ReviewArtifact,
  ReviewBundle,
  ReviewDiff,
  ReviewEvent,
  ReviewFinding,
  ReviewSession,
  ReviewStatus,
  ReviewVerdict
} from '@shared/types'
import { EMPTY_RESUBMIT_BLOCKED, SELF_REVIEW_BLOCKED } from '@shared/types'
import {
  getPrDiffRaw,
  getPrHeadSha,
  getPrReviewMeta,
  getViewerLogin,
  listIssueComments,
  listReviewComments,
  postInlineComment,
  postIssueComment,
  replyToReviewComment,
  submitPrReview
} from '../github'
import { log } from '../logger'
import { getStore } from '../store'
import { detectNewActivity } from './activity'
import { parseReviewDiff, resolveAnchor } from './diff'
import { getReviewBundles } from './store'
import { runReview } from './run'
import { buildFollowUpPrompt } from './prompt'
import { disposeReviewWorktree, prepareReviewWorktree, type ReviewWorktreeKey } from './worktree'

export interface StartReviewArgs {
  repo: Repo
  prNumber: number
  prompt: string
  /** 이 리뷰를 돌릴 에이전트. 세션에 박히고 후속 턴도 같은 것을 쓴다. */
  agentBackend: AgentBackendId
  model: string | null
  effort: EffortSetting | null
}

/**
 * 리뷰 세션의 수명을 관리한다.
 *
 * **영속 상태는 app.json 이 갖는다** — 사이드바가 워크스페이스와 같은 상태 방송으로 리뷰를
 * 그리고, 앱을 껐다 켜도 남아야 하기 때문이다. 이 클래스가 메모리에 들고 있는 건 프로세스와
 * 함께 사라져야 하는 것뿐이다(실행 중인 query 의 AbortController).
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
    return { repoPath, prNumber: session.prNumber, reviewId: session.id }
  }

  private repoPathFor(session: ReviewSession): string | null {
    return (
      getStore()
        .getState()
        .repos.find((r) => r.id === session.repoId)?.path ?? null
    )
  }

  // ── 시작 ────────────────────────────────────────────────────────────────

  async start(args: StartReviewArgs): Promise<{ reviewId: string } | { error: string }> {
    const { repo, prNumber } = args

    // PR 을 못 찾으면 레코드를 만들기 전에 끝낸다 — 실패를 즉시, 정확히 알려주기 위함.
    // 내 계정은 캐시돼 있어 같이 물어봐도 비용이 없다.
    const [meta, viewerLogin] = await Promise.all([
      getPrReviewMeta(repo.path, prNumber),
      getViewerLogin(repo.path)
    ])
    if (!meta) {
      return {
        error: `Couldn't find PR #${prNumber}. Check the number and that GitHub is connected.`
      }
    }

    const reviewId = randomUUID()
    const now = Date.now()
    const session: ReviewSession = {
      id: reviewId,
      repoId: repo.id,
      agentBackend: args.agentBackend,
      prNumber: meta.number,
      prUrl: meta.url,
      prTitle: meta.title,
      prAuthor: meta.author,
      viewerIsAuthor: !!viewerLogin && !!meta.author && viewerLogin === meta.author,
      headSha: meta.headSha,
      baseRefName: meta.baseRefName,
      prompt: args.prompt,
      status: 'preparing',
      summary: '',
      archived: false,
      createdAt: now,
      updatedAt: now,
      agentSessionId: null,
      postedComments: [],
      lastSeenAt: null,
      lastSeenHeadSha: meta.headSha,
      unread: false,
      lastSubmission: null
    }
    getStore().update((st) => {
      st.reviews.push(session)
    })
    this.broadcastState()

    // 나머지는 백그라운드로 — 워크트리 준비와 에이전트 실행은 수 분이 걸릴 수 있다.
    void this.run(reviewId, repo.path, args).catch((err) => {
      log.error('review: pipeline failed', err)
      this.fail(reviewId, String(err))
    })

    return { reviewId }
  }

  private async run(reviewId: string, repoPath: string, args: StartReviewArgs): Promise<void> {
    const session = this.record(reviewId)
    if (!session) return

    const abort = new AbortController()
    this.running.set(reviewId, abort)
    try {
      const prepared = await prepareReviewWorktree(this.keyFor(session, repoPath))
      if ('error' in prepared) return this.fail(reviewId, prepared.error)
      if (abort.signal.aborted) return

      const raw = await getPrDiffRaw(repoPath, session.prNumber)
      if (raw === null) return this.fail(reviewId, 'Failed to fetch the PR diff.')
      const diff = parseReviewDiff(raw)
      if (diff.files.length === 0) return this.fail(reviewId, 'This PR has no changed files.')
      getReviewBundles().setDiff(reviewId, diff)
      this.emit(reviewId, { type: 'diff', diff })

      this.setStatus(reviewId, 'running')
      const result = await runReview({
        backend: session.agentBackend,
        cwd: prepared.path,
        repoPath,
        model: args.model,
        effort: args.effort,
        userPrompt: args.prompt,
        meta: {
          number: session.prNumber,
          title: session.prTitle,
          baseRefName: session.baseRefName,
          headSha: session.headSha
        },
        diff,
        abort,
        onProgress: (item) => this.emit(reviewId, { type: 'progress', item })
      })

      if (abort.signal.aborted) return this.setStatus(reviewId, 'cancelled')
      if (result.error) return this.fail(reviewId, result.error)

      // 후속 턴을 같은 맥락으로 이어 붙이려면 세션 id 를 남겨야 한다.
      if (result.sessionId) {
        const sessionId = result.sessionId
        this.patch(reviewId, (r) => {
          r.agentSessionId = sessionId
        })
      }

      // 구조화 출력이 없으면 원문이라도 살려서 총평 하나로 보여준다. 리뷰를 통째로 잃는 것보다 낫다.
      const artifact: ReviewArtifact = result.artifact ?? {
        summary: result.rawText.trim() || 'The review result could not be structured.',
        reply: '',
        general: [],
        inline: []
      }

      const findings = buildFindings(diff, artifact)
      const bundles = getReviewBundles()
      for (const f of findings) bundles.upsertFinding(reviewId, f)

      this.patch(reviewId, (r) => {
        r.summary = artifact.summary
      })
      this.emit(reviewId, { type: 'findings', findings })
      this.setStatus(reviewId, 'done')
    } finally {
      this.running.delete(reviewId)
    }
  }

  // ── 조회 ────────────────────────────────────────────────────────────────

  /** 리뷰 화면 진입 시 사이드카를 통째로 읽어 준다. */
  loadBundle(reviewId: string): ReviewBundle {
    return getReviewBundles().load(reviewId)
  }

  // ── 수명 관리 ───────────────────────────────────────────────────────────

  /** 실행 중인 리뷰를 중단한다. 결과·워크트리는 그대로 둔다. */
  cancel(reviewId: string): void {
    const abort = this.running.get(reviewId)
    if (!abort) return
    abort.abort()
    this.setStatus(reviewId, 'cancelled')
  }

  /**
   * 아카이브 — 파생물(워크트리)만 지우고 정체성·기록은 남긴다.
   *
   * ref 를 유지하는 게 핵심이다. PR head 커밋을 붙잡아 둬 GC 되지 않으므로, 되살릴 때
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

    const text = body.trim()
    if (!text) return { error: 'The comment body is empty.' }

    const res = finding.anchor
      ? await postInlineComment(repoPath, session.prNumber, {
          body: text,
          commitId: session.headSha,
          path: finding.anchor.file,
          line: finding.anchor.line,
          side: finding.anchor.side,
          startLine: finding.anchor.startLine
        })
      : await postIssueComment(repoPath, session.prNumber, text)

    if (res.error) return { error: res.error }

    if (res.id !== undefined) {
      const commentId = res.id
      const kind = finding.anchor ? ('inline' as const) : ('issue' as const)
      const createdAt = res.createdAt ?? new Date().toISOString()
      const htmlUrl = res.url ?? ''
      this.patch(reviewId, (r) => {
        r.postedComments = [
          ...r.postedComments.filter((c) => c.findingId !== findingId),
          { findingId, commentId, htmlUrl, kind, createdAt }
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
   * PR 전체에 대한 판정을 제출한다(Approve / Request changes / Comment).
   *
   * 개별 코멘트 게시와 독립적이다 — 코멘트를 하나도 안 달고 승인만 할 수도, 코멘트를 다 달고
   * 마지막에 변경 요청을 낼 수도 있다.
   */
  async submitReview(
    reviewId: string,
    verdict: ReviewVerdict,
    body: string
  ): Promise<{ error?: string }> {
    const session = this.record(reviewId)
    if (!session) return { error: 'Review session not found.' }
    const repoPath = this.repoPathFor(session)
    if (!repoPath) return { error: 'Repository not found.' }

    // UI 는 이미 선택지를 감추지만, 여기서도 막는다 — 세션을 만들 때 내 계정을 몰랐거나
    // (gh 미연결) 옛 레코드라 플래그가 비어 있을 수 있고, 그때 GitHub 이 돌려주는 건
    // 사용자가 해석할 수 없는 GraphQL 에러다.
    if (verdict !== 'comment' && (await this.isOwnPr(session, repoPath))) {
      return { error: SELF_REVIEW_BLOCKED }
    }

    // 이미 한 번 낸 리뷰를 빈 본문으로 또 내는 건 같은 말의 반복이다. 승인은 GitHub 이 본문
    // 없이도 받아 주므로 여기서만 걸린다.
    if (session.lastSubmission && !body.trim()) return { error: EMPTY_RESUBMIT_BLOCKED }

    const res = await submitPrReview(repoPath, session.prNumber, verdict, body)
    if (res.error) return res

    // 총평은 방금 PR 로 갔다. 여기서 비워야 제출 모달이 빈 본문으로 다시 열리고, 같은 말이
    // 무심코 또 올라가지 않는다(코멘트·변경 요청은 본문 없이는 나가지 않는다).
    this.patch(reviewId, (r) => {
      r.lastSubmission = { verdict, at: Date.now() }
      r.summary = ''
    })
    return {}
  }

  /**
   * 내가 쓴 PR 인가. 세션에 박아 둔 판정을 먼저 믿고, 비어 있을 때만 지금 확인한다
   * (작성자를 모르면 막지 않는다 — 확실하지 않은 이유로 정상적인 리뷰를 가로막지 않기 위함).
   */
  private async isOwnPr(session: ReviewSession, repoPath: string): Promise<boolean> {
    if (session.viewerIsAuthor) return true
    if (!session.prAuthor) return false
    return (await getViewerLogin(repoPath)) === session.prAuthor
  }

  // ── 상대방 활동 추적 ────────────────────────────────────────────────────

  /**
   * 내가 단 코멘트의 답글과 새 커밋을 가져온다.
   *
   * 세션당 셸 호출을 최소로 묶는다 — runLoginShell 은 매번 로그인 셸을 띄우므로 코멘트마다
   * 부르면 폴링이 그 자체로 부담이 된다.
   */
  async pollActivity(reviewId: string): Promise<void> {
    const session = this.record(reviewId)
    if (!session || session.archived) return
    // 코멘트를 하나도 안 달았으면 따라갈 스레드가 없다. 그래도 리뷰를 제출했다면 새 커밋은
    // 계속 봐야 한다 — 내 지적에 대한 응답이 커밋으로 오기 때문이다.
    const tracksReplies = session.postedComments.length > 0
    if (!tracksReplies && !session.lastSubmission) return
    const repoPath = this.repoPathFor(session)
    if (!repoPath) return

    const [reviewComments, issueComments, headSha, viewerLogin] = await Promise.all([
      tracksReplies ? listReviewComments(repoPath, session.prNumber) : null,
      tracksReplies ? listIssueComments(repoPath, session.prNumber) : null,
      getPrHeadSha(repoPath, session.prNumber),
      getViewerLogin(repoPath)
    ])
    if (!reviewComments && !issueComments && !headSha) return

    // 워터마크가 아직 없으면 "내가 처음 코멘트를 단 시각" 을 기준으로 삼는다. 그러지 않으면
    // PR 의 오래된 대화가 통째로 새 활동으로 쏟아진다.
    const since =
      session.lastSeenAt ??
      session.postedComments.map((c) => c.createdAt).sort()[0] ??
      new Date(session.createdAt).toISOString()

    const { items, nextSince, nextHeadSha } = detectNewActivity({
      reviewComments: reviewComments ?? [],
      issueComments: issueComments ?? [],
      headSha,
      postedCommentIds: session.postedComments
        .filter((c) => c.kind === 'inline')
        .map((c) => c.commentId),
      viewerLogin,
      since,
      lastSeenHeadSha: session.lastSeenHeadSha
    })

    // 항목 id 가 안정적이라(reply-<코멘트id>) 다시 폴링해도 중복으로 쌓이지 않는다.
    for (const item of items) this.addActivity(reviewId, item)

    if (
      items.length > 0 ||
      nextSince !== session.lastSeenAt ||
      nextHeadSha !== session.lastSeenHeadSha
    ) {
      this.patch(reviewId, (r) => {
        r.lastSeenAt = nextSince
        r.lastSeenHeadSha = nextHeadSha
        if (items.length > 0) r.unread = true
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

    const res = await replyToReviewComment(repoPath, session.prNumber, commentId, body)
    if (res.error) return { error: res.error }

    // 내가 쓴 답장도 타임라인에 남긴다 — 폴링은 남의 것만 가져오므로 여기서 넣지 않으면
    // 방금 보낸 말이 화면에서 사라진 것처럼 보인다.
    this.addActivity(reviewId, {
      id: res.id ? `reply-${res.id}` : `local-reply-${Date.now()}`,
      kind: 'reply',
      threadRootId: commentId,
      commentId: res.id ?? 0,
      author: (await getViewerLogin(repoPath)) ?? 'you',
      body: body.trim(),
      htmlUrl: res.url ?? '',
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

    const prepared = await prepareReviewWorktree(this.keyFor(session, repoPath))
    if ('error' in prepared) return { error: prepared.error }

    // 사용자의 말을 먼저 타임라인에 남긴다 — 응답을 기다리는 동안 화면이 비지 않도록.
    this.addActivity(reviewId, {
      id: randomUUID(),
      kind: 'turn',
      role: 'user',
      text: message,
      ts: Date.now()
    })

    const bundle = getReviewBundles().load(reviewId)
    const abort = new AbortController()
    this.running.set(reviewId, abort)
    this.setStatus(reviewId, 'running')
    try {
      const result = await runReview({
        backend: session.agentBackend,
        cwd: prepared.path,
        repoPath,
        model: opts.model,
        effort: opts.effort,
        userPrompt: message,
        promptOverride: buildFollowUpPrompt(message, this.recentContext(bundle.activity)),
        resumeSessionId: session.agentSessionId,
        meta: {
          number: session.prNumber,
          title: session.prTitle,
          baseRefName: session.baseRefName,
          headSha: session.headSha
        },
        diff: bundle.diff ?? { files: [] },
        abort,
        onProgress: (item) => this.emit(reviewId, { type: 'progress', item })
      })

      if (abort.signal.aborted) {
        this.setStatus(reviewId, 'cancelled')
        return {}
      }
      if (result.error) {
        this.fail(reviewId, result.error)
        return { error: result.error }
      }

      if (result.sessionId) {
        const sessionId = result.sessionId
        this.patch(reviewId, (r) => {
          r.agentSessionId = sessionId
        })
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

      // 후속 턴의 지적은 **덧붙인다** — 앞선 지적은 이미 게시됐을 수 있어 교체하면 추적이 끊긴다.
      const extra = result.artifact
        ? buildFindings(bundle.diff ?? { files: [] }, {
            summary: '',
            reply: '',
            general: result.artifact.general,
            inline: result.artifact.inline
          })
        : []
      if (extra.length) {
        const bundles = getReviewBundles()
        for (const f of extra) bundles.upsertFinding(reviewId, f)
        this.emit(reviewId, { type: 'findings', findings: extra })
      }

      this.setStatus(reviewId, 'done')
      return {}
    } finally {
      this.running.delete(reviewId)
    }
  }

  /** 후속 턴에 곁들일 최근 활동 요약(가져온 답글·새 커밋). 모델이 맥락을 놓치지 않게. */
  private recentContext(activity: ReviewActivityItem[]): string[] {
    return activity
      .slice(-12)
      .map((a) => {
        if (a.kind === 'reply') {
          const where = a.path ? ` on ${a.path}${a.line ? `:${a.line}` : ''}` : ''
          return `@${a.author} replied${where}:\n${a.body}`
        }
        if (a.kind === 'commits')
          return `New commits were pushed (head is now ${a.headSha.slice(0, 12)}).`
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

  private fail(reviewId: string, message: string): void {
    this.emit(reviewId, { type: 'error', message })
    this.setStatus(reviewId, 'error')
  }
}

/**
 * 에이전트가 준 지적을 diff 의 실제 줄에 고정한다.
 *
 * 앵커에 실패한 인라인 지적은 **버리지 않고** 전반 지적으로 강등하면서 원래 위치를 본문에
 * 남긴다. 위치를 못 찾았다는 이유로 리뷰 내용까지 사라지면 사용자는 무엇을 놓쳤는지도 모른다.
 */
export function buildFindings(diff: ReviewDiff, artifact: ReviewArtifact): ReviewFinding[] {
  const out: ReviewFinding[] = []

  for (const input of artifact.inline) {
    const { anchor, reason } = resolveAnchor(diff, input)
    if (anchor) {
      out.push({
        id: randomUUID(),
        severity: input.severity,
        title: input.title,
        body: input.body,
        anchor
      })
      continue
    }
    const origin = input.file
      ? `\`${input.file}${typeof input.line === 'number' ? `:${input.line}` : ''}\` — `
      : ''
    out.push({
      id: randomUUID(),
      severity: input.severity,
      title: input.title,
      body: `${origin}${input.body}`,
      anchor: null
    })
    if (reason) log.info(`review: demoted an inline finding to general (${reason})`)
  }

  for (const input of artifact.general) {
    out.push({
      id: randomUUID(),
      severity: input.severity,
      title: input.title,
      body: input.body,
      anchor: null
    })
  }

  return out
}
