import type { PermissionMode, PermissionRequest } from '@shared/types'

/**
 * Claude Code 와 동일한 권한 모드 명칭·순환·푸터 문구.
 * Shift+Tab 순환 순서: default → accept edits → plan → auto.
 */
export const PERMISSION_ORDER: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto']

/** 드롭다운/설정 표시용 명칭 (Claude Code 노출 명칭). */
export const PERMISSION_LABELS: Record<PermissionMode, string> = {
  default: 'Default',
  acceptEdits: 'Accept edits',
  plan: 'Plan mode',
  auto: 'Auto mode'
}

export const PERMISSION_DESCRIPTIONS: Record<PermissionMode, string> = {
  default: 'Ask before every tool use',
  acceptEdits: 'Auto-accept file edits, ask for the rest',
  plan: 'Read-only — plan without executing',
  auto: 'A classifier approves/denies automatically'
}

/**
 * 입력창 아래 푸터. Claude Code 스타일(예: `⏵⏵ accept edits on`).
 * default 모드는 별도 배너 없이 단축키 힌트만 보여준다.
 */
export const PERMISSION_FOOTER: Record<PermissionMode, { symbol: string; text: string } | null> = {
  default: null,
  acceptEdits: { symbol: '⏵⏵', text: 'accept edits on' },
  plan: { symbol: '⏸', text: 'plan mode on' },
  auto: { symbol: '⏵⏵', text: 'auto mode on' }
}

export function nextPermissionMode(mode: PermissionMode): PermissionMode {
  const i = PERMISSION_ORDER.indexOf(mode)
  return PERMISSION_ORDER[(i + 1) % PERMISSION_ORDER.length]
}

/** 권한 요청 입력을 한 줄 요약으로(명령/경로/URL 등 알려진 키 우선). 프롬프트·큐 패널 공용. */
export function summarizePermission(request: PermissionRequest): string {
  const input = request.input
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>
    for (const key of ['command', 'file_path', 'path', 'url', 'pattern', 'query', 'description']) {
      if (typeof obj[key] === 'string' && obj[key]) return obj[key] as string
    }
    const keys = Object.keys(obj)
    if (keys.length) return JSON.stringify(obj, null, 2)
  }
  return request.decisionReason ?? ''
}
