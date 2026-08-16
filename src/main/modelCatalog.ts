import type { AgentBackendId, ModelOption } from '@shared/types'

/**
 * 백엔드별 모델 목록의 마지막 조회 결과.
 *
 * 목록 조회는 **비동기**다 — Codex 는 app-server 에 `model/list` 를 물어야 알 수 있다.
 * 그런데 원격 미러는 dispatch 마다 동기로 도는 투영이라 거기서 기다릴 수 없고, 폰에 보낼
 * 모델 라벨은 랩탑이 만들어야 한다(폰에는 카탈로그가 없다). 그래서 렌더러가 이미 시키는
 * 조회(store 의 refreshAgents — 기동 시·창 포커스마다)의 답을 지나가는 길에 적어 둔다.
 *
 * 아직 한 번도 못 읽었으면 빈 목록이고, 그때 라벨은 모델 ID 로 떨어진다(modelLabel) —
 * 데스크톱이 카탈로그 조회에 실패했을 때와 같은 모습이라 새로 만든 실패 상태가 아니다.
 *
 * 빈 결과는 적지 않는다. 백엔드가 잠깐 못 뜬 사이의 빈 목록으로 멀쩡한 카탈로그를 덮으면,
 * 이미 잘 나오던 라벨이 ID 로 되돌아간다.
 */
const cache = new Map<AgentBackendId, ModelOption[]>()

export function rememberModels(id: AgentBackendId, models: ModelOption[]): void {
  if (models.length > 0) cache.set(id, models)
}

export function cachedModels(id: AgentBackendId): ModelOption[] {
  return cache.get(id) ?? EMPTY
}

const EMPTY: ModelOption[] = []
