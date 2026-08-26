import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { delegateToolSpecs } from './catalog'

/**
 * 위임 도구 스키마가 **그 백엔드가 실제로 받는 값만** 광고하는가.
 *
 * 이 스키마는 alwaysLoad 라 매 요청 실리고, 모델은 스키마가 허락한 값을 그대로 고른다. 그래서
 * 여기서 넓게 광고하면 값이 검증에 걸릴 때까지 아무도 모른다 — 실패가 도구 호출까지 미뤄진다.
 */
describe('위임 도구의 model·effort 스키마', () => {
  const specFor = (backend: 'claude' | 'codex'): Record<string, z.ZodType> =>
    delegateToolSpecs([backend])[0].inputSchema as unknown as Record<string, z.ZodType>

  it('`ultracode` 는 어느 백엔드에서도 고를 수 없다', () => {
    // effort 레벨이 아니라 모드다. 실행기가 이미 그 성분을 벗기므로(subagent/runClaude.ts)
    // 스키마에 남겨 두면 지켜지지 않을 약속이 된다.
    expect(specFor('claude').effort.safeParse('ultracode').success).toBe(false)
    expect(specFor('codex').effort.safeParse('ultracode').success).toBe(false)
  })

  it('백엔드마다 자기 목록만 받는다', () => {
    // `max` 는 Claude 에만, `minimal` 은 Codex 에만 있다. 합집합을 실었다면 둘 다 통과한다.
    expect(specFor('claude').effort.safeParse('max').success).toBe(true)
    expect(specFor('codex').effort.safeParse('max').success).toBe(false)
    expect(specFor('codex').effort.safeParse('minimal').success).toBe(true)
    expect(specFor('claude').effort.safeParse('minimal').success).toBe(false)
  })

  it('둘 다 생략할 수 있다 — 예전 호출이 그대로 통한다', () => {
    expect(specFor('claude').effort.safeParse(undefined).success).toBe(true)
    expect(specFor('claude').model.safeParse(undefined).success).toBe(true)
  })
})
