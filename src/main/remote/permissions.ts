import type { PermissionRequest } from '@shared/types'

export const PENDING_PERMISSION_LIMIT = 50
export const PENDING_PERMISSION_MAX_AGE_MS = 30 * 60_000

interface PendingEntry {
  request: PermissionRequest
  addedAt: number
}

export class PendingPermissionRegistry {
  private readonly entries = new Map<string, PendingEntry>()
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  add(request: PermissionRequest): void {
    this.evict()
    this.entries.delete(request.requestId)
    this.entries.set(request.requestId, { request, addedAt: this.now() })
    while (this.entries.size > PENDING_PERMISSION_LIMIT) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  /** 지웠으면 true. 호출자가 "실제로 대기 중이던 것"만 후속 처리하도록. */
  remove(requestId: string): boolean {
    this.evict()
    return this.entries.delete(requestId)
  }

  list(): PermissionRequest[] {
    this.evict()
    return [...this.entries.values()].map((entry) => entry.request)
  }

  toolFor(requestId: string): string | undefined {
    this.evict()
    return this.entries.get(requestId)?.request.toolName
  }

  clear(): void {
    this.entries.clear()
  }

  private evict(): void {
    // 데스크톱 응답 경로는 ipc.ts 안에서 직접 해소되어 여기서 관찰할 수 없으므로,
    // 중앙 응답 훅이 생길 때까지 오래된 요청을 조회 시점에 방어적으로 버린다.
    const cutoff = this.now() - PENDING_PERMISSION_MAX_AGE_MS
    for (const [requestId, entry] of this.entries) {
      if (entry.addedAt < cutoff) this.entries.delete(requestId)
    }
  }
}

export const pendingPermissions = new PendingPermissionRegistry()
