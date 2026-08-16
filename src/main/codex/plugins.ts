import type {
  CodexPlugin,
  CodexPluginDetail,
  CodexPluginInventory,
  CodexPluginMarketplace
} from '@shared/types'
import type {
  PluginDetail,
  PluginMarketplaceEntry,
  PluginSource,
  PluginSummary,
  PluginsResponse
} from './wire'

/**
 * Codex Agent Plugin 응답을 화면이 읽는 모양으로 옮긴다.
 *
 * host.ts 가 아니라 여기에 두는 이유: app-server 를 띄우지 않고도 "이 payload 를 어떻게 읽는가"
 * 를 통째로 시험할 수 있어야 한다. 실제로 여기서 잡히는 것들은 전부 실물 응답에서 온 함정이다 —
 * 원격 카탈로그에는 `path` 가 없고, 원격 전용 플러그인에는 `localVersion` 이 없으며,
 * availability 는 상류 서비스가 'ENABLED' 를 보내는 경우가 있어 이름이 두 개다.
 */

/** availability 필드가 이 값들이면 "쓸 수 있다". 나머지는 이유를 붙여 막힌 것으로 본다. */
const AVAILABLE_STATES = new Set(['AVAILABLE', 'ENABLED'])

/**
 * disabledReason 의 사람 말 번역. 모르는 값은 **버리지 않고 그대로 보여 준다** — 새 이유가
 * 생겼을 때 "쓸 수 없다"까지만 알려 주고 왜인지 삼키면 사용자가 할 수 있는 일이 없어진다.
 */
const DISABLED_REASONS: Record<string, string> = {
  disabled_by_admin: 'Disabled by your workspace admin',
  plan_not_eligible: 'Your plan is not eligible for this plugin',
  required_app_unavailable: 'A required app is unavailable',
  unknown: 'Unavailable — Codex did not say why'
}

/**
 * `plugin/installed` 응답 → 설정 화면 인벤토리.
 *
 * `undefined` 는 "이 codex 버전이 `plugin/*` 를 모른다" 는 뜻이다(RpcClient.tryRequest 가
 * -32601 을 그렇게 낮춘다). 빈 목록과 구분해 supported=false 로 넘긴다.
 */
export function toPluginInventory(response: PluginsResponse | undefined): CodexPluginInventory {
  if (!response) return { supported: false, marketplaces: [], loadErrors: [] }
  return {
    supported: true,
    marketplaces: (response.marketplaces ?? [])
      .map(toMarketplace)
      // 이름 없는 마켓플레이스는 지칭할 방법이 없으므로 그린 뒤에도 할 수 있는 일이 없다.
      .filter((marketplace): marketplace is CodexPluginMarketplace => marketplace !== null),
    loadErrors: (response.marketplaceLoadErrors ?? []).map((error) => ({
      path: error.marketplacePath ?? '',
      message: error.message ?? 'Codex could not read this marketplace.'
    }))
  }
}

function toMarketplace(entry: PluginMarketplaceEntry): CodexPluginMarketplace | null {
  const name = entry.name?.trim()
  if (!name) return null
  return {
    name,
    displayName: entry.interface?.displayName?.trim() || name,
    // 빈 문자열도 null 로 눕힌다 — 화면은 "경로가 있는가"로만 갈라 보기 때문이다.
    path: entry.path?.trim() || null,
    plugins: (entry.plugins ?? [])
      .map(toPlugin)
      .filter((plugin): plugin is CodexPlugin => plugin !== null)
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
  }
}

function toPlugin(summary: PluginSummary): CodexPlugin | null {
  const name = summary.name?.trim()
  if (!name) return null
  const source = describeSource(summary.source)
  const available = isAvailable(summary)
  return {
    id: summary.id?.trim() || name,
    name,
    displayName: summary.interface?.displayName?.trim() || name,
    description: summary.interface?.shortDescription?.trim() || '',
    // 로컬 버전이 실제로 도는 것이고, 원격 전용 플러그인에는 그게 없어 카탈로그 버전만 남는다.
    version: summary.localVersion?.trim() || summary.version?.trim() || null,
    // codex 기본값은 켜짐이다 — 필드가 없다고 꺼진 것으로 그리면 전부 꺼진 것처럼 보인다.
    enabled: summary.enabled !== false,
    source: source.kind,
    sourceDetail: source.detail,
    available,
    unavailableReason: available ? null : unavailableReason(summary)
  }
}

/**
 * 지금 쓸 수 있는가.
 *
 * 필드가 없으면 쓸 수 있는 것으로 본다(스키마 기본값이 AVAILABLE 이다). 모르는 값은 막힌 것으로
 * 본다 — 새로 생기는 상태는 대개 제약이고, 못 쓰는 것을 쓸 수 있다고 그리면 사용자가 그 플러그인을
 * 기대하며 턴을 태운 뒤에야 알게 된다. 반대 방향의 오류는 이유 문구가 그대로 노출되므로 덜 나쁘다.
 */
function isAvailable(summary: PluginSummary): boolean {
  if (summary.disabledReason) return false
  if (!summary.availability) return true
  return AVAILABLE_STATES.has(summary.availability)
}

function unavailableReason(summary: PluginSummary): string {
  const reason = summary.disabledReason?.trim()
  if (reason) return DISABLED_REASONS[reason] ?? reason
  return summary.availability === 'DISABLED_BY_ADMIN'
    ? DISABLED_REASONS.disabled_by_admin
    : DISABLED_REASONS.unknown
}

/** 출처 한 줄. 종류를 모르면 종류만 밝히고 상세는 비운다(추측한 문자열을 보여 주지 않는다). */
function describeSource(source: PluginSource | undefined): { kind: string; detail: string } {
  switch (source?.type) {
    case 'local':
      return { kind: 'local', detail: source.path?.trim() || '' }
    case 'git':
      return {
        kind: 'git',
        detail: [source.url, source.refName].filter(Boolean).join('#')
      }
    case 'npm':
      return {
        kind: 'npm',
        detail: [source.package, source.version].filter(Boolean).join('@')
      }
    case 'remote':
      return { kind: 'remote', detail: '' }
    default:
      return { kind: source?.type?.trim() || 'unknown', detail: '' }
  }
}

/** `plugin/read` 응답 → 펼친 행의 내용. 응답이 없거나 비어도 빈 상세로 그린다. */
export function toPluginDetail(detail: PluginDetail | undefined): CodexPluginDetail {
  return {
    description: detail?.description?.trim() || '',
    skills: (detail?.skills ?? [])
      .filter((skill) => !!skill.name)
      .map((skill) => ({
        name: skill.name as string,
        description: skill.description?.trim() || '',
        // 스킬도 플러그인과 같이 기본값이 켜짐이다.
        enabled: skill.enabled !== false
      })),
    mcpServers: (detail?.mcpServers ?? []).filter((name) => !!name),
    hooks: (detail?.hooks ?? [])
      .filter((hook) => !!hook.key)
      .map((hook) => ({ key: hook.key as string, eventName: hook.eventName ?? '' })),
    apps: (detail?.apps ?? [])
      .filter((app) => !!app.name)
      .map((app) => ({
        id: app.id ?? '',
        name: app.name as string,
        description: app.description?.trim() || ''
      })),
    scheduledTasks: (detail?.scheduledTasks ?? [])
      .filter((task) => !!task.name)
      .map((task) => ({ key: task.key ?? '', name: task.name as string }))
  }
}
