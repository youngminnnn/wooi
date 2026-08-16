import type { PermissionMode } from '@shared/types'

export type GrokModeId = 'default' | 'plan' | 'ask'
export interface GrokModeSelection {
  modeId: GrokModeId
  meta?: { autoMode?: true; yoloMode?: true }
}

/** Wooi 권한 모드를 Grok 의 mode id 와 세션 생성 메타 두 축으로 나눈다. */
export function grokModeFor(mode: PermissionMode): GrokModeSelection {
  switch (mode) {
    case 'plan':
      return { modeId: 'plan' }
    case 'readOnly':
      return { modeId: 'ask' }
    case 'auto':
      return { modeId: 'default', meta: { autoMode: true } }
    // Grok 의 yoloMode(= CLI 의 `--always-approve`)는 승인을 아예 없앤다. Wooi 에서 그 뜻을
    // 이미 가진 모드가 `fullAccess` 다 — 새 모드를 만들면 같은 뜻이 둘이 된다.
    case 'fullAccess':
      return { modeId: 'default', meta: { yoloMode: true } }
    case 'default':
    default:
      return { modeId: 'default' }
  }
}

/** Grok 의 두 축을 Wooi 권한 모드로 합친다. yolo 가 auto 보다 우선한다. */
export function permissionModeFromGrok(
  modeId: GrokModeId,
  meta?: { autoMode?: boolean; yoloMode?: boolean } | null
): PermissionMode {
  if (modeId === 'plan') return 'plan'
  if (modeId === 'ask') return 'readOnly'
  if (meta?.yoloMode) return 'fullAccess'
  if (meta?.autoMode) return 'auto'
  return 'default'
}

/**
 * 세션 중에는 mode 축만 서버에 바꾸고, auto/yolo 축은 승인 요청 응답 정책으로 흉내 낸다.
 * `_meta` 를 바꾸려고 세션을 다시 열면 대화 맥락이 끊기므로 [[grok/manager]] 가 이 결정을 따른다.
 */
export function midSessionModeFor(mode: PermissionMode): {
  modeId: GrokModeId
  autoApprove: 'none' | 'auto' | 'yolo'
} {
  const selection = grokModeFor(mode)
  return {
    modeId: selection.modeId,
    autoApprove: selection.meta?.yoloMode ? 'yolo' : selection.meta?.autoMode ? 'auto' : 'none'
  }
}
