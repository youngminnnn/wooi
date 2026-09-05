import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { appendFileDurable, writeFileAtomic } from './fsutil'
import {
  ARTIFACT_ID_RE,
  ARTIFACT_KINDS,
  ARTIFACT_MAX_PER_WORKSPACE,
  ARTIFACT_MAX_VERSIONS
} from '@shared/types'
import type { ArtifactKind, ArtifactMeta, ArtifactSummary } from '@shared/types'

/** 동시에 파싱해 들고 있을 최대 워크스페이스 수(LRU). [[transcripts]] 와 같은 이유·같은 값. */
const CACHE_LIMIT = 20

/**
 * 아티팩트 전체 삭제를 나타내는 버전 번호.
 *
 * index.jsonl 은 append-only 라 줄을 지울 수 없다 — 대신 묘비를 덧붙인다. 0 을 쓰는 이유는
 * `parseArtifactUrl` 이 버전 0 을 이미 거절하기 때문이다([[shared/artifactUrl]]) — 묘비가
 * 실수로 서빙 가능한 주소를 갖는 일이 문법 차원에서 불가능하다.
 */
const TOMBSTONE_VERSION = 0

/** 종류별 원본 파일 이름. `html` 만 원본이 곧 문서라 따로 두지 않는다. */
const SOURCE_FILE: Record<ArtifactKind, string> = {
  html: 'index.html',
  svg: 'source.svg',
  markdown: 'source.md',
  react: 'source.jsx',
  mermaid: 'source.mmd'
}

/** 이 종류의 원본 파일 이름. */
export function sourceFileFor(kind: ArtifactKind): string {
  return SOURCE_FILE[kind]
}

/**
 * 잘못된 입력을 사용자(=모델)가 고칠 수 있는 문장으로 돌려주기 위한 에러.
 *
 * 도구 핸들러가 이걸 그대로 throw 하면 registry 가 `{ok:false}` 로 바꿔 모델에게 전한다
 * ([[agent/tools/registry]]). 그래서 문구는 "무엇이 틀렸나" 가 아니라 **"다음에 무엇을
 * 하면 되나"** 여야 한다.
 */
export class ArtifactError extends Error {}

/** 한 줄이 아티팩트 하나의 한 버전. 같은 (id, version) 이면 마지막 줄이 이긴다. */
function parseIndex(text: string): Map<string, ArtifactMeta> {
  const byKey = new Map<string, ArtifactMeta>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const meta = JSON.parse(trimmed) as ArtifactMeta
      if (typeof meta?.id !== 'string' || typeof meta?.version !== 'number') continue
      byKey.set(`${meta.id}@${meta.version}`, meta)
    } catch {
      // 크래시 중 잘린 줄. [[transcripts]] 와 같이 조용히 건너뛴다.
    }
  }
  return byKey
}

/**
 * 워크스페이스별 아티팩트 저장소.
 *
 * [[transcripts]] 를 본떴다 — userData 아래 디렉터리 하나, 워크스페이스별 append-only 인덱스,
 * LRU 캐시, lazy 싱글턴. **lazy 인 것이 필수다**: `app.getPath('userData')` 는
 * `applyDevPaths()` 가 dev 경로를 갈아 끼운 **뒤에** 읽혀야 한다([[paths]]).
 *
 * 본문을 `wooi.json` 에 못 넣는 이유는 [[store]] 가 상태 방송마다 통째로 재직렬화하기
 * 때문이고, 트랜스크립트 JSONL 에 못 넣는 이유는 그 파일이 워크스페이스를 열 때마다 통째로
 * 파싱되기 때문이다([[transcript-store-format]]) — 본문은 파일로 따로 눕는다.
 */
class ArtifactStore {
  private dir: string
  /** 삽입 순서 = LRU 순서. 값은 `${id}@${version}` → 메타. */
  private cache = new Map<string, Map<string, ArtifactMeta>>()

  constructor() {
    this.dir = join(app.getPath('userData'), 'artifacts')
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
  }

  /**
   * 경로 조립의 **유일한** 출구. 여기를 거치지 않는 경로 조립을 이 파일에 두지 않는다.
   *
   * `artifactId` 는 모델이 정하는 문자열이라 `writeFileAtomic` 에 그대로 넘기면
   * `artifacts/ws/../../../../.zshrc` 로 rename 할 수 있다. 정규식으로 문자셋을 막고,
   * 그 위에 **resolve 뒤 봉쇄 검사**를 한 겹 더 둔다 — 정규식은 언젠가 완화되지만
   * 봉쇄 검사는 그때도 남는다.
   */
  private dirFor(workspaceId: string, artifactId?: string, version?: number): string {
    if (!ARTIFACT_ID_RE.test(workspaceId)) throw new ArtifactError('Unknown workspace.')
    if (artifactId !== undefined && !ARTIFACT_ID_RE.test(artifactId))
      throw new ArtifactError(
        `Invalid artifact_id "${artifactId}". Use lowercase letters, digits and hyphens — for example "sales-dashboard".`
      )
    if (version !== undefined && (!Number.isSafeInteger(version) || version < 1))
      throw new ArtifactError('Invalid artifact version.')

    const parts = [workspaceId]
    if (artifactId !== undefined) parts.push(artifactId)
    if (version !== undefined) parts.push(String(version))

    const root = resolve(this.dir)
    const target = resolve(root, ...parts)
    if (target !== root && !target.startsWith(root + sep))
      throw new ArtifactError('Invalid artifact path.')
    return target
  }

