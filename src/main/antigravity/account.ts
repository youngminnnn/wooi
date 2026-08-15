import type { AgentAuthStatus, AgentRateLimits, RateLimitWindow } from '@shared/types'
import { runLoginShell } from '../shell'
import { detectAntigravity } from './executable'

/**
 * 로그인 상태와 플랜 사용량 조회.
 *
 * `-p "/usage" --output-format json` 을 쓴다. 1.1.11 부터 이런 읽기 전용 슬래시 명령은
 * **에이전트 턴을 시작하지도, 쿼터를 쓰지도, 대화를 남기지도 않는다.**
 *
 * 아래 파싱은 **실측한 payload** 를 따른다(agy 1.1.13). 문서에는 이 모양이 없다.
 */

interface ProbeResult {
  ok: boolean
  value: unknown
  error?: string
}

/**
 * 프로브 결과 캐시.
 *
 * 이 조회는 `agy` 프로세스를 띄운다. 그런데 부르는 쪽은 창 포커스마다 도는 인증 상태 조회이고,
 * 한 번의 갱신에서 accountStatus·rateLimits 가 각자 부른다 — 캐시가 없으면 포커스 한 번에 셸이
 * 여러 번 뜬다. 사용자가 다른 터미널에서 로그인/로그아웃할 수 있으므로 영구 캐시는 아니고,
 * 그 정도를 흡수할 만큼만 짧게 잡는다(detectAntigravity 와 같은 이유).
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
    15_000
  )
  // **종료 코드를 믿지 않는다** — 1.1.13 은 오류에도 exit 0 을 돌려주는 경우가 있다.
  // 판정은 "JSON 봉투가 나왔고 status 가 SUCCESS 인가" 로만 한다.
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout.trim())
  } catch {
    return {
      ok: false,
      value: null,
      error: result.stderr.trim() || 'Antigravity returned an unexpected response.'
    }
  }
  const envelope = record(parsed)
  if (string(envelope?.status) !== 'SUCCESS') {
    return {
      ok: false,
      value: parsed,
      error: string(envelope?.error) ?? result.stderr.trim() ?? undefined
    }
  }
  return { ok: true, value: parsed }
}

export async function getAntigravityAccountStatus(): Promise<AgentAuthStatus> {
  const install = await detectAntigravity()
  if (!install.path) return { installed: false, loggedIn: false }
  const result = await probeAntigravity()
  return {
    installed: true,
    // 로그인 전 실행은 stdin 이 파이프면 즉시 status:"ERROR" 로 끝난다(실측). 그래서 프로브의
    // 성공 여부가 그대로 로그인 신호가 된다.
    loggedIn: result.ok,
    version: install.version ?? undefined,
    // **email·orgName·planType 은 채우지 않는다.** /usage 응답에 계정 정보가 전혀 없고
    // (실측한 봉투는 groups/buckets 뿐이다), 다른 읽기 전용 명령에서도 확인하지 못했다.
    // 모르는 것을 비워 두면 UI 는 "Signed in" 만 보여 준다 — 지어내는 것보다 낫다.
    ...(!result.ok && result.error ? { error: result.error } : {})
  }
}

export async function getAntigravityRateLimits(): Promise<AgentRateLimits | null> {
  const windows = await usageWindows()
  if (!windows.length) return null
  // Wooi 의 AgentRateLimits 는 창 두 개만 담는다. 남은 비율이 가장 적은 순으로 채워, 사용자를
  // 실제로 멈추게 할 창이 primary 가 되게 한다.
  const tightest = [...windows].sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0))
  return { primary: tightest[0] ?? null, secondary: tightest[1] ?? null }
}

/** 사용량 창 전체(그룹 × 버킷). 스냅샷용 라벨과 함께 돌려준다. */
export async function getAntigravityUsageWindows(): Promise<
  { label: string; utilization: number | null; resetsAt: string | null }[]
> {
  return (await usageWindows()).map((w) => ({
    label: w.label,
    utilization: w.usedPercent ?? null,
    // 스냅샷은 ISO 문자열을 쓰고 RateLimitWindow 는 Unix 초를 쓴다. 원본이 ISO 라 여기서는
    // 되돌리지 않고 그대로 넘긴다.
    resetsAt: w.resetsAtIso ?? null
  }))
}

interface UsageWindow extends RateLimitWindow {
  label: string
  resetsAtIso?: string
}

/**
 * 실측한 `/usage` 봉투를 창 목록으로 편다:
 *
 * ```
 * { "status": "SUCCESS", "command": { "name": "usage", "data": { "groups": [
 *     { "name": "Gemini Models", "buckets": [
 *       { "name": "Weekly Limit Remaining", "window": "weekly",
 *         "remaining_fraction": 1, "reset_time": "2026-08-22T16:20:18Z" }, … ] }, … ] } } }
 * ```
 *
 * 주의할 점 셋 — 모두 Codex 쪽 모양과 반대다:
 * 1. **`remaining_fraction` 은 남은 비율**(1 = 100% 남음)이다. Wooi 는 *쓴* 비율을 쓰므로 뒤집는다.
 * 2. `reset_time` 은 **ISO 8601 문자열**이지 Unix 초가 아니다.
 * 3. 창이 둘이 아니라 **그룹(Gemini / Claude·GPT) × 버킷(weekly / 5h)** 이다.
 */
async function usageWindows(): Promise<UsageWindow[]> {
  const result = await probeAntigravity()
  if (!result.ok) return []
  const data = record(record(record(result.value)?.command)?.data)
  const groups = Array.isArray(data?.groups) ? data.groups : []

  const out: UsageWindow[] = []
  for (const rawGroup of groups) {
    const group = record(rawGroup)
    const groupName = string(group?.name)
    const buckets = Array.isArray(group?.buckets) ? group.buckets : []
    for (const rawBucket of buckets) {
      const bucket = record(rawBucket)
      if (!bucket) continue
      const remaining = number(bucket.remaining_fraction)
      if (remaining === undefined) continue
      const bucketName = string(bucket.name) ?? string(bucket.window) ?? 'Limit'
      out.push({
        label: groupName ? `${groupName} · ${bucketName}` : bucketName,
        usedPercent: Math.round((1 - remaining) * 100),
        resetsAtIso: string(bucket.reset_time),
        resetsAt: unixSeconds(string(bucket.reset_time))
      })
    }
  }
  return out
}

function unixSeconds(iso: string | undefined): number | undefined {
  if (!iso) return undefined
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined
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
