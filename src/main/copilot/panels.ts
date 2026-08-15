import type { ContextUsageInfo, McpServerInfo, UsageInfo } from '@shared/types'

/**
 * Copilot 의 슬래시 명령 **텍스트 출력**을 Wooi 의 구조화 패널 payload 로 옮긴다.
 *
 * ACP 에는 `/context`·`/usage`·`/mcp` 에 해당하는 RPC 가 없다. 이 명령들은 프롬프트 텍스트로
 * 보내면 모델을 거치지 않고 실행되고 결과가 `agent_message_chunk` 로 되돌아온다(실측) — 즉
 * 우리가 가진 것은 사람이 읽으라고 만든 문자열뿐이다. 그래서 여기서 판다.
 *
 * 파싱은 **깨져도 대화를 멈추지 않는다.** 못 읽은 항목은 빈 값으로 두고 읽은 것만 채운다 —
 * Copilot 이 출력 서식을 바꾸면 패널이 헐거워질 뿐, 세션은 계속 돈다. 총량처럼 구조적 출처가
 * 따로 있는 값은 텍스트를 믿지 않는다([[copilot/session]] 의 usage_update).
 *
 * 픽스처는 CLI v1.0.80 에서 실제로 받은 출력이다(panels.test.ts).
 */

/** `5.2k` · `108.7k` · `222` · `1.2M` → 토큰 수. 못 읽으면 null. */
export function parseTokenCount(raw: string): number | null {
  const m = /^([\d,]+(?:\.\d+)?)\s*([kKmM])?$/.exec(raw.trim())
  if (!m) return null
  const value = Number(m[1].replace(/,/g, ''))
  if (!Number.isFinite(value)) return null
  const unit = m[2]?.toLowerCase()
  return Math.round(value * (unit === 'm' ? 1_000_000 : unit === 'k' ? 1_000 : 1))
}

/** 컬럼이 2칸 이상 공백으로 갈리는 Copilot 표를 셀 배열로. */
function cells(line: string): string[] {
  return line
    .trim()
    .split(/\s{2,}/)
    .filter(Boolean)
}

/** `○ System Prompt` 처럼 앞에 붙는 범례 글리프를 떼어 낸다. */
function stripGlyph(label: string): string {
  return label.replace(/^[^\p{L}\p{N}]+\s*/u, '').trim()
}

/**
 * `/context` 출력.
 *
 * 총량·비율·모델은 **넘겨받은 usage 로 덮는다** — `usage_update {used,size}` 는 구조화된 값이라
 * 텍스트보다 정확하고(텍스트는 `13k` 처럼 반올림돼 있다) 매 턴 갱신된다. 텍스트에서는 이
 * 알림이 주지 않는 **카테고리 분해**만 얻는다.
 */
export function parseContextPanel(
  text: string,
  usage: { used: number; size: number } | null
): ContextUsageInfo {
  let headerUsed: number | null = null
  let headerMax: number | null = null
  let model = 'auto'
  const categories: { name: string; tokens: number }[] = []

  for (const line of text.split('\n')) {
    const parts = cells(line)
    if (parts.length < 2) continue

    // 헤더: `○ ○ ○ ◌ …   auto · 13k/128k tokens (10%)`
    const header = /^(.+?)\s·\s([\d.,]+[kKmM]?)\/([\d.,]+[kKmM]?)\s+tokens/.exec(
      parts[parts.length - 1]
    )
    if (header) {
      model = header[1].trim() || model
      headerUsed = parseTokenCount(header[2])
      headerMax = parseTokenCount(header[3])
      continue
    }

    // 카테고리: `· · · …   ○ System Prompt   5.2k   (4%)`
    if (parts.length < 3) continue
    const tokens = parseTokenCount(parts[parts.length - 2])
    if (tokens === null || !/^\(<?\s*\d+%\)$/.test(parts[parts.length - 1])) continue
    const name = stripGlyph(parts[parts.length - 3])
    // Free Space 는 소비가 아니라 그 여집합이다. 카테고리로 실으면 목록을 통째로 차지하면서
    // "무엇이 컨텍스트를 먹고 있나"라는 패널의 질문에 답하지 않는다.
    if (!name || /^free space$/i.test(name)) continue
    categories.push({ name, tokens })
  }

  const totalTokens = usage?.used ?? headerUsed ?? 0
  const maxTokens = usage?.size ?? headerMax ?? 0
  return {
    totalTokens,
    maxTokens,
    percentage: maxTokens > 0 ? Math.round((totalTokens / maxTokens) * 100) : 0,
    model,
    categories: categories.sort((a, b) => b.tokens - a.tokens)
  }
}