  private indexFile(workspaceId: string): string {
    return join(this.dirFor(workspaceId), 'index.jsonl')
  }

  private index(workspaceId: string): Map<string, ArtifactMeta> {
    const cached = this.cache.get(workspaceId)
    if (cached) {
      this.touch(workspaceId, cached)
      return cached
    }
    const file = this.indexFile(workspaceId)
    const parsed = existsSync(file) ? parseIndex(readFileSync(file, 'utf-8')) : new Map()
    this.touch(workspaceId, parsed)
    return parsed
  }

  private touch(workspaceId: string, value: Map<string, ArtifactMeta>): void {
    this.cache.delete(workspaceId)
    this.cache.set(workspaceId, value)
    while (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }

  private append(workspaceId: string, meta: ArtifactMeta): void {
    const dir = this.dirFor(workspaceId)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileDurable(this.indexFile(workspaceId), JSON.stringify(meta) + '\n')
    this.index(workspaceId).set(`${meta.id}@${meta.version}`, meta)
  }

  /**
   * 아티팩트별 **수위선** — 이 번호 이하의 버전은 통째 묘비에 지워졌다.
   *
   * 새 버전 번호는 살아 있는 최고 버전이 아니라 이 값과의 max 에서 이어진다. 그래야 지운 뒤
   * 같은 slug 를 다시 써도 옛 묘비가 새 버전을 같이 죽이지 않는다([[shared/types]] `upTo`).
   */
  private killedUpTo(workspaceId: string): Map<string, number> {
    const marks = new Map<string, number>()
    for (const meta of this.index(workspaceId).values()) {
      if (meta.version !== TOMBSTONE_VERSION || !meta.deleted) continue
      marks.set(meta.id, Math.max(marks.get(meta.id) ?? 0, meta.upTo ?? 0))
    }
    return marks
  }

  /** 살아 있는 버전들을 아티팩트별로 모은다(내림차순). */
  private liveVersions(workspaceId: string): Map<string, ArtifactMeta[]> {
    const killed = this.killedUpTo(workspaceId)

    const byId = new Map<string, ArtifactMeta[]>()
    for (const meta of this.index(workspaceId).values()) {
      if (meta.version === TOMBSTONE_VERSION || meta.deleted) continue
      if (meta.version <= (killed.get(meta.id) ?? 0)) continue
      const list = byId.get(meta.id) ?? []
      list.push(meta)
      byId.set(meta.id, list)
    }
    for (const list of byId.values()) list.sort((a, b) => b.version - a.version)
    return byId
  }

  /** 이 워크스페이스의 아티팩트 목록. 최근에 고친 것이 앞. */
  list(workspaceId: string): ArtifactSummary[] {
    const summaries: ArtifactSummary[] = []
    for (const [id, versions] of this.liveVersions(workspaceId)) {
      const latest = versions[0]
      summaries.push({
        id,
        title: latest.title,
        kind: latest.kind,
        versions: versions.map((v) => v.version),
        updatedAt: latest.createdAt
      })
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /**
   * 한 버전의 메타. 없으면 null.
   *
   * 읽기 경로에서도 id 검증을 **먼저** 한다. 인덱스에 없으니 어차피 null 이 나오긴 하지만,
   * 그건 "인덱스가 방어한다" 는 우연에 기대는 것이다 — 읽기와 쓰기가 같은 관문을 쓰게 둔다.
   */
  meta(workspaceId: string, artifactId: string, version: number): ArtifactMeta | null {
    this.dirFor(workspaceId, artifactId, version)
    const versions = this.liveVersions(workspaceId).get(artifactId)
    return versions?.find((v) => v.version === version) ?? null
  }

  /**
   * 서빙용 파일 읽기. 파일 이름은 **호출자가 이미 검증한 것**이어야 한다
   * (`parseArtifactUrl` 이 세 개로 제한한다).
   */
  readFile(workspaceId: string, artifactId: string, version: number, file: string): string | null {
    if (!this.meta(workspaceId, artifactId, version)) return null
    const path = join(this.dirFor(workspaceId, artifactId, version), file)
    if (!existsSync(path)) return null
    return readFileSync(path, 'utf-8')
  }

  /** 원본(모델이 쓴 것) 읽기 — 복사·내보내기용. */
  readSource(
    workspaceId: string,
    artifactId: string,
    version: number
  ): { kind: ArtifactKind; text: string } | null {
    const meta = this.meta(workspaceId, artifactId, version)
    if (!meta) return null
    const text = this.readFile(workspaceId, artifactId, version, sourceFileFor(meta.kind))
    return text === null ? null : { kind: meta.kind, text }
  }

  /**
   * 새 버전을 쓴다. 같은 id 로 다시 부르면 n+1 이 된다.
   *
   * `files` 는 이 버전 디렉터리에 그대로 눕는 파일들이다 — 종류별 문서 생성은 호출자(도구
   * 핸들러)의 일이고, 저장소는 무엇을 눕히는지 판단하지 않는다.
   */
  write(
    workspaceId: string,
    input: {
      id: string
      kind: ArtifactKind
      title: string
      files: Record<string, string>
      hasCss?: boolean
    }
  ): ArtifactMeta {
    if (!ARTIFACT_KINDS.includes(input.kind))
      throw new ArtifactError(
        `Unknown kind "${input.kind}". Use one of: ${ARTIFACT_KINDS.join(', ')}.`
      )

    const live = this.liveVersions(workspaceId)
    if (!live.has(input.id) && live.size >= ARTIFACT_MAX_PER_WORKSPACE)
      throw new ArtifactError(
        `This workspace already has ${ARTIFACT_MAX_PER_WORKSPACE} artifacts. Update an existing one by reusing its artifact_id, or ask the user to delete some.`
      )

    // 살아 있는 최고 버전과 묘비의 수위선 중 높은 쪽에서 이어 간다 — 번호는 재사용하지 않는다.
    const version =
      Math.max(
        live.get(input.id)?.[0]?.version ?? 0,
        this.killedUpTo(workspaceId).get(input.id) ?? 0
      ) + 1
    const dir = this.dirFor(workspaceId, input.id, version)
    mkdirSync(dir, { recursive: true })
    for (const [name, body] of Object.entries(input.files)) writeFileAtomic(join(dir, name), body)

    const meta: ArtifactMeta = {
      id: input.id,
      version,
      kind: input.kind,
      title: input.title,
      createdAt: Date.now(),
      ...(input.hasCss && { hasCss: true })
    }
    this.append(workspaceId, meta)
    this.prune(workspaceId, input.id)
    return meta
  }

  /** 오래된 버전을 상한까지 잘라 낸다. 디렉터리를 지우고 묘비를 남긴다. */
  private prune(workspaceId: string, artifactId: string): void {
    const versions = this.liveVersions(workspaceId).get(artifactId) ?? []
    for (const stale of versions.slice(ARTIFACT_MAX_VERSIONS)) {
      rmSync(this.dirFor(workspaceId, artifactId, stale.version), {
        recursive: true,
        force: true
      })
      this.append(workspaceId, { ...stale, deleted: true })
    }
  }

  /** 아티팩트 하나를 통째로 지운다(모든 버전). */
  removeArtifact(workspaceId: string, artifactId: string): void {
    const dir = this.dirFor(workspaceId, artifactId)
    const highest = Math.max(
      this.liveVersions(workspaceId).get(artifactId)?.[0]?.version ?? 0,
      this.killedUpTo(workspaceId).get(artifactId) ?? 0
    )
    rmSync(dir, { recursive: true, force: true })
    this.append(workspaceId, {
      id: artifactId,
      version: TOMBSTONE_VERSION,
      kind: 'html',
      title: '',
      createdAt: Date.now(),
      deleted: true,
      upTo: highest
    })
  }

  /**
   * 워크스페이스의 아티팩트를 전부 지운다.
   *
   * 워크스페이스가 **영구 삭제**될 때만 부른다. 아카이브에서는 부르지 않는다 — 아카이브는
   * 대화를 보존하고([[workspaces]]), 아티팩트도 같은 통이다.
   */
  remove(workspaceId: string): void {
    this.cache.delete(workspaceId)
    rmSync(this.dirFor(workspaceId), { recursive: true, force: true })
  }

  /** 인덱스에 없는 유령 디렉터리를 센다(테스트·진단용). */
  orphanDirs(workspaceId: string): string[] {
    const dir = this.dirFor(workspaceId)
    if (!existsSync(dir)) return []
    const live = this.liveVersions(workspaceId)
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !live.has(e.name))
      .map((e) => e.name)
  }
}

let store: ArtifactStore | null = null

/** 저장소 접근자. 첫 호출 때 만들어진다 — `applyDevPaths()` 뒤여야 한다. */
export function getArtifacts(): ArtifactStore {
  if (!store) store = new ArtifactStore()
  return store
}

/** 테스트 전용 — 싱글턴을 버려 다음 호출이 새 userData 를 읽게 한다. */
export function resetArtifactsForTest(): void {
  store = null
}
