import { app } from 'electron'
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic, appendFileDurable } from './fsutil'
import type { ChatItem } from '@shared/types'

/** 메모리 캐시에 동시에 보유할 최대 workspace 수. 초과 시 LRU 로 가장 오래된 것을 제거한다. */
const CACHE_LIMIT = 20

/** ChatItem 한 개를 JSONL 한 줄로 직렬화한다(끝 개행 포함). */
function serializeItem(item: ChatItem): string {
  return JSON.stringify(item) + '\n'
}

/**
 * JSONL 본문을 ChatItem[] 로 파싱한다.
 * 같은 id 가 여러 줄에 있으면 마지막 줄이 이긴다(last-wins) — append 기반 upsert 의 "갱신" 의미.
 * 첫 등장 순서는 보존한다(채팅 표시 순서). 파싱 실패한 줄(부분 append 등)은 건너뛴다.
 */
function parseJsonl(text: string): ChatItem[] {
  const byId = new Map<string, ChatItem>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const item = JSON.parse(trimmed) as ChatItem
      // Map 의 기존 키 재할당은 위치를 유지하므로 last-wins + 첫 등장 순서가 동시에 만족된다.
      byId.set(item.id, item)
    } catch {
      // 손상된 줄(크래시 중 부분 append 등)은 무시한다.
    }
  }
  return [...byId.values()]
}

/**
 * workspace 별 대화 기록을 JSONL 파일로 영속화한다(줄당 ChatItem 1개).
 * 설정 파일([[store]])과 분리한 이유는 트랜스크립트가 커질 수 있어서다.
 *
 * 항목 추가는 파일 append(O(1)) 로 처리해, 매번 전체를 다시 쓰던 비용(O(n²))을 없앤다.
 * 같은 id 의 갱신은 새 줄을 덧붙이고 읽을 때 last-wins 로 합친다([[parseJsonl]]).
 * 메모리 캐시는 LRU 상한을 둬 많은 workspace 를 열어도 무한정 커지지 않게 한다.
 */
class TranscriptStore {
  private dir: string
  /** 삽입 순서 = LRU 순서(맨 앞=가장 오래 전 사용, 맨 뒤=최근 사용). */
  private cache = new Map<string, ChatItem[]>()

  constructor() {
    this.dir = join(app.getPath('userData'), 'transcripts')
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
  }

  private fileFor(workspaceId: string): string {
    return join(this.dir, `${workspaceId}.jsonl`)
  }

  /** 옛 형식(JSON 배열) 파일 경로. 마이그레이션·제거에만 쓴다. */
  private legacyFileFor(workspaceId: string): string {
    return join(this.dir, `${workspaceId}.json`)
  }

  load(workspaceId: string): ChatItem[] {
    const cached = this.cache.get(workspaceId)
    if (cached) {
      this.touch(workspaceId, cached)
      return cached
    }
    const items = this.readFromDisk(workspaceId)
    this.touch(workspaceId, items)
    return items
  }

  /** id 가 이미 있으면 갱신, 없으면 추가. 파일에는 append, 캐시에는 last-wins 로 반영한다. */
  upsert(workspaceId: string, item: ChatItem): void {
    // 캐시에 없으면 먼저 디스크 상태를 적재한다 — 레거시 .json 마이그레이션이 선행되어,
    // append 가 옛 기록과 분리된 .jsonl 을 새로 만들어 버리는 일을 막는다.
    if (!this.cache.has(workspaceId)) this.load(workspaceId)

    appendFileDurable(this.fileFor(workspaceId), serializeItem(item))

    const cached = this.cache.get(workspaceId)
    if (cached) {
      const idx = cached.findIndex((i) => i.id === item.id)
      if (idx >= 0) cached[idx] = item
      else cached.push(item)
      this.touch(workspaceId, cached)
    }
  }

  remove(workspaceId: string): void {
    this.cache.delete(workspaceId)
    rmSync(this.fileFor(workspaceId), { force: true })
    rmSync(this.legacyFileFor(workspaceId), { force: true })
  }

  /** 디스크에서 읽는다. 레거시 .json 만 있으면 .jsonl 로 1회 마이그레이션한다. */
  private readFromDisk(workspaceId: string): ChatItem[] {
    const file = this.fileFor(workspaceId)
    if (existsSync(file)) {
      try {
        return parseJsonl(readFileSync(file, 'utf-8'))
      } catch {
        return []
      }
    }

    const legacy = this.legacyFileFor(workspaceId)
    if (existsSync(legacy)) {
      let items: ChatItem[]
      try {
        items = JSON.parse(readFileSync(legacy, 'utf-8')) as ChatItem[]
      } catch {
        items = []
      }
      // .jsonl 로 원자적으로 쓰고 나서 레거시 파일을 제거한다.
      writeFileAtomic(file, items.map(serializeItem).join(''))
      rmSync(legacy, { force: true })
      return items
    }

    return []
  }

  /** 캐시를 최근 사용으로 갱신하고 LRU 상한을 적용한다. */
  private touch(workspaceId: string, items: ChatItem[]): void {
    this.cache.delete(workspaceId)
    this.cache.set(workspaceId, items)
    while (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }
}

let instance: TranscriptStore | null = null

export function getTranscripts(): TranscriptStore {
  if (!instance) instance = new TranscriptStore()
  return instance
}
