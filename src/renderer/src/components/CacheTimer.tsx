import { Zap } from 'lucide-react'
import type { Workspace } from '@shared/types'
import { formatCacheRemaining, promptCacheExpiresAt, usePromptCacheNow } from '../lib/promptCache'

/**
 * 워크스페이스 카드의 프롬프트 캐시 카운트다운. 보여 줄 것이 없으면 아무것도 그리지 않는다.
 *
 * 이 표시가 전하려는 것은 "얼마나 썼는가" 가 아니라 "지금 답하면 싸고 조금 뒤면 제값" 이다 —
 * 그래서 만료되면 즉시 사라진다. 남아 있는 만료된 타이머는 정보가 아니라 잡음이다.
 *
 * 시각은 [[promptCache]] 의 공용 시계 하나에서 온다(카드가 몇 장이든 인터벌은 최대 하나이고,
 * 셀 것이 없으면 그마저 멈춘다). 판단 근거 — TTL 의 출처, 왜 `lastActiveAt` 을 기준으로 삼는지,
 * 왜 도는 중에는 숨기는지 — 도 그 파일에 적혀 있다.
 */
export default function CacheTimer({
  workspace,
  dot = false
}: {
  workspace: Workspace
  /** 사이드바 행처럼 항목을 `·` 로 잇는 자리에서 앞에 구분점을 붙인다. */
  dot?: boolean
}): React.JSX.Element | null {
  const expiresAt = promptCacheExpiresAt(workspace)
  const now = usePromptCacheNow(expiresAt)
  if (expiresAt === null) return null

  const remaining = expiresAt - now
  if (remaining <= 0) return null

  // 마지막 1분은 색을 바꾼다 — 이때가 "지금 답할지" 를 실제로 정해야 하는 구간이다.
  const urgent = remaining <= 60_000
  return (
    <span
      className={
        'flex items-center gap-0.5 shrink-0 tabular-nums ' +
        (urgent ? 'text-[var(--warning-400)]/90' : 'text-neutral-600')
      }
      title={`Prompt cache stays warm for ${formatCacheRemaining(remaining)} — replying now reuses it instead of re-sending the conversation at full price`}
    >
      {dot && <span className="text-neutral-600">·</span>}
      <Zap size={10} className="shrink-0" />
      {formatCacheRemaining(remaining)}
    </span>
  )
}
