import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import type { ChatItem, TranscriptHit, TranscriptSearchResult } from '@shared/types'

/**
 * 한 번의 검색이 돌려주는 최대 결과 수. 넘어서면 truncated 로 알린다 — 조용히 자르지 않는다.
 */
export const MAX_HITS = 100
/** 대화가 긴 워크스페이스 하나가 결과를 독점하지 않게 두는 워크스페이스별 상한. */
export const MAX_HITS_PER_WORKSPACE = 20

/** 스니펫에서 매치 앞/뒤로 남길 문자 수. */
const SNIPPET_BEFORE = 48
const SNIPPET_AFTER = 140

/**
 * 워크스페이스를 가로질러 트랜스크립트를 검색한다.
 *
 * 트랜스크립트는 워크스페이스당 수 MB 까지 자랄 수 있어, 전부 메모리에 올리면 예전에 렌더러가
 * 대화를 통째로 들고 있다가 수백 MB 를 붙들던 문제가 그대로 재현된다([[transcripts]] 주석).
 * 그래서 파일을 줄 단위로 흘려 읽고 **매칭된 항목의 스니펫만** 남긴다 — 상주 메모리는 결과
 * 개수(최대 MAX_HITS)에 비례하고 대화 크기와 무관하다.
 *
 * 결과 순서: 워크스페이스는 가장 최근 매치가 있는 쪽부터, 그 안에서는 대화 순서(위→아래).
 */
export async function searchTranscripts(opts: {
  /** 트랜스크립트 디렉터리(`userData/transcripts`). */
  dir: string
  /** 훑을 워크스페이스. 아카이브 포함 여부는 호출자가 정한다. */
  workspaceIds: string[]
  query: string
  maxHits?: number
  maxPerWorkspace?: number
}): Promise<TranscriptSearchResult> {
  const maxHits = opts.maxHits ?? MAX_HITS
  const maxPerWorkspace = opts.maxPerWorkspace ?? MAX_HITS_PER_WORKSPACE
  const needle = opts.query.trim().toLowerCase()
  const empty: TranscriptSearchResult = { hits: [], truncated: false, scanned: 0, skipped: 0 }
  if (!needle) return empty

  const groups: { hits: TranscriptHit[]; newest: number }[] = []
  let total = 0
  let truncated = false
  let scanned = 0
  let skipped = 0

  for (const workspaceId of opts.workspaceIds) {
    // 상한을 이미 채웠으면 남은 파일은 열지 않는다 — 열어 봐야 담을 자리가 없다.
    if (total >= maxHits) {
      skipped++
      truncated = true
      continue
    }
    const limit = Math.min(maxPerWorkspace, maxHits - total)
    const found = await searchWorkspace(opts.dir, workspaceId, needle, limit)
    scanned++
    if (found.truncated) truncated = true
    if (found.hits.length === 0) continue
    total += found.hits.length
    groups.push({ hits: found.hits, newest: Math.max(...found.hits.map((h) => h.ts)) })
  }

  groups.sort((a, b) => b.newest - a.newest)
  return { hits: groups.flatMap((g) => g.hits), truncated, scanned, skipped }
}

/** 워크스페이스 1개의 트랜스크립트 파일을 훑는다. 파일이 없거나 읽을 수 없으면 빈 결과. */
async function searchWorkspace(
  dir: string,
  workspaceId: string,
  needle: string,
  limit: number
): Promise<{ hits: TranscriptHit[]; truncated: boolean }> {
  const collector = new HitCollector(workspaceId, needle, limit)
  const file = join(dir, `${workspaceId}.jsonl`)
  if (existsSync(file)) {
    try {
      const stream = createReadStream(file, { encoding: 'utf-8' })
      const lines = createInterface({ input: stream, crlfDelay: Infinity })
      try {
        for await (const line of lines) collector.addLine(line)
      } finally {
        lines.close()
        stream.destroy()
      }
    } catch {
      // 읽는 도중 사라졌거나 권한이 없다 — 이 워크스페이스만 건너뛴다.
    }
    return collector.result()
  }

  // 아직 .jsonl 로 마이그레이션되지 않은(한 번도 연 적 없는) 옛 기록도 검색 대상이다 —
  // 여기서 빼면 "분명 있었는데 안 나온다" 가 된다. 마이그레이션은 [[TranscriptStore]] 의 몫이라
  // 검색은 읽기만 한다.
  const legacy = join(dir, `${workspaceId}.json`)
  if (existsSync(legacy)) {
    try {
      const items = JSON.parse(readFileSync(legacy, 'utf-8')) as ChatItem[]
      if (Array.isArray(items)) for (const item of items) collector.add(item)
    } catch {
      // 손상된 레거시 파일은 없는 셈 친다.
    }
  }
  return collector.result()
}

/**
 * 한 워크스페이스의 항목들을 받아 매칭 스니펫만 모은다.
 *
 * JSONL 은 append-only 라 **같은 id 가 여러 번 나오고 마지막이 이긴다**([[parseJsonl]]).
 * 검색도 같은 규칙을 따라야 한다 — 안 그러면 이미 고쳐 쓴 옛 내용이 결과로 잡힌다. 그래서
 * 매치를 id 로 들고 있다가 같은 id 가 다시 오면 통째로 갈아 끼우고(새 줄이 더 이상 매치하지
 * 않으면 결과에서 빠진다), 자리는 첫 등장 순서를 유지한다.
 */
