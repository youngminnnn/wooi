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

/** 이 백엔드의 전역 기본값(모델·effort·권한 모드). */
export function useAgentSettings(id: AgentBackendId | undefined): AgentSettings {
  return useStore((s) => {
    const settings = s.app?.settings
    if (!settings || !id) return DEFAULT_AGENT_SETTINGS
    return agentSettingsFor(settings, id)
  })
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
  return useMemo(() => backends.filter((b) => b.available && b.capabilities.mainAgent), [backends])
}

/**
 * PR 리뷰를 돌릴 수 있는 백엔드만(capabilities.review).
 *
 * `useAvailableBackends` 와 지금은 같은 집합이지만 **같은 질문이 아니다** — 리뷰는 백엔드마다
 * 전용 러너가 필요해서(review/run.ts), 워크스페이스를 구동할 수 있다고 리뷰까지 되는 건
 * 아니다. main 의 IPC 게이트도 같은 capability 로 막으므로 여기서도 같은 것을 봐야 피커와
 * 게이트가 어긋나지 않는다.
 */
export function useReviewBackends(): AgentBackendMeta[] {
  const backends = useStore((s) => s.backends)
  return useMemo(() => backends.filter((b) => b.available && b.capabilities.review), [backends])
}

/** 설치되어 서브에이전트가 될 수 있는 전체 목록. 메인 자격과는 별개의 질문이다. */
export function useTeammateBackends(): AgentBackendMeta[] {
  const backends = useStore((s) => s.backends)
  return useMemo(() => backends.filter((b) => b.available), [backends])
}
