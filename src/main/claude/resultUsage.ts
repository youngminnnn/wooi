import type { ModelUsage } from '@anthropic-ai/claude-agent-sdk'
import type { UsageTotals } from '@shared/types'

/**
 * SDK result 메시지에서 토큰·비용 누계를 뽑는다.
 *
 * `usage` 가 아니라 `modelUsage` 를 읽는다 — SDK 문서가 못박은 그대로다. `usage` 는 **메인 루프
 * 전용**이라 Task 서브에이전트·sidechain·압축 호출이 빠지고 스트리밍 입력에서는 턴당 값이다.
 * `modelUsage` 는 query 파이프라인을 지나간 모든 모델 호출을 모델별로 누계한다.
 *
 * 상태를 갖지 않는 순수 함수로 떼어 둔 이유는 부르는 쪽이 셋이기 때문이다 — 유틸리티 프로세스의
 * 세션(claude/session.ts), 메인의 위임 서브런, 메인의 코드 리뷰. 특히 호스트에서 import 되므로
 * 여기에 electron 에 매인 것을 들이면 로드 시점에 죽는다([[claude/protocol]] 의 #280 주석).
 */
export function usageFromResult(msg: {
  total_cost_usd: number
  modelUsage: Record<string, ModelUsage>
}): UsageTotals {
  const totals: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    // 비용은 modelUsage 의 costUSD 를 더하지 않고 total_cost_usd 를 그대로 쓴다 — 같은 생애주기를
    // 공유하는 SDK 의 공식 누계이고, 파이프라인 밖 호출까지 이미 반영돼 있다.
    costUsd: msg.total_cost_usd ?? 0
  }
  for (const usage of Object.values(msg.modelUsage ?? {})) {
    totals.inputTokens += usage.inputTokens ?? 0
    totals.outputTokens += usage.outputTokens ?? 0
    totals.cacheReadTokens += usage.cacheReadInputTokens ?? 0
    totals.cacheCreationTokens += usage.cacheCreationInputTokens ?? 0
  }
  return totals
}
