import type { AgentAuthStatus, AgentRateLimits, RateLimitWindow } from '@shared/types'
import { runLoginShell } from '../shell'
import { detectAntigravity } from './executable'

interface ProbeResult {
  ok: boolean
  value: unknown
  error?: string
}

/**
 * 프로브 결과 캐시.
 *
 * 이 조회는 `agy` 프로세스를 띄운다. 그런데 부르는 쪽은 창 포커스마다 도는 인증 상태 조회이고,
 * 한 번의 갱신에서 accountStatus·rateLimits·refreshRateLimits 가 각자 부른다 — 캐시가 없으면
 * 포커스 한 번에 셸이 여러 번 뜬다. 사용자가 다른 터미널에서 로그인/로그아웃할 수 있으므로
 * 영구 캐시는 아니고, 그 정도를 흡수할 만큼만 짧게 잡는다(detectAntigravity 와 같은 이유).
 */
const probeCache = new Map<string, { at: number; value: ProbeResult }>()
const PROBE_CACHE_MS = 30_000

/** 로그인/로그아웃 직후처럼 즉시 다시 물어야 하는 시점에 캐시를 버린다. */
export function invalidateAntigravityProbe(): void {
  probeCache.clear()
}

export async function probeAntigravity(command = '/usage'): Promise<ProbeResult> {
  const cached = probeCache.get(command)
  if (cached && Date.now() - cached.at < PROBE_CACHE_MS) return cached.value
  const value = await probe(command)
  probeCache.set(command, { at: Date.now(), value })
  return value
}

async function probe(command: string): Promise<ProbeResult> {
  const result = await runLoginShell(
    `agy -p ${JSON.stringify(command)} --output-format json`,
    10_000
  )
  if (result.code !== 0) return { ok: false, value: null, error: result.stderr.trim() || undefined }
  try {
    return { ok: true, value: JSON.parse(result.stdout.trim()) as unknown }
  } catch {
    return { ok: false, value: null, error: 'Antigravity returned an unexpected response.' }
  }
}

export async function getAntigravityAccountStatus(): Promise<AgentAuthStatus> {
  const install = await detectAntigravity()
  if (!install.path) return { installed: false, loggedIn: false }
  const probe = await probeAntigravity()
  const root = record(probe.value)
  const account = record(root?.account) ?? record(root?.data)
  return {
    installed: true,
    // 1.1.2 문서가 logged-out headless 실행은 즉시 실패한다고 보장하므로 성공 여부만 인증 신호로 쓴다.
    loggedIn: probe.ok,
    version: install.version ?? undefined,
    // email은 실측하지 못해 account/data의 동명 문자열일 때만 채운다.
    email: string(account?.email),
    // 조직명은 실측하지 못해 orgName/organization 동명 문자열만 후보로 둔다.
    orgName: string(account?.orgName) ?? string(account?.organization),
    // 플랜명은 실측하지 못해 planType/subscriptionType 동명 문자열만 후보로 둔다.
    planType: string(account?.planType) ?? string(account?.subscriptionType),
    // 인증 방식은 실측하지 못해 authMethod 동명 문자열일 때만 채운다.
    authMethod: string(account?.authMethod),
    ...(!probe.ok && probe.error ? { error: probe.error } : {})
  }
}

export async function getAntigravityRateLimits(): Promise<AgentRateLimits | null> {
  const probe = await probeAntigravity()
  if (!probe.ok) return null
  const root = record(probe.value)
  const usage = record(root?.usage) ?? record(root?.data) ?? root
  if (!usage) return null
  // payload를 실측하지 못해 primary/secondary 또는 rate_limits 아래의 동명 필드만 방어적으로 읽는다.
  const limits = record(usage.rateLimits) ?? record(usage.rate_limits) ?? usage
  const primary = window(record(limits.primary))
  const secondary = window(record(limits.secondary))
  if (!primary && !secondary) return null
  return {
    // primary 창은 실측하지 못해 usage/data의 primary 객체를 공통 타입으로 읽은 값이다.
    primary,
    // secondary 창도 실측하지 못해 usage/data의 secondary 객체를 공통 타입으로 읽은 값이다.
    secondary,
    // 이 필드도 정확한 문자열만 전달하며 상태 이름을 추론하거나 변환하지 않는다.
    rateLimitReachedType:
      string(limits.rateLimitReachedType) ?? string(limits.rate_limit_reached_type) ?? null
  }
}

function window(value: Record<string, unknown> | undefined): RateLimitWindow | null {
  if (!value) return null
  // 세 숫자는 Codex 공통 타입과 흔한 snake_case 표기만 후보로 삼고, 숫자가 아니면 창을 폐기한다.
  const usedPercent = number(value.usedPercent) ?? number(value.used_percent)
  if (usedPercent === undefined) return null
  return {
    // 사용률은 실측하지 못해 usedPercent/used_percent 숫자를 0–100 값이라고 가정한다.
    usedPercent,
    // 창 길이는 실측하지 못해 windowDurationMins/window_duration_mins 숫자를 분 단위라고 가정한다.
    windowDurationMins: number(value.windowDurationMins) ?? number(value.window_duration_mins),
    // 초기화 시각은 실측하지 못해 resetsAt/resets_at 숫자를 Unix 초라고 가정한다.
    resetsAt: number(value.resetsAt) ?? number(value.resets_at)
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
