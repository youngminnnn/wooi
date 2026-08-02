import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { ReviewSession } from '@shared/types'
import type { ReviewViewState } from '../../lib/review'
import ReviewFindingCard from './ReviewFindingCard'

/**
 * 총평과 "특정 줄에 붙일 수 없는" 지적을 모아 보여준다.
 *
 * 앵커 해석에 실패한 인라인 지적도 여기로 강등돼 내려온다(본문 앞에 원래 위치가 붙어 있다) —
 * 위치를 못 찾았다는 이유로 리뷰 내용을 버리지 않기 위한 설계다.
 */
export default function ReviewOverviewPanel({
  session,
  view
}: {
  session: ReviewSession
  view: ReviewViewState
}): React.JSX.Element {
  const general = view.findings.filter((f) => !f.anchor)

  return (
    <div className="h-full overflow-y-auto">
      {session.summary && (
        <div className="border-b border-[var(--border)] p-3">
          <h3 className="mb-1.5 text-xs font-medium text-neutral-400">Summary</h3>
          <div className="md text-sm text-neutral-300">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
              {session.summary}
            </ReactMarkdown>
          </div>
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
              <ReviewFindingCard key={f.id} session={session} view={view} finding={f} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
