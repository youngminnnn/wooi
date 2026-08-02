import { app } from 'electron'
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { appendFileDurable } from '../fsutil'
import type { ReviewActivityItem, ReviewBundle, ReviewDiff, ReviewFinding } from '@shared/types'

/** 메모리에 동시에 들고 있을 최대 리뷰 수. 초과분은 LRU 로 밀어낸다. */
const CACHE_LIMIT = 8

/**
 * 리뷰 1건의 덩치 큰 부분(diff·지적·활동)을 JSONL 로 영속화한다.
 *
 * app.json([[store]])과 나눈 이유는 트랜스크립트와 같다 — app.json 은 변경마다 파일 전체를
 * 다시 쓰고 상태 방송마다 통째로 직렬화되는데, 큰 PR 의 diff 는 수백 KB 다.
 *
 * 줄 하나가 레코드 하나이고, 같은 id 가 여러 번 나오면 마지막이 이긴다(append 기반 upsert).
 * diff 는 여러 개일 이유가 없으므로 고정 id 를 써서 덮어쓴다.
 */
type ReviewRecord =
  | { id: string; rec: 'diff'; diff: ReviewDiff }
  | { id: string; rec: 'finding'; finding: ReviewFinding }
  | { id: string; rec: 'activity'; item: ReviewActivityItem }

/** diff 레코드의 고정 id — 새 diff 를 append 하면 이전 것을 덮어쓴다. */
const DIFF_ID = '__diff__'

function serialize(rec: ReviewRecord): string {
  return JSON.stringify(rec) + '\n'
}

/**
 * JSONL 을 레코드 배열로 파싱한다.
 * 같은 id 는 last-wins, 첫 등장 순서는 보존(활동 타임라인의 시간 순서가 곧 이 순서다).
 * 파싱 실패한 줄(크래시 중 부분 append 등)은 조용히 건너뛴다.
 */
function parseJsonl(text: string): ReviewRecord[] {
  const byId = new Map<string, ReviewRecord>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const rec = JSON.parse(trimmed) as ReviewRecord
      if (rec && typeof rec.id === 'string') byId.set(rec.id, rec)
    } catch {
      // 손상된 줄은 무시한다.
    }
  }
  return [...byId.values()]
}

function toBundle(records: ReviewRecord[]): ReviewBundle {
  const bundle: ReviewBundle = { diff: null, findings: [], activity: [] }
  for (const rec of records) {
    if (rec.rec === 'diff') bundle.diff = rec.diff
    else if (rec.rec === 'finding') bundle.findings.push(rec.finding)
    else bundle.activity.push(rec.item)
  }
  return bundle
}

class ReviewBundleStore {
  private dir: string
  /** 삽입 순서 = LRU 순서. */
  private cache = new Map<string, ReviewBundle>()

  constructor() {
    this.dir = join(app.getPath('userData'), 'reviews')
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
  }

  private fileFor(reviewId: string): string {
    return join(this.dir, `${reviewId}.jsonl`)
  }

  load(reviewId: string): ReviewBundle {
    const cached = this.cache.get(reviewId)
    if (cached) {
      this.touch(reviewId, cached)
      return cached
    }
    const bundle = this.readFromDisk(reviewId)
    this.touch(reviewId, bundle)
    return bundle
  }

  setDiff(reviewId: string, diff: ReviewDiff): void {
    this.append(reviewId, { id: DIFF_ID, rec: 'diff', diff }, (b) => {
      b.diff = diff
    })
  }

  /** 지적을 추가하거나(같은 id 면) 갱신한다. 후속 턴의 지적은 기존 목록에 덧붙는다. */
  upsertFinding(reviewId: string, finding: ReviewFinding): void {
    this.append(reviewId, { id: finding.id, rec: 'finding', finding }, (b) => {
      const idx = b.findings.findIndex((f) => f.id === finding.id)
      if (idx >= 0) b.findings[idx] = finding
      else b.findings.push(finding)
    })
  }

  addActivity(reviewId: string, item: ReviewActivityItem): void {
    this.append(reviewId, { id: item.id, rec: 'activity', item }, (b) => {
      const idx = b.activity.findIndex((a) => a.id === item.id)
      if (idx >= 0) b.activity[idx] = item
      else b.activity.push(item)
    })
  }

  remove(reviewId: string): void {
    this.cache.delete(reviewId)
    rmSync(this.fileFor(reviewId), { force: true })
  }

  private append(reviewId: string, rec: ReviewRecord, apply: (b: ReviewBundle) => void): void {
    // 캐시가 비어 있으면 먼저 디스크를 적재한다 — 그러지 않으면 append 한 값만 든 반쪽짜리
    // 번들이 캐시에 앉아, 다음 load 가 기존 기록을 못 본 채로 응답한다.
    if (!this.cache.has(reviewId)) this.load(reviewId)
    appendFileDurable(this.fileFor(reviewId), serialize(rec))
    const bundle = this.cache.get(reviewId)
    if (bundle) {
      apply(bundle)
      this.touch(reviewId, bundle)
    }
  }

  private readFromDisk(reviewId: string): ReviewBundle {
    const file = this.fileFor(reviewId)
    if (!existsSync(file)) return { diff: null, findings: [], activity: [] }
    try {
      return toBundle(parseJsonl(readFileSync(file, 'utf-8')))
    } catch {
      return { diff: null, findings: [], activity: [] }
    }
  }

  private touch(reviewId: string, bundle: ReviewBundle): void {
    this.cache.delete(reviewId)
    this.cache.set(reviewId, bundle)
    while (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }
}

let instance: ReviewBundleStore | null = null

export function getReviewBundles(): ReviewBundleStore {
  if (!instance) instance = new ReviewBundleStore()
  return instance
}

// 테스트용 — Electron 없이 파싱 규칙만 검증할 수 있게 노출한다.
export const __test = { parseJsonl, toBundle, serialize, DIFF_ID }
