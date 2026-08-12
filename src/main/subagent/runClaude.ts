import { query } from '@anthropic-ai/claude-agent-sdk'
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { resolveClaudeExecutable } from '../claude/executable'
import { MCP_SETTING_SOURCES, resolveUserMcpServers } from '../claude/mcp'
import { claudeEffort, claudeMode } from '../claude/protocol'
import { CLAUDE_CODE_SYSTEM_PROMPT } from '../claude/systemPrompt'
import { log } from '../logger'
import { wooiMcpSettings } from '../mcpSettings'
import { describeArg, truncate } from '../review/artifact'
import type { SubAgentActivity, SubAgentPermission, SubAgentRunDeps, SubAgentResult } from './run'

const claudeExecutable = resolveClaudeExecutable()

/**
 * 폭주 방지. 위임받은 작업 하나가 이 턴 수를 넘길 일은 없고, 넘긴다면 프롬프트가 잘못된 것이다.
 * 부모 세션에는 이런 상한이 없다 — 거기는 사용자가 보고 있으니 스스로 끊을 수 있다.
 */
const MAX_TURNS = 120

/**
 * Claude 로 위임 작업을 돌린다.
 *
 * 부모 세션(claude/session.ts)의 Query 를 재사용하지 않고 **별도 query 를 연다**. 부모 Query 는
 * 하나의 대화 맥락이라, 거기에 밀어 넣으면 위임이 아니라 그냥 부모가 더 일하는 것이 된다. 리뷰
 * (review/runClaude.ts)가 같은 이유로 같은 선택을 했다.
 *
 * 리뷰와 다른 점은 둘이다: 결과를 구조화 출력이 아니라 **자유 텍스트**로 받고(위임의 답은
 * 형식이 정해져 있지 않다), 권한은 호출부의 askSubAgentPermission 브리지로 부모 워크스페이스에
 * 매번 묻는다. fullAccess 만 즉시 통과하며 저장 규칙·auto 모드는 이 경로에 적용되지 않는다.
 */
export async function runClaudeSubAgent(deps: SubAgentRunDeps): Promise<SubAgentResult> {
  // 위임 실행은 메인 프로세스에서 돈다(호스트는 toolCall 로 메인에 넘긴다) — store 를 읽어도 된다.
  const mcpServers = resolveUserMcpServers(deps.repoPath, wooiMcpSettings())
  // 'ultracode' 는 effort 레벨이 아니라 별도 모드다. 위임 실행에 그 모드를 통째로 켜면 서브런이
  // 또 워크플로우를 조율하기 시작하므로, effort 성분(xhigh)만 취한다.
  const effort = deps.effort === 'ultracode' ? 'xhigh' : claudeEffort(deps.effort)

  const q = query({
    prompt: oneShot(deps.prompt),
    options: {
      cwd: deps.cwd,
      maxTurns: MAX_TURNS,
      // 부모 세션과 같은 시스템 프롬프트·설정 소스를 쓴다. 위임받은 쪽만 CLAUDE.md 를 모르면
      // 같은 저장소에서 다른 규칙으로 일하게 된다.
      systemPrompt: CLAUDE_CODE_SYSTEM_PROMPT,
      settingSources: MCP_SETTING_SOURCES,
      permissionMode: claudeMode(deps.permissionMode),
      canUseTool: permissionBridge(deps),
      abortController: deps.abort,
      ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
      ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
      ...(deps.model ? { model: deps.model } : {}),
      ...(effort ? { effort } : {})
    }
  })

  let text = ''
  let sessionId: string | null = null
  let error: string | null = null

  try {
    for await (const msg of q) {
      if (msg.type === 'assistant') {
        for (const activity of describeAssistant(msg)) deps.onActivity(activity)
        text += assistantText(msg)
        continue
      }
      if (msg.type === 'result') {
        sessionId = msg.session_id
        if (msg.subtype === 'success') {
          // result 의 최종 텍스트가 정본이다. 스트리밍으로 모은 것은 중간 발화까지 섞여 있다.
          text = msg.result || text
        } else {
          error = msg.errors?.join('\n') || `The delegated run failed (${msg.subtype}).`
        }
      }
    }
  } catch (err) {
    // 중단은 실패가 아니다 — 부모 턴이 인터럽트된 것이므로 조용히 지금까지의 텍스트만 돌려준다.
    if (deps.abort.signal.aborted) {
      error = null
    } else {
      error = String(err)
      log.error('subagent: claude query failed', err)
    }
  } finally {
    q.close()
  }

  return { text, sessionId, error }
}

/**
 * 승인 콜백이 없으면 막지 않고 통과시킨다 — 물어볼 곳이 없는데 물어보면 서브런이 조용히 멈춘다.
 * 이 경로는 권한 모드가 이미 부모에게서 내려온 값이라 그것만으로도 범위가 좁다.
 */
function permissionBridge(deps: SubAgentRunDeps): SubAgentPermission {
  return (
    deps.canUseTool ?? (async (_toolName, input) => ({ behavior: 'allow', updatedInput: input }))
  )
}

/** 프롬프트 하나만 흘려보내고 입력을 닫는다. 위임은 정의상 한 번의 요청이다. */
async function* oneShot(prompt: string): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content: prompt },
    parent_tool_use_id: null
  }
}

// ── 진행 상황 매핑 ───────────────────────────────────────────────────────
// review/runClaude.ts 와 같은 얕은 매핑이다. 여기서 필요한 것은 "지금 무슨 도구를 쓰고 있나"
// 한 줄뿐이라, 부모 세션의 매핑(권한·트랜스크립트·컨텍스트 추적과 얽힌)을 끌어오지 않는다.

interface AssistantBlock {
  type: string
  text?: string
  name?: string
  input?: Record<string, unknown>
}

function blocksOf(msg: Extract<SDKMessage, { type: 'assistant' }>): AssistantBlock[] {
  return (msg.message as unknown as { content?: AssistantBlock[] }).content ?? []
}

function assistantText(msg: Extract<SDKMessage, { type: 'assistant' }>): string {
  return blocksOf(msg)
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
}

function describeAssistant(msg: Extract<SDKMessage, { type: 'assistant' }>): SubAgentActivity[] {
  const out: SubAgentActivity[] = []
  for (const b of blocksOf(msg)) {
    if (b.type === 'text' && b.text?.trim()) {
      out.push({ kind: 'text', text: truncate(b.text.trim()) })
    } else if (b.type === 'tool_use' && b.name) {
      const hint = describeArg(
        b.input?.file_path,
        b.input?.path,
        b.input?.pattern,
        b.input?.command,
        b.input?.description,
        b.input?.prompt
      )
      out.push({
        kind: 'tool',
        toolName: b.name,
        text: hint ? `${b.name}  ${truncate(hint)}` : b.name
      })
    }
  }
  return out
}
