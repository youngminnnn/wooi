import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  REMOTE_MAX_ATTACHMENT_BYTES,
  REMOTE_MAX_ATTACHMENT_NAME_LENGTH,
  REMOTE_MAX_ATTACHMENTS,
  REMOTE_UPLOAD_TTL_MS,
  isRemoteImageMediaType,
  remoteFileExtension,
  type RemoteAttachment
} from '@shared/remote'
import type { ImageAttachment, ImageMediaType } from '@shared/types'
import { log } from '../logger'
import { wooiHome } from '../paths'

/**
 * 폰이 올린 첨부 조각을 모아 두는 곳.
 *
 * 릴레이는 명령 하나에 64KiB 밖에 싣지 못하므로 첨부는 `remote:upload` 여러 건으로 쪼개져
 * 온다(shared/remote.ts 의 「첨부」 절 참고). 여기서 그 조각을 붙였다가 `chat:send` 가
 * 꺼내 간다.
 *
 * **기기별로 나눠 담는다.** 한 통에 담으면 uploadId 만 알면 남의 첨부를 가져갈 수 있는데,
 * uploadId 는 폰이 정하는 값이라 비밀이 아니다.
 */

/** 랩탑이 디스크에 남긴 첨부를 지우는 기준. 에이전트는 받은 즉시 읽으므로 넉넉하다. */
const FILE_TTL_MS = 7 * 24 * 60 * 60_000

interface PendingUpload {
  total: number
  chunks: Array<Buffer | undefined>
  received: number
  bytes: number
  expiresAt: number
}

export class RemoteUploads {
  private readonly byDevice = new Map<string, Map<string, PendingUpload>>()

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * 조각 하나를 받아 둔다. 같은 자리에 다시 오면 덮어쓴다 — 재시도가 실패로 바뀌지 않게.
   * 상한을 넘기거나 앞뒤가 맞지 않으면 throw 한다(그 명령만 실패하고 나머지는 살아 있다).
   */
  chunk(
    deviceId: string,
    uploadId: string,
    index: number,
    total: number,
    chunkBase64: string
  ): { received: number; total: number } {
    this.sweep()
    const pending = this.byDevice.get(deviceId) ?? new Map<string, PendingUpload>()
    this.byDevice.set(deviceId, pending)

    let upload = pending.get(uploadId)
    if (upload === undefined) {
      if (pending.size >= REMOTE_MAX_ATTACHMENTS) {
        throw new Error('too many uploads in flight for this device')
      }
      upload = {
        total,
        chunks: new Array<Buffer | undefined>(total),
        received: 0,
        bytes: 0,
        expiresAt: this.now() + REMOTE_UPLOAD_TTL_MS
      }
      pending.set(uploadId, upload)
    }
    // 같은 업로드의 조각들이 서로 다른 total 을 주장하면 어느 쪽도 믿을 수 없다.
    if (upload.total !== total) throw new Error('upload chunk count changed mid-flight')
    if (index >= upload.total) throw new Error('upload chunk index is out of range')

    const bytes = Buffer.from(chunkBase64, 'base64')
    const previous = upload.chunks[index]
    const nextTotalBytes = upload.bytes - (previous?.length ?? 0) + bytes.length
    if (nextTotalBytes > REMOTE_MAX_ATTACHMENT_BYTES) {
      pending.delete(uploadId)
      throw new Error('attachment is larger than the remote limit')
    }
    if (previous === undefined) upload.received += 1
    upload.chunks[index] = bytes
    upload.bytes = nextTotalBytes
    // 조각이 계속 오는 동안에는 만료를 미룬다 — 느린 회선에서 앞부분이 먼저 썩지 않게.
    upload.expiresAt = this.now() + REMOTE_UPLOAD_TTL_MS
    return { received: upload.received, total: upload.total }
  }

  /** 완성된 업로드를 꺼내고 버린다. 조각이 빠져 있으면 throw. */
  take(deviceId: string, uploadId: string): Buffer {
    this.sweep()
    const pending = this.byDevice.get(deviceId)
    const upload = pending?.get(uploadId)
    if (pending === undefined || upload === undefined) {
      throw new Error('the attachment was never uploaded, or it expired')
    }
    if (upload.received !== upload.total) {
      throw new Error(
        `the attachment is incomplete (${upload.received}/${upload.total} chunks arrived)`
      )
    }
    pending.delete(uploadId)
    if (pending.size === 0) this.byDevice.delete(deviceId)
    return Buffer.concat(upload.chunks.filter((chunk): chunk is Buffer => chunk !== undefined))
  }

  /** 페어링이 끊긴 기기의 조각을 통째로 버린다. */
  forget(deviceId: string): void {
    this.byDevice.delete(deviceId)
  }

  /** 붙들고 있던 조각을 전부 버린다. 다음 전송은 어차피 처음부터 다시 올린다. */
  clear(): void {
    this.byDevice.clear()
  }

