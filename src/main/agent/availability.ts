import type { AgentBackendId } from '@shared/types'

// 세션 설정은 동기 계산이지만 CLI 탐지는 비동기다. 이미 도는 가용성 탐지의 마지막 결과만
// 보관해 둘을 잇고, 첫 탐지 전에는 도구가 조용히 사라지지 않도록 fail-open 한다.
const availability = new Map<AgentBackendId, boolean>()

export function markBackendAvailability(id: AgentBackendId, available: boolean): void {
  availability.set(id, available)
}

export function backendLooksInstalled(id: AgentBackendId): boolean {
  return availability.get(id) ?? true
}
