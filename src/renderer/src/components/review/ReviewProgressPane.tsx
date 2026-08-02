import { useEffect, useRef } from 'react'
import { Loader2, Terminal, TriangleAlert } from 'lucide-react'
import type { ReviewStatus } from '@shared/types'
import type { ReviewViewState } from '../../lib/review'

/** 리뷰가 도는 동안 "지금 뭘 하고 있나" 를 보여준다. 몇 분이 걸릴 수 있어 침묵은 곤란하다. */
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
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto max-w-2xl space-y-2">
        <div className="flex items-center gap-2 text-sm text-neutral-300">
          {running && <Loader2 size={14} className="animate-spin text-[var(--info-400)]" />}
          <span>
            {status === 'preparing'
              ? 'Checking out the PR and fetching the diff…'
              : status === 'running'
                ? 'Agent is reviewing…'
                : 'Activity'}
          </span>
        </div>

        {view.progress.length === 0 && running && (
          <p className="text-xs text-neutral-500">Hang tight.</p>
        )}

        {view.progress.map((item) => (
          <div key={item.id} className="text-xs">
            {item.kind === 'tool' ? (
              <div className="flex items-start gap-1.5 text-neutral-500">
                <Terminal size={11} className="mt-0.5 shrink-0" />
                <span className="font-mono break-all">{item.text}</span>
              </div>
            ) : item.kind === 'error' ? (
              <div className="flex items-start gap-1.5 text-[var(--danger-400)]">
                <TriangleAlert size={11} className="mt-0.5 shrink-0" />
                <span className="break-words">{item.text}</span>
              </div>
            ) : (
              <p className="whitespace-pre-wrap text-neutral-300">{item.text}</p>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  )
}