  /** 지금 붙들고 있는 업로드 수(테스트·진단용). */
  get pendingCount(): number {
    let count = 0
    for (const pending of this.byDevice.values()) count += pending.size
    return count
  }

  private sweep(): void {
    const now = this.now()
    for (const [deviceId, pending] of this.byDevice) {
      for (const [uploadId, upload] of pending) {
        if (upload.expiresAt <= now) pending.delete(uploadId)
      }
      if (pending.size === 0) this.byDevice.delete(deviceId)
    }
  }
}

export interface ResolvedAttachments {
  /** 모델에 인라인으로 실을 이미지들(데스크톱의 붙여넣기 이미지와 같은 모양). */
  images: ImageAttachment[]
  /** 디스크에 떨군 파일들을 가리키는 `@경로` 멘션. 프롬프트 끝에 붙는다. */
  mentions: string[]
}

/**
 * 올라온 조각을 실제 첨부로 만든다.
 *
 * 이미지는 데스크톱의 붙여넣기와 같은 길을 탄다 — base64 그대로 모델에 실린다.
 * 나머지는 **디스크에 쓰고 `@경로` 로 가리킨다.** 데스크톱이 이미지 아닌 드롭 파일을 다루는
 * 방식과 같은 규칙이라(Composer 의 handleDroppedFiles) 두 화면이 갈리지 않고, base64 로 밀어
 * 넣는 것과 달리 큰 파일이 대화 맥락을 통째로 잡아먹지도 않는다.
 *
 * 하나라도 실패하면 전송 자체를 실패시킨다. 조용히 빠뜨리면 사용자는 첨부가 갔다고 믿은 채로
 * 엉뚱한 답을 받는다 — 그게 못 보내는 것보다 나쁘다.
 */
export function resolveRemoteAttachments(
  uploads: RemoteUploads,
  deviceId: string,
  workspaceId: string,
  attachments: readonly RemoteAttachment[]
): ResolvedAttachments {
  const images: ImageAttachment[] = []
  const mentions: string[] = []
  for (const attachment of attachments) {
    const bytes = uploads.take(deviceId, attachment.uploadId)
    if (isRemoteImageMediaType(attachment.mediaType)) {
      images.push({
        name: safeName(attachment.name, 'png'),
        mediaType: attachment.mediaType as ImageMediaType,
        dataBase64: bytes.toString('base64')
      })
      continue
    }
    const extension = remoteFileExtension(attachment.name)
    if (extension === null) throw new Error(`"${attachment.name}" is not an accepted attachment`)
    mentions.push(
      mention(writeAttachment(workspaceId, safeName(attachment.name, extension), bytes))
    )
  }
  return { images, mentions }
}

/** 첨부를 워크스페이스별 디렉터리에 쓰고 절대 경로를 돌려준다. */
function writeAttachment(workspaceId: string, name: string, bytes: Buffer): string {
  const dir = join(wooiHome(), 'uploads', pathSegment(workspaceId))
  mkdirSync(dir, { recursive: true })
  sweepOldFiles(dir)
  // 같은 이름을 여러 번 보내도 앞의 것을 덮지 않게 시각을 앞에 붙인다.
  const path = join(dir, `${Date.now().toString(36)}-${name}`)
  writeFileSync(path, bytes)
  return path
}

/** 오래된 첨부를 지운다. 실패는 삼킨다 — 청소가 안 됐다고 전송을 막을 이유가 없다. */
function sweepOldFiles(dir: string): void {
  try {
    const cutoff = Date.now() - FILE_TTL_MS
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true })
    }
  } catch (err) {
    log.info(`원격 첨부 정리 실패 — ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * 경로 조각으로 쓸 수 있게 다듬는다. 워크스페이스 id 는 허용목록이 길이만 보므로
 * (`asWorkspaceId`) `..` 같은 값이 올 수 있다고 가정하고 여기서 막는다.
 */
function pathSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '')
  return safe || 'unknown'
}

/**
 * 파일명을 디스크에 쓸 수 있게 다듬는다.
 *
 * 한글 등 비 ASCII 는 **남긴다** — 사용자가 붙인 이름 그대로 보이는 편이 낫고, 위험한 것은
 * 문자 집합이 아니라 경로 구분자와 제어문자다. 공백은 `_` 로 바꾼다(멘션이 공백에서 끊긴다).
 */
function safeName(name: string, fallbackExtension: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, REMOTE_MAX_ATTACHMENT_NAME_LENGTH)
  return cleaned || `attachment.${fallbackExtension}`
}

/**
 * 경로를 CLI 가 이해하는 멘션으로. 규칙은 렌더러의 `mentionWithRange` 와 같다 —
 * 공백이 든 경로만 따옴표로 감싼다(`WOOI_HOME` 이 공백을 품을 수 있다).
 */
function mention(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`
}
