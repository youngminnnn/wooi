import { describe, expect, it } from 'vitest'
import { parseContextPanel, parseMcpPanel, parseTokenCount, parseUsagePanel } from './panels'

/**
 * 픽스처는 전부 `copilot --acp --stdio` (CLI v1.0.80) 에서 **실제로 받은 출력**이다.
 * 손으로 지어낸 문자열로는 이 파서가 지켜야 할 것을 지킬 수 없다 — 컬럼 정렬, 범례 글리프,
 * `<1%` 같은 표기가 전부 실물에만 있다.
 */

const CONTEXT = `Context Usage

○ ○ ○ ◌ ◌ ◌ ● ◉ · ·   auto · 13k/128k tokens (10%)
· · · · · · · · · ·   ○ System Prompt           5.2k   (4%)
· · · · · · · · · ·   ◌ System Tools            6.4k   (5%)
· · · · · · · · · ·   ● MCP Tools               1.1k   (1%)
· · · · · · · · · ·   ◉ Messages                 222  (<1%)
· · · · · · · · · ·   · Free Space            108.7k  (85%)
· · · · · · ◎ ◎ ◎ ◎   ◎ Buffer                  6.4k   (5%)`

const USAGE = `Session Usage

Changes: +12 -3
Requests: 0.3 AI Units (27s)
Tokens: input 24.3k, output 1.0k, cached 23.7k, reasoning 896`

const MCP = `MCP Servers

Per-server rows show standalone token counts.

- github-mcp-server (connected, builtin)`

/**
 * 같은 세션이 잠시 뒤에 내놓는 모양. 머리말이 예고하는 "standalone token counts" 가 줄 끝에
 * 붙는다 — 세션을 막 열었을 때는 없다가 생긴다(실앱에서 두 형태를 모두 받았다).
 */
const MCP_WITH_TOKENS = `MCP Servers

Per-server rows show standalone token counts.

- supabase (connected, plugin): 4.3k
- github-mcp-server (connected, builtin): 1.1k`

describe('parseTokenCount', () => {
  it('k·M 접미사와 천 단위 쉼표를 읽는다', () => {
    expect(parseTokenCount('5.2k')).toBe(5200)
    expect(parseTokenCount('108.7k')).toBe(108700)
    expect(parseTokenCount('222')).toBe(222)
    expect(parseTokenCount('1.2M')).toBe(1_200_000)
    expect(parseTokenCount('1,024')).toBe(1024)
  })

  it('숫자가 아니면 null — 표가 아닌 줄을 카테고리로 오인하지 않는다', () => {
    expect(parseTokenCount('Prompt')).toBeNull()
    expect(parseTokenCount('')).toBeNull()
  })
})

describe('parseContextPanel', () => {
  it('카테고리를 큰 순으로 뽑는다', () => {
    const c = parseContextPanel(CONTEXT, null)
    expect(c.model).toBe('auto')
    expect(c.categories).toEqual([
      { name: 'System Tools', tokens: 6400 },
      { name: 'Buffer', tokens: 6400 },
      { name: 'System Prompt', tokens: 5200 },
      { name: 'MCP Tools', tokens: 1100 },
      { name: 'Messages', tokens: 222 }
    ])
  })

  it('Free Space 는 소비가 아니라 그 여집합이라 뺀다', () => {
    expect(parseContextPanel(CONTEXT, null).categories.map((c) => c.name)).not.toContain(
      'Free Space'
    )
  })

  it('총량은 usage_update 를 우선한다 — 텍스트는 13k 로 반올림돼 있다', () => {
    const c = parseContextPanel(CONTEXT, { used: 12716, size: 128000 })
    expect(c.totalTokens).toBe(12716)
    expect(c.maxTokens).toBe(128000)
    expect(c.percentage).toBe(10)
  })

  it('usage_update 가 아직 없으면 헤더의 값으로 떨어진다', () => {
    const c = parseContextPanel(CONTEXT, null)
    expect(c.totalTokens).toBe(13000)
    expect(c.maxTokens).toBe(128000)
  })

  it('첫 메시지 전의 안내문에서는 maxTokens 가 0 이라 호출부가 끊을 수 있다', () => {
    const c = parseContextPanel(
      'Context information is not yet available. Send a message first so Copilot can initialize the agent context.',
      null
    )
    expect(c.maxTokens).toBe(0)
    expect(c.categories).toEqual([])
  })
})

describe('parseUsagePanel', () => {
  it('바뀐 줄 수와 AI credits 표기를 읽는다', () => {
    const u = parseUsagePanel(USAGE)
    expect(u.linesAdded).toBe(12)
    expect(u.linesRemoved).toBe(3)
    // USD 가 아니므로 totalCostUsd 에 밀어 넣지 않고 표기를 그대로 넘긴다.
    expect(u.costLabel).toBe('0.3 AI Units')
    expect(u.totalCostUsd).toBe(0)
  })

  it('레거시 과금 계정의 premium requests 표기도 그대로 옮긴다', () => {
    expect(parseUsagePanel('Requests: 2 premium requests (5s)').costLabel).toBe(
      '2 premium requests'
    )
  })

  it('플랜 한도는 채우지 않는다 — 한도가 걸린 계정을 실측하지 못했다', () => {
    const u = parseUsagePanel(USAGE)
    expect(u.rateLimitsAvailable).toBe(false)
    expect(u.rateLimits).toEqual([])
    expect(u.extraUsage).toBeNull()
  })

  it('서식이 달라져도 0 으로 답하고 멈추지 않는다', () => {
    const u = parseUsagePanel('Session Usage')
    expect(u.linesAdded).toBe(0)
    expect(u.costLabel).toBeUndefined()
  })
})

describe('parseMcpPanel', () => {
  it('서버 이름과 상태를 읽고 나머지 속성은 스코프로 보여 준다', () => {
    expect(parseMcpPanel(MCP)).toEqual([
      { name: 'github-mcp-server', status: 'connected', scope: 'builtin' }
    ])
  })

  it('상태를 모르면 connected 로 낙관하지 않는다 — 죽은 서버가 살아 보이면 안 된다', () => {
    expect(parseMcpPanel('- mystery-server')[0].status).toBe('pending')
    expect(parseMcpPanel('- broken (failed to start)')[0].status).toBe('failed')
    expect(parseMcpPanel('- off (disabled)')[0].status).toBe('disabled')
  })

  // 이 꼬리를 흘려보내지 못하면 목록이 통째로 비어 패널이 "서버 없음" 이라고 거짓말한다
  // (실앱에서 정확히 이렇게 났다).
  it('줄 끝의 토큰 수 꼬리를 흘려보낸다', () => {
    expect(parseMcpPanel(MCP_WITH_TOKENS)).toEqual([
      { name: 'supabase', status: 'connected', scope: 'plugin' },
      { name: 'github-mcp-server', status: 'connected', scope: 'builtin' }
    ])
  })

  it('머리말은 서버로 세지 않는다', () => {
    expect(parseMcpPanel('MCP Servers\n\nPer-server rows show standalone token counts.')).toEqual(
      []
    )
  })
})
