import { useEffect, useRef } from 'react'
import { Loader2 } from 'lucide-react'
import type { ReviewProgressItem, ReviewStatus } from '@shared/types'
import { toolParts, type ReviewViewState } from '../../lib/review'
import { AgentMessage, ErrorRow, ToolUseRow } from '../ChatPrimitives'

/**
 * 리뷰가 도는 동안 "지금 뭘 하고 있나" 를 보여준다. 몇 분이 걸릴 수 있어 침묵은 곤란하다.
 *
 * 워크스페이스 대화(MessageList)와 **같은 조각·같은 레이아웃**으로 그린다 — 같은 에이전트가
 * 도구를 부르는 광경인데 화면마다 모양이 다르면 리뷰만 남의 제품처럼 보인다.
 */
export default function ReviewProgressPane({
  status,
  view
}: {
  status: ReviewStatus
  view: ReviewViewState
}): React.JSX.Element {
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [view.progress.length])

  const running = status === 'preparing' || status === 'running'

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-3 px-5 py-5">
        <div className="flex items-center gap-2 text-sm text-neutral-400">
          {running && <Loader2 size={13} className="animate-spin text-[var(--info-400)]" />}
          <span>
            {status === 'preparing'
              ? 'Checking out the PR and fetching the diff…'
              : status === 'running'
                ? 'Reviewing…'
                : 'Activity'}
          </span>
        </div>

        {view.progress.length === 0 && running && (
          <p className="text-sm text-neutral-500">Hang tight.</p>
        )}

        {view.progress.map((item) => (
          <ProgressRow key={item.id} item={item} />
        ))}
        <div ref={endRef} />
      </div>
    </div>
  )
}

export function ProgressRow({ item }: { item: ReviewProgressItem }): React.JSX.Element {
  if (item.kind === 'tool') {
    const { name, summary } = toolParts(item)
    return <ToolUseRow name={name} summary={summary} />
  }
  if (item.kind === 'error') return <ErrorRow text={item.text} />
  return <AgentMessage text={item.text} />
}
