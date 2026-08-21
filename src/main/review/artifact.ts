import type {
  ReviewArtifact,
  ReviewFindingDiscard,
  ReviewFindingInput,
  ReviewFindingRevision,
  ReviewLayerSummary,
  ReviewSeverity
} from '@shared/types'

/**
 * 에이전트가 뱉은 리뷰 결과를 우리 타입으로 좁힌다.
 *
 * 백엔드에 무관하게 같은 규칙을 쓴다 — Claude 는 outputFormat, Codex 는 --output-schema 로
 * 형식을 강제하지만 **둘 다 폴백 경로(코드블록 파싱)를 갖고**, 그 경로로 들어온 값은 아무
 * 검증도 거치지 않았다. 여기서 막지 못한 이상한 값은 렌더러까지 흘러가 화면을 깬다.
 */

const SEVERITIES: ReadonlySet<string> = new Set([
  'blocker',
  'major',
  'minor',
  'nit',
  'question',
  'praise'
])

export function coerceArtifact(value: unknown): ReviewArtifact | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const general = coerceFindings(v.general)
  const inline = coerceFindings(v.inline)
  const stack = coerceFindings(v.stack)
  const hasReply = typeof v.reply === 'string' && v.reply.trim().length > 0
  // 고쳐 쓰기·거둬들이기만 담긴 턴도 유효한 결과다("다 고쳤으니 그 지적들 거둬라"). 이걸
  // 빼먹으면 그런 턴이 통째로 "구조화 출력 없음" 으로 떨어져 원문이 총평 자리에 박힌다.
  const revises = Array.isArray(v.updates) || Array.isArray(v.discards)
  if (
    general === null &&
    inline === null &&
    stack === null &&
    typeof v.summary !== 'string' &&
    !hasReply &&
    !revises
  ) {
    return null
  }
  return {
    summary: typeof v.summary === 'string' ? v.summary : '',
    reply: hasReply ? (v.reply as string) : '',
    general: general ?? [],
    inline: inline ?? [],
    stack: stack ?? [],
    layers: coerceLayerSummaries(v.layers),
    updates: coerceUpdates(v.updates),
    discards: coerceDiscards(v.discards)
  }
}

/**
 * 앞선 지적을 고쳐 쓰라는 지시. **핸들만 필수**다 — 나머지는 준 것만 바뀌므로, 하나도 안 준
 * 항목은 아무 일도 하지 않는 빈 지시라 여기서 걸러 낸다.
 */
function coerceUpdates(value: unknown): ReviewFindingRevision[] {
  if (!Array.isArray(value)) return []
  const out: ReviewFindingRevision[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const u = raw as Record<string, unknown>
    const id = typeof u.id === 'string' ? u.id.trim() : ''
    if (!id) continue
    const title = typeof u.title === 'string' ? u.title.trim() : ''
    const body = typeof u.body === 'string' ? u.body.trim() : ''
    const severity = SEVERITIES.has(String(u.severity)) ? (u.severity as ReviewSeverity) : undefined
    if (!title && !body && !severity) continue
    out.push({
      id,
      ...(severity ? { severity } : {}),
      ...(title ? { title } : {}),
      ...(body ? { body } : {})
    })
  }
  return out
}

/** 지적을 거둬들이라는 지시. 이유는 없어도 받는다 — 이유가 없다고 지시를 흘리면 목록만 남는다. */
function coerceDiscards(value: unknown): ReviewFindingDiscard[] {
  if (!Array.isArray(value)) return []
  const out: ReviewFindingDiscard[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const d = raw as Record<string, unknown>
    const id = typeof d.id === 'string' ? d.id.trim() : ''
    if (!id) continue
    const reason = typeof d.reason === 'string' ? d.reason.trim() : ''
    out.push({ id, ...(reason ? { reason } : {}) })
  }
  return out
}

function coerceLayerSummaries(value: unknown): ReviewLayerSummary[] {
  if (!Array.isArray(value)) return []
  const out: ReviewLayerSummary[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const l = raw as Record<string, unknown>
    const summary = typeof l.summary === 'string' ? l.summary.trim() : ''
    if (!Number.isInteger(l.prNumber) || !summary) continue
    out.push({ prNumber: l.prNumber as number, summary })
  }
  return out
}

function coerceFindings(value: unknown): ReviewFindingInput[] | null {
  if (!Array.isArray(value)) return null
  const out: ReviewFindingInput[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const f = raw as Record<string, unknown>
    const title = typeof f.title === 'string' ? f.title.trim() : ''
    const body = typeof f.body === 'string' ? f.body.trim() : ''
    // 제목도 본문도 없으면 게시할 내용이 없다.
    if (!title && !body) continue
    out.push({
      severity: SEVERITIES.has(String(f.severity)) ? (f.severity as ReviewSeverity) : 'minor',
      title: title || body.split('\n')[0].slice(0, 80),
      body: body || title,
      ...(typeof f.file === 'string' ? { file: f.file } : {}),
      ...(Number.isInteger(f.line) ? { line: f.line as number } : {}),
      ...(Number.isInteger(f.startLine) ? { startLine: f.startLine as number } : {}),
      ...(f.side === 'LEFT' || f.side === 'RIGHT' ? { side: f.side } : {}),
      ...(Number.isInteger(f.prNumber) ? { prNumber: f.prNumber as number } : {}),
      ...(Array.isArray(f.prNumbers) && f.prNumbers.some(Number.isInteger)
        ? {
            stackPrNumbers: (f.prNumbers as unknown[]).filter((n): n is number =>
              Number.isInteger(n)
            )
          }
        : {})
    })
  }
  return out
}

/**
 * 폴백 — 본문에서 마지막 ```json 코드블록을 찾아 파싱한다.
 * 구조화 출력이 어떤 이유로든 비어 왔을 때 리뷰 내용을 통째로 잃지 않기 위한 안전망이다.
 */
export function extractFencedJson(text: string): ReviewArtifact | null {
  const matches = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)]
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const parsed: unknown = JSON.parse(matches[i][1])
      const artifact = coerceArtifact(parsed)
      if (artifact) return artifact
    } catch {
      // 다음 후보로.
    }
  }
  return null
}

/** 도구 인자 중 사람이 알아볼 한 조각을 고른다. 인자 전체를 쏟아내면 진행 로그가 안 읽힌다. */
export function describeArg(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  return undefined
}

/** 진행 로그 한 줄로 줄인다. */
export function truncate(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}