/**
 * `/usage` 출력.
 *
 * Copilot 은 **AI credits** 로 과금한다(USD 가 아니다). 그래서 `totalCostUsd` 에 숫자를 밀어
 * 넣지 않고 `costLabel` 로 원문 표기를 그대로 넘긴다 — 단위를 바꿔 적으면 그건 오답이다.
 * 레거시 과금 계정은 같은 자리에 "premium requests" 가 온다고 문서가 밝히므로 라벨을 통째로 옮긴다.
 *
 * 플랜 사용률(rateLimits)은 채우지 않는다. Copilot 문서상 "usage-limit progress when any limits
 * apply" 가 이 출력에 붙을 수 있지만, 한도가 걸린 계정을 실측하지 못했다 — 못 본 서식을 추측으로
 * 파싱하느니 `rateLimitsAvailable: false` 로 두고 UI 가 "not available" 을 말하게 한다.
 */
export function parseUsagePanel(text: string): UsageInfo {
  const changes = /^\s*Changes:\s*\+([\d,]+)\s*-([\d,]+)/m.exec(text)
  const requests = /^\s*Requests:\s*(.+?)(?:\s*\(|$)/m.exec(text)
  const label = requests?.[1].trim()

  return {
    totalCostUsd: 0,
    ...(label ? { costLabel: label } : {}),
    linesAdded: changes ? Number(changes[1].replace(/,/g, '')) : 0,
    linesRemoved: changes ? Number(changes[2].replace(/,/g, '')) : 0,
    subscriptionType: null,
    rateLimitsAvailable: false,
    rateLimits: [],
    extraUsage: null
  }
}

/**
 * `/mcp` 출력. 서버 한 줄이 `- name (connected, builtin)` 모양으로 온다.
 *
 * **줄 끝에 `: 4.3k` 가 붙을 수도 있다** — 머리말이 예고하는 "standalone token counts" 다.
 * 세션이 막 열렸을 때는 붙지 않고 잠시 뒤부터 붙는 것을 실앱에서 확인했다(둘 다 같은 세션에서
 * 나왔다). 그래서 줄끝을 강제하지 않고 그 꼬리를 흘려보낸다 — 토큰 수를 담을 자리가
 * `McpServerInfo` 에 없고, `toolCount` 는 **도구 수**라 여기 밀어 넣으면 거짓말이 된다.
 *
 * 엔드포인트·도구 목록도 이 출력에 없어 채우지 않는다. 재연결·활성/비활성 RPC 가 없어
 * `capabilities.mcp` 는 false 이고, 패널은 목록만 보여 준다([[agent/backend]] COPILOT_META).
 */
export function parseMcpPanel(text: string): McpServerInfo[] {
  const out: McpServerInfo[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*[-•*]\s+(\S+?):?\s*(?:\(([^)]*)\))?\s*(?::\s*\S+)?\s*$/.exec(line)
    if (!m) continue
    const attrs = (m[2] ?? '')
      .split(',')
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean)
    // 알 수 없는 상태를 'connected' 로 낙관하면 안 된다 — 죽은 서버가 살아 있는 것처럼 보인다.
    const status: McpServerInfo['status'] = attrs.includes('connected')
      ? 'connected'
      : attrs.includes('disabled')
        ? 'disabled'
        : attrs.some((a) => a.includes('fail') || a.includes('error'))
          ? 'failed'
          : 'pending'
    // 상태가 아닌 속성(builtin·local 등)은 스코프 자리에 그대로 보여 준다.
    const scope = attrs.find((a) => !['connected', 'disabled'].includes(a) && !a.includes('fail'))
    out.push({ name: m[1], status, ...(scope ? { scope } : {}) })
  }
  return out
}
