import { isAbsolute } from 'node:path'
import type { EffortSetting } from '@shared/types'

export interface AntigravityRunOptions {
  prompt: string
  /** null on the first turn of a conversation. */
  conversationId: string | null
  model: string | null
  effort: EffortSetting | null
  /** Permission-mode flags, produced by modes.ts in a later commit. Passed through verbatim. */
  modeArgs: string[]
  /** Extra working roots (/add-dir). Absolute paths only. */
  extraDirs?: string[]
}

/** 기본 5분은 코딩 턴을 완료하기에 너무 짧으므로 CLI 가 허용하는 장시간 상한을 명시한다. */
export const ANTIGRAVITY_PRINT_TIMEOUT = '24h'

export function antigravityArgs(opts: AntigravityRunOptions): string[] {
  // agy 에는 stdin·--prompt-file 입력이 없고 이를 요청한 upstream #525·#582도 열려 있다. Codex 는
  // argv 길이와 선행 대시 문제를 피해 stdin 을 쓰지만, 여기서는 -p argv 제한을 감수해야 한다.
  const args = ['-p', opts.prompt, '--output-format', 'stream-json']

  // 호출자가 ID를 정하는 옵션은 없으며(upstream #7), 첫 init 이벤트의 ID를 다음 실행부터 쓴다.
  if (opts.conversationId !== null) args.push('--conversation', opts.conversationId)
  if (opts.model !== null) args.push('--model', opts.model)
  const effort = antigravityEffort(opts.effort)
  if (effort) args.push('--effort', effort)
  args.push(...opts.modeArgs)

  for (const dir of opts.extraDirs ?? []) {
    // 상대 경로는 동작하지 않는다(upstream #598). 조용히 빼면 사용자가 허용했다고 믿는 루트가
    // 사라지므로, 잘못된 호출을 즉시 드러내는 예외를 택한다.
    if (!isAbsolute(dir)) throw new Error(`Antigravity --add-dir must be absolute: ${dir}`)
    args.push('--add-dir', dir)
  }
  args.push('--print-timeout', ANTIGRAVITY_PRINT_TIMEOUT)
  return args
}

/** agy 가 받는 세 단계 밖의 Wooi effort 는 가장 가까운 경계값으로 접는다. */
export function antigravityEffort(effort: EffortSetting | null): string | undefined {
  if (effort === null) return undefined
  if (effort === 'minimal' || effort === 'low') return 'low'
  if (effort === 'medium') return 'medium'
  return 'high'
}
