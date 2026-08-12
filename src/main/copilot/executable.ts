import { runLoginShell } from '../shell'

export interface CopilotInstall {
  path: string | null
  usable: boolean
  reason?: string
}

export const COPILOT_INSTALL_HINT = 'Install with: npm i -g @github/copilot'

// GUI 앱의 빈약한 PATH 를 피하려고 로그인 셸을 반드시 거친다. 최소 버전은 검증된 하한이 없어
// 추측으로 막지 않고 실제 ACP 핸드셰이크가 호환성을 판정하게 둔다.
let cached: { at: number; value: CopilotInstall } | null = null
const CACHE_MS = 10_000

export async function detectCopilot(): Promise<CopilotInstall> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value
  const { stdout, code } = await runLoginShell('command -v copilot')
  const path = code === 0 ? stdout.trim().split('\n')[0] : null
  const value: CopilotInstall = path
    ? { path, usable: true }
    : {
        path: null,
        usable: false,
        reason: `GitHub Copilot CLI (\`copilot\`) is not installed. ${COPILOT_INSTALL_HINT}`
      }
  cached = { at: Date.now(), value }
  return value
}
