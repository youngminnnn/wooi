import { useMemo } from 'react'
import type {
  AgentBackendId,
  AgentBackendMeta,
  AgentSettings,
  ModelOption,
  Workspace
} from '@shared/types'
import { DEFAULT_AGENT_BACKEND, DEFAULT_AGENT_SETTINGS, agentSettingsFor } from '@shared/types'
import { useStore } from '../store'

/**
 * 에이전트 백엔드 메타 조회 훅.
 *
 * 백엔드 메타(권한 모드·effort 선택지·capabilities·가용성)는 main 이 소유하고 store 의
 * `backends` 슬라이스에 담긴다. 아직 못 읽었으면 undefined 를 돌려주며, 호출부는 저장된 값을
 * 그대로 보여 주는 것으로 폴백해야 한다 — 카탈로그를 못 읽었다고 UI 가 비면 안 된다.
 */
export function useBackend(id: AgentBackendId | undefined): AgentBackendMeta | undefined {
  return useStore((s) => s.backends.find((b) => b.id === id))
}

/** 워크스페이스를 구동하는 백엔드의 메타. */
export function useWorkspaceBackend(
  ws: Workspace | null | undefined
): AgentBackendMeta | undefined {
  return useBackend(ws?.agentBackend ?? DEFAULT_AGENT_BACKEND)
}

/** 백엔드의 모델 선택지. 아직 못 읽었으면 빈 배열. */
export function useModels(id: AgentBackendId | undefined): ModelOption[] {
  return useStore((s) => (id ? (s.models[id] ?? EMPTY) : EMPTY))
}

/** 참조 동일성 유지용 — 매 렌더마다 새 배열을 만들면 zustand 셀렉터가 무한 리렌더를 일으킨다. */
const EMPTY: ModelOption[] = []

/**
 * 이 백엔드의 전역 기본값(모델·effort·권한 모드).
 *
 * 셀렉터는 **저장된 값 그대로**(참조가 안정적인 조각)만 읽고, 기본값 병합은 셀렉터 밖에서
 * 한다. `agentSettingsFor` 는 매 호출 새 객체를 만들므로 셀렉터 안에서 부르면 스냅샷이 매번
 * 달라지고, zustand 가 올라탄 useSyncExternalStore 가 커밋마다 다시 렌더해 무한 루프에
 * 빠진다(React #185 — `useModels` 의 EMPTY 상수, `useAvailableBackends` 와 같은 이유).
 */
export function useAgentSettings(id: AgentBackendId | undefined): AgentSettings {
  const settings = useStore((s) => s.app?.settings)
  return useMemo(() => {
    if (!settings || !id) return DEFAULT_AGENT_SETTINGS
    return agentSettingsFor(settings, id)
  }, [settings, id])
}

/**
 * 실제로 쓸 수 있는(=구동 CLI 가 설치된) 백엔드만. 에이전트 피커는 이 목록이 2개 이상일 때만
 * 노출한다 — 하나뿐인 사용자에게 선택지를 보여 줄 이유가 없다.
 *
 * 걸러내기는 **셀렉터 밖**에서 한다. 셀렉터가 매번 새 배열을 돌려주면 zustand 의 참조 비교가
 * 항상 "바뀜"으로 판정해 무한 리렌더에 빠진다(`useModels` 의 EMPTY 상수와 같은 이유).
 */
export function useAvailableBackends(): AgentBackendMeta[] {
  const backends = useStore((s) => s.backends)
  return useMemo(() => backends.filter((b) => b.available), [backends])
}