class HitCollector {
  /** id → 매치(없으면 null). 키를 지우지 않아 첫 등장 순서가 보존된다. */
  private byId = new Map<string, TranscriptHit | null>()
  /** 지금 담겨 있는(null 이 아닌) 매치 수. */
  private matched = 0
  private truncated = false

  constructor(
    private workspaceId: string,
    private needle: string,
    private limit: number
  ) {}

  /** JSONL 한 줄. 손상된 줄(크래시 중 부분 append 등)은 조용히 건너뛴다. */
  addLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      this.add(JSON.parse(trimmed) as ChatItem)
    } catch {
      // 무시 — 나머지 줄은 그대로 읽는다.
    }
  }

  add(item: ChatItem): void {
    if (!item || typeof item.id !== 'string') return

    if (!this.byId.has(item.id)) {
      // 상한을 넘긴 뒤에도 파일은 끝까지 읽는다 — 여기서 멈추면 뒤에 오는 같은 id 의 갱신을
      // 놓쳐, 이미 담아 둔 결과가 옛 내용인 채로 남는다.
      if (this.matched >= this.limit) {
        if (this.hitFor(item)) this.truncated = true
        return
      }
      const hit = this.hitFor(item)
      if (!hit) return
      this.byId.set(item.id, hit)
      this.matched++
      return
    }

    const before = this.byId.get(item.id) ?? null
    const after = this.hitFor(item)
    this.byId.set(item.id, after)
    if (before && !after) this.matched--
    else if (!before && after) this.matched++
  }

  result(): { hits: TranscriptHit[]; truncated: boolean } {
    const hits: TranscriptHit[] = []
    for (const hit of this.byId.values()) if (hit) hits.push(hit)
    return { hits, truncated: this.truncated }
  }

  private hitFor(item: ChatItem): TranscriptHit | null {
    const text = itemSearchText(item)
    if (!text) return null
    const at = text.toLowerCase().indexOf(this.needle)
    if (at < 0) return null
    const { snippet, matchStart } = buildSnippet(text, at, this.needle.length)
    return {
      workspaceId: this.workspaceId,
      itemId: item.id,
      kind: item.type,
      ts: typeof item.ts === 'number' ? item.ts : 0,
      snippet,
      matchStart,
      matchLength: this.needle.length
    }
  }
}

/**
 * 매치 주변만 잘라 한 줄 발췌를 만든다. 앞뒤 여백·줄바꿈은 한 칸으로 눌러 목록 한 행에
 * 들어가게 하고, 잘라 낸 쪽에는 … 을 붙인다. matchStart 는 **완성된 스니펫 기준** 위치라
 * 렌더러가 그대로 하이라이트할 수 있다.
 */
export function buildSnippet(
  text: string,
  at: number,
  length: number
): { snippet: string; matchStart: number } {
  const from = Math.max(0, at - SNIPPET_BEFORE)
  const to = Math.min(text.length, at + length + SNIPPET_AFTER)
  // 매치 본문은 손대지 않는다 — 공백을 누르면 길이가 달라져 하이라이트 구간이 어긋난다.
  const prefix = collapse(text.slice(from, at))
  const match = text.slice(at, at + length)
  const suffix = collapse(text.slice(at + length, to))
  const head = from > 0 ? '…' : ''
  const tail = to < text.length ? '…' : ''
  return { snippet: head + prefix + match + suffix + tail, matchStart: head.length + prefix.length }
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ')
}

/**
 * 항목 종류별 검색 대상 텍스트. 화면에 실제로 보이는 것과 맞춘다(MessageList 의 대화 내 검색과
 * 같은 기준) — 보이지 않는 필드까지 걸리면 "왜 잡혔는지" 를 알 수 없는 결과가 나온다.
 *
 * 파싱한 JSON 은 우리가 쓴 그대로라는 보장이 없으므로(옛 버전·부분 손상) 문자열 여부를 확인한다.
 */
function itemSearchText(item: ChatItem): string {
  const o = item as unknown as Record<string, unknown>
  switch (item.type) {
    case 'user':
    case 'assistant':
    case 'thinking':
    case 'system':
    case 'error':
    case 'tool_result':
      return str(o.text)
    case 'bash':
      return `${str(o.command)}\n${str(o.output)}`
    case 'tool_use':
      // 도구 이름만으로는 "auth.ts 를 어디서 고쳤지" 에 답할 수 없다 — 화면 요약에 뜨는
      // 입력 한 줄(파일 경로·명령·패턴)까지 포함한다.
      return `${str(o.name)} ${toolInputSummary(o.input)}`
    case 'task':
      return `${str(o.name)} ${str(o.description)} ${str(o.summary)}`
    case 'handoff':
      return `${str(o.childName)} ${str(o.childBranch)} ${str(o.summary)}`
    default:
      return ''
  }
}

/** 도구 입력에서 화면 요약에 쓰이는 한 줄(MessageList 의 summarizeToolInput 과 같은 기준). */
function toolInputSummary(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'description']) {
    const value = o[key]
    if (typeof value === 'string') return value
  }
  return ''
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
