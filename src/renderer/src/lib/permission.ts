import type { AgentBackendMeta, PermissionMode, PermissionModeInfo } from '@shared/types'
import type { PermissionRequest } from '@shared/types'
import { PERMISSION_INPUT_TEXT_KEYS } from '@shared/askSummary'

export { nextPermissionMode, normalizePermissionMode } from '@shared/types'

/**
 * 권한 모드의 명칭·설명·푸터는 **백엔드가 선언한다**(main 의 agent 레지스트리 → IPC).
 * Claude Code 와 Codex 는 모드 집합도 의미도 다르므로, 렌더러가 상수로 들고 있으면 반드시
 * 어긋난다. 이 모듈은 그 목록을 조회하는 헬퍼만 제공한다.
 */

/** 백엔드가 노출하는 권한 모드 목록(배열 순서 = shift+tab 순환 순서). */
export function permissionModesFor(meta: AgentBackendMeta | undefined): PermissionModeInfo[] {
  return meta?.permissionModes ?? []
}

/** 모드 1개의 표시 정보. 백엔드가 모르는 모드면 undefined. */
export function permissionModeInfo(
  meta: AgentBackendMeta | undefined,
  mode: PermissionMode
): PermissionModeInfo | undefined {
  return meta?.permissionModes.find((m) => m.id === mode)
}

/** 드롭다운·설정 표시용 명칭. 모르는 모드면 식별자를 그대로 보여 준다. */
export function permissionModeLabel(
  meta: AgentBackendMeta | undefined,
  mode: PermissionMode
): string {
  return permissionModeInfo(meta, mode)?.label ?? mode
}

/** 입력창 아래 푸터 배너. null 이면 배너 없이 단축키 힌트만 보여 준다. */
export function permissionModeFooter(
  meta: AgentBackendMeta | undefined,
  mode: PermissionMode
): { symbol: string; text: string } | null {
  return permissionModeInfo(meta, mode)?.footer ?? null
}

/** 권한 요청 입력을 한 줄 요약으로(명령/경로/URL 등 알려진 키 우선). 프롬프트·큐 패널 공용. */
export function summarizePermission(request: PermissionRequest): string {
  const input = request.input
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>
    for (const key of PERMISSION_INPUT_TEXT_KEYS) {
      if (typeof obj[key] === 'string' && obj[key]) return obj[key] as string
    }
    const keys = Object.keys(obj)
    if (keys.length) return JSON.stringify(obj, null, 2)
  }
  return request.decisionReason ?? ''
}
