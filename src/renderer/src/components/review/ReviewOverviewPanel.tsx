import { Layers } from 'lucide-react'
import type { ReviewSession } from '@shared/types'
import { isStackReview } from '@shared/types'
import { isStackFinding, layerOfFinding, type ReviewViewState } from '../../lib/review'
import { MarkdownBody } from '../ChatPrimitives'
import ReviewFindingCard from './ReviewFindingCard'

/**
 * 총평과 "특정 줄에 붙일 수 없는" 지적을 모아 보여준다.
 *
 * 앵커 해석에 실패한 인라인 지적도 여기로 강등돼 내려온다(본문 앞에 원래 위치가 붙어 있다) —
 * 위치를 못 찾았다는 이유로 리뷰 내용을 버리지 않기 위한 설계다.
 *
 * 스택 지적(레이어 경계·순서·중복)은 **맨 위에 따로 묶는다.** 스택 리뷰를 도는 이유가 그것이라,
 * 일반 지적 목록 아래에 섞어 두면 정작 이 리뷰만 낼 수 있는 답이 눈에 안 들어온다.
 */
export default function ReviewOverviewPanel({
  session,
  view
}: {
  session: ReviewSession
  view: ReviewViewState
}): React.JSX.Element {
  const stacked = isStackReview(session)
  const noAnchor = view.findings.filter((f) => !f.anchor)
  const stackFindings = noAnchor.filter(isStackFinding)
  const general = noAnchor.filter((f) => !isStackFinding(f))

  return (
    <div className="h-full overflow-y-auto">
      {session.summary && (
        <div className="border-b border-[var(--border)] p-3">
          <h3 className="mb-1.5 text-xs font-medium text-neutral-400">
            {stacked ? 'The stack' : 'Summary'}
          </h3>
          <div className="md text-sm text-neutral-300">
            <MarkdownBody text={session.summary} />
          </div>
        </div>
      )}

      {stacked && (
        <div className="border-b border-[var(--border)] p-3">
          <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-[var(--accent-300)]">
            <Layers size={12} />
            Stack {stackFindings.length > 0 && `(${stackFindings.length})`}
          </h3>
          {stackFindings.length === 0 ? (
            <p className="text-xs text-neutral-500">
              {session.status === 'done'
                ? 'Nothing wrong with how this work is split.'
                : 'Nothing yet.'}
            </p>
          ) : (
            <div className="space-y-2">
              {stackFindings.map((f) => (
                <ReviewFindingCard key={f.id} session={session} view={view} finding={f} />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="p-3">
        <h3 className="mb-2 text-xs font-medium text-neutral-400">
          General {general.length > 0 && `(${general.length})`}
        </h3>
        {general.length === 0 ? (
          <p className="text-xs text-neutral-500">
            {session.status === 'done' ? 'No general findings.' : 'Nothing yet.'}
          </p>
        ) : (
          <div className="space-y-2">
            {general.map((f) => (
              <ReviewFindingCard
                key={f.id}
                session={session}
                view={view}
                finding={f}
                // 어느 PR 에 올라갈 코멘트인지는 게시 전에 보여야 한다 — 스택에서는 목록만 봐서는
                // 알 수 없고, 잘못 올라간 코멘트는 되돌리기 번거롭다.
                layerLabel={stacked ? layerOfFinding(session, f)?.prNumber : undefined}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
