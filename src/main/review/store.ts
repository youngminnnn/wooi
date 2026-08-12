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
  /**
   * 레이어 1건의 diff. **PR 마다 레코드가 하나**라 어느 레이어를 다시 받아도 그 레이어만
   * 덮어쓴다(스택에서는 아래가 바뀌면 위쪽만 다시 받는다).
   * `prNumber` 가 없는 레코드는 옛 단일 PR 리뷰가 남긴 것이다.
   */
  | { id: string; rec: 'diff'; diff: ReviewDiff; prNumber?: number }
  | { id: string; rec: 'finding'; finding: ReviewFinding }
  /**
   * 버린 지적의 묘비. **지적과 같은 id 를 쓴다** — last-wins 규칙이 그대로 삭제로 동작하고,
   * append 전용 파일을 다시 쓰지 않아도 된다.
   */
  | { id: string; rec: 'finding-dismissed' }
  | { id: string; rec: 'activity'; item: ReviewActivityItem }
  /**
   * "이 파일은 봤다" 표시. **그때의 내용 지문을 함께 남긴다** — 새 커밋으로 파일이 바뀌면
   * 지문이 어긋나 자동으로 안 본 것이 된다([[reviewViewed]]).
   */
  | { id: string; rec: 'file-viewed'; path: string; hash: string }
  /** 표시를 끈 묘비. 지적의 묘비와 같은 결로 **표시와 같은 id 를 쓴다**. */
  | { id: string; rec: 'file-unviewed'; path: string }

/** 옛 단일 PR 리뷰가 쓰던 diff 레코드 id. 지금도 읽어야 한다. */
const DIFF_ID = '__diff__'

/** 레이어별 diff 레코드의 id — 같은 PR 의 diff 를 다시 쓰면 그것만 덮어쓴다. */
function diffId(prNumber: number): string {
  return `${DIFF_ID}:${prNumber}`
}

/** 파일별 viewed 레코드의 id. 같은 파일을 다시 토글하면 이 id 로 덮어써진다. */
function viewedId(path: string): string {
  return `viewed:${path}`
}

function emptyBundle(): ReviewBundle {
  return { diffs: [], findings: [], activity: [], viewed: {} }
}

function serialize(rec: ReviewRecord): string {
  return JSON.stringify(rec) + '\n'
}

/**
 * 레이어의 diff 를 번들에 넣거나 갈아 끼운다. 순서는 **처음 들어온 순서**(= 아래→위로 받는
 * 순서)를 지킨다 — 화면이 레이어를 그 순서로 그린다.
 *
 * PR 번호가 없는 레코드는 옛 단일 PR 리뷰가 남긴 것이라 번호를 붙일 수 없다. 그때는 0 으로
 * 자리를 잡아 두고, 세션의 유일한 레이어로 읽힌다([[types]] layerFor).
 */
function upsertDiff(bundle: ReviewBundle, prNumber: number | undefined, diff: ReviewDiff): void {
  const n = prNumber ?? 0
  const idx = bundle.diffs.findIndex((d) => d.prNumber === n)
  if (idx >= 0) {
    bundle.diffs[idx] = { prNumber: n, diff }
    return
  }
  // 번호가 붙은 diff 가 처음 들어왔는데 번호 없는 자리(0)가 남아 있으면 그것을 대체한다.
  // 옛 리뷰를 다시 돌리면 같은 PR 의 diff 가 옛 레코드와 새 레코드로 둘 다 남는데, 그대로 두면
  // 화면에 같은 파일이 두 벌 그려진다. 옛 리뷰는 레이어가 하나뿐이라 이 대체는 언제나 옳다.
  const legacy = n > 0 ? bundle.diffs.findIndex((d) => d.prNumber === 0) : -1
  if (legacy >= 0) bundle.diffs[legacy] = { prNumber: n, diff }
  else bundle.diffs.push({ prNumber: n, diff })
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
  const bundle: ReviewBundle = emptyBundle()
  for (const rec of records) {
    // 종류를 하나씩 확인한다 — "나머지는 활동" 으로 두면 묘비 같은 새 레코드가 활동
    // 타임라인에 undefined 로 섞여 들어간다.
    if (rec.rec === 'diff') upsertDiff(bundle, rec.prNumber, rec.diff)
    else if (rec.rec === 'finding') bundle.findings.push(rec.finding)
    else if (rec.rec === 'activity') bundle.activity.push(rec.item)
    else if (rec.rec === 'file-viewed') bundle.viewed[rec.path] = rec.hash
    else if (rec.rec === 'file-unviewed') delete bundle.viewed[rec.path]
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

  setDiff(reviewId: string, prNumber: number, diff: ReviewDiff): void {
    this.append(reviewId, { id: diffId(prNumber), rec: 'diff', diff, prNumber }, (b) => {
      upsertDiff(b, prNumber, diff)
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

  /** 지적을 목록에서 지운다. 사용자가 "이건 안 달겠다" 고 결정한 것이라 되살리지 않는다. */
  dismissFinding(reviewId: string, findingId: string): void {
    this.append(reviewId, { id: findingId, rec: 'finding-dismissed' }, (b) => {
      b.findings = b.findings.filter((f) => f.id !== findingId)
    })
  }

  /**
   * 파일의 "봤음" 표시를 켜거나(hash) 끈다(null).
   * 같은 id 로 덮어쓰므로 토글이 그대로 last-wins 로 풀린다.
   */
  setFileViewed(reviewId: string, key: string, hash: string | null): void {
    const rec: ReviewRecord = hash
      ? { id: viewedId(key), rec: 'file-viewed', path: key, hash }
      : { id: viewedId(key), rec: 'file-unviewed', path: key }
    this.append(reviewId, rec, (b) => {
      if (hash) b.viewed[key] = hash
      else delete b.viewed[key]
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
    if (!existsSync(file)) return emptyBundle()
    try {
      return toBundle(parseJsonl(readFileSync(file, 'utf-8')))
    } catch {
      return emptyBundle()
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
export const __test = { parseJsonl, toBundle, serialize, DIFF_ID, diffId, viewedId }
