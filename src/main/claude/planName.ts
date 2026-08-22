import { query } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionDecision, Workspace } from '@shared/types'
import { normalizeWorkspaceName } from '@shared/types'
import { log } from '../logger'
import { resolveClaudeExecutable } from './executable'

const MODEL = 'claude-haiku-4-5-20251001'
const TIMEOUT_MS = 8_000
const SYSTEM_PROMPT =
  'Return only a 2-6 word title for the described work. Use the same language as the plan.\n' +
  'Do not add quotes or punctuation at the end.'

// 패키징 빌드에서 app.asar 안의 CLI 를 spawn 하지 않도록 검증된 executable 해석을 그대로 쓴다.
const claudeExecutable = resolveClaudeExecutable()

/** 모델 호출 없이도 계획에서 안정적으로 얻을 수 있는 이름. */
export function nameFromPlanText(plan: string): string | null {
  let inFence = false
  let firstPlainLine: string | null = null

  for (const rawLine of plan.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence || !line) continue

    const heading = line.match(/^#{1,6}\s+(.+)$/)
    if (heading) return normalizeWorkspaceName(heading[1])
    if (firstPlainLine === null) firstPlainLine = line
  }

  if (!firstPlainLine) return null
  const sentence = firstPlainLine.match(/^.*?[.!?。！？](?:\s|$)/)?.[0] ?? firstPlainLine
  return normalizeWorkspaceName(sentence.trim().replace(/[.!?。！？]+$/, ''))
}

/**
 * 계획 승인 이름을 붙여도 되는가. 각 조건을 한 판정에 모아 두어, 두 번째 계획이나 사람이 붙인
 * 이름을 비동기 결과가 뒤늦게 덮는 일을 막는다.
 */
export function shouldAutoName(
  workspace: Pick<Workspace, 'displayName' | 'autoName' | 'prNumber'>,
  decision: PermissionDecision
): boolean {
  return (
    decision.behavior === 'allow' &&
    !workspace.displayName?.trim() &&
    !workspace.autoName?.trim() &&
    workspace.prNumber == null
  )
}

/** 계획 본문만으로 짧은 이름을 묻고, 어떤 실패든 순수 폴백으로 접는다. */
export async function nameFromPlan(opts: { plan: string; cwd: string }): Promise<string | null> {
  const fallback = nameFromPlanText(opts.plan)
  if (!fallback && !opts.plan.trim()) return null

  // 전체 대화를 fork 하지 않는다. 제목에 필요한 맥락은 계획 본문이 전부라, 다섯 단어를 위해
  // 대화를 재생하면 지연과 토큰만 늘어난다. Claude Code preset 도 약 11K자의 행동 지침이라 이
  // 단일 분류에는 순수 오버헤드이므로 짧은 전용 system prompt 를 쓴다([[claude/sideQuestion]]).
  for (const model of [MODEL, null] as const) {
    const abortController = new AbortController()
    const timeout = setTimeout(() => abortController.abort(), TIMEOUT_MS)
    try {
      const generated = await queryOnce(opts, model, abortController)
      const normalized = normalizeWorkspaceName(generated)
      if (normalized) return normalized
    } catch (error) {
      log.info(
        `plan name: side query failed${model ? ` (${model})` : ' (default model)'} — ${String(error)}`
      )
      // 지정 id 가 계정에서 해석되지 않을 수 있어 한 번만 기본 모델로 재시도한다. 둘 다 실패해도
      // 계획 승인은 이미 끝났고, 이름 품질만 낮춰 순수 폴백으로 마감한다.
    } finally {
      clearTimeout(timeout)
    }
  }
  return fallback
}

async function queryOnce(
  opts: { plan: string; cwd: string },
  model: string | null,
  abortController: AbortController
): Promise<string | null> {
  const q = query({
    prompt: `Name this plan:\n\n${opts.plan}`,
    options: {
      cwd: opts.cwd,
      systemPrompt: SYSTEM_PROMPT,
      maxTurns: 1,
      // 제한 시간이 지나면 호출자 Promise 만 버리지 않고 SDK 자식 프로세스까지 실제로 끊는다.
      abortController,
      allowedTools: [],
      canUseTool: async () => ({
        behavior: 'deny',
        message: 'Workspace naming cannot use tools'
      }),
      ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
      ...(model ? { model } : {})
    }
  })

  let answer: string | null = null
  try {
    for await (const msg of q) {
      if (msg.type !== 'assistant') continue
      const content = (msg.message as { content?: Array<{ type: string; text?: string }> }).content
      const text = content
        ?.filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('')
      if (text) answer = text
    }
    // 인증 오류도 assistant 텍스트를 먼저 내보낸 뒤 result 에서 실패한다. 스트림이 정상 종료한 뒤에만
    // 답을 채택해야 "Not logged in" 같은 오류 문구가 워크스페이스 이름으로 저장되지 않는다.
    return answer
  } finally {
    q.close()
  }
}
