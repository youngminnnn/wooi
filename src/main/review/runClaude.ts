import { randomUUID } from 'node:crypto'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionResult, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ReviewArtifact, ReviewProgressItem } from '@shared/types'
import { resolveClaudeExecutable } from '../claude/executable'
import { MCP_SETTING_SOURCES, resolveUserMcpServers } from '../claude/mcp'
import { claudeEffort } from '../claude/protocol'
import { log } from '../logger'
import { coerceArtifact, describeArg, extractFencedJson, truncate } from './artifact'
import { REVIEW_OUTPUT_SCHEMA } from './prompt'
import type { ReviewRunDeps, ReviewRunResult } from './run'

const claudeExecutable = resolveClaudeExecutable()

/**
 * 리뷰는 **읽기 전용**이다. 리뷰어가 코드를 고치기 시작하면 리뷰가 아니라 작업이 되고,
 * detached 워크트리에 한 수정은 어차피 어디에도 반영되지 않아 사용자만 헷갈린다.
 * 결과는 파일이 아니라 구조화 출력(outputFormat)으로 받으므로 쓰기 도구가 필요 없다.
 */
const WRITE_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'str_replace_based_edit_tool'
])

/** 폭주 방지. 정상적인 리뷰는 이보다 훨씬 적은 턴에 끝난다. */
const MAX_TURNS = 80

export async function runClaudeReview(
  deps: ReviewRunDeps,
  prompt: string
): Promise<ReviewRunResult> {
  const mcpServers = resolveUserMcpServers(deps.repoPath)
  // 'ultracode' 는 effort 레벨이 아니라 별도 모드다 — 리뷰에는 그 별도 경로가 없으므로 effort
  // 성분(xhigh)만 취한다. 나머지는 공용 변환을 그대로 쓴다(Codex 전용 'minimal' → 'low' 등).
  const effort = deps.effort === 'ultracode' ? 'xhigh' : claudeEffort(deps.effort)

  const q = query({
    prompt: oneShot(prompt),
    options: {
      cwd: deps.cwd,
      maxTurns: MAX_TURNS,
      // CLAUDE.md·스킬·프로젝트 설정을 CLI 와 동일하게 읽는다. 사용자가 "우리 팀 리뷰 스킬로
      // 리뷰해줘" 같은 프롬프트를 쓸 수 있어야 하므로 필수다.
      settingSources: MCP_SETTING_SOURCES,
      // 결과 형식을 CLI 가 강제하고 위반 시 스스로 재시도한다.
      outputFormat: { type: 'json_schema', schema: REVIEW_OUTPUT_SCHEMA },
      disallowedTools: [...WRITE_TOOLS],
      canUseTool: reviewPermission,
      abortController: deps.abort,
      ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
      ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
      ...(deps.model ? { model: deps.model } : {}),
      ...(effort ? { effort } : {}),
      ...(deps.resumeSessionId ? { resume: deps.resumeSessionId } : {})
    }
  })

  let rawText = ''
  let artifact: ReviewArtifact | null = null
  let sessionId: string | null = null
  let error: string | null = null

  try {
    for await (const msg of q) {
      if (msg.type === 'assistant') {
        for (const item of describeAssistant(msg)) deps.onProgress(item)
        rawText += assistantText(msg)
        continue
      }

      if (msg.type === 'result') {
        // 성공·실패 모두 세션 id 를 준다. 실패한 턴이라도 맥락은 남아 있어 이어 물을 수 있다.
        sessionId = msg.session_id
        if (msg.subtype === 'success') {
          rawText = msg.result || rawText
          artifact = coerceArtifact(msg.structured_output) ?? extractFencedJson(rawText)
          if (!artifact) {
            log.warn('review: no structured output — falling back to raw text')
          }
        } else {
          error = msg.errors?.join('\n') || `The review failed (${msg.subtype}).`
        }
        break
      }
    }
  } catch (err) {
    if (deps.abort.signal.aborted) {
      error = null
    } else {
      error = String(err)
      log.error('review: query failed', err)
    }
  } finally {
    q.close()
  }

  return { artifact, rawText, sessionId, error }
}

/**
 * 쓰기 도구만 막고 나머지는 전부 허용한다.
 *
 * 리뷰 모드에는 권한 프롬프트 UI 가 없어서, 물어보는 순간 세션이 조용히 멈춘다. 대상이
 * 버려도 되는 detached 워크트리라 읽기·검색·셸은 그냥 허용하는 편이 안전하고 실용적이다.
 */
const reviewPermission = async (
  toolName: string,
  input: Record<string, unknown>
): Promise<PermissionResult> => {
  if (WRITE_TOOLS.has(toolName)) {
    return { behavior: 'deny', message: 'PR review is read-only — you cannot modify code.' }
  }
  return { behavior: 'allow', updatedInput: input }
}

/** 프롬프트 하나만 흘려보내고 입력을 닫는다. */
async function* oneShot(prompt: string): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content: prompt },
    parent_tool_use_id: null
  }
}

// ── 진행 상황 매핑 ───────────────────────────────────────────────────────
// session.ts 의 매핑은 권한·트랜스크립트·컨텍스트 추적과 얽혀 있어 재사용하지 않는다.
// 리뷰 화면은 "지금 뭘 하고 있나" 만 보여주면 되므로 훨씬 얇게 만든다.

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

function describeAssistant(msg: Extract<SDKMessage, { type: 'assistant' }>): ReviewProgressItem[] {
  const out: ReviewProgressItem[] = []
  for (const b of blocksOf(msg)) {
    if (b.type === 'text' && b.text?.trim()) {
      out.push({ id: randomUUID(), kind: 'text', text: b.text.trim(), ts: Date.now() })
    } else if (b.type === 'tool_use' && b.name) {
      const detail = describeTool(b.input)
      out.push({
        id: randomUUID(),
        kind: 'tool',
        name: b.name,
        detail,
        text: detail ? `${b.name}  ${detail}` : b.name,
        ts: Date.now()
      })
    }
  }
  return out
}

/** 도구 인자를 한 줄로 요약한다. 인자 전체를 쏟아내면 진행 로그가 읽히지 않는다. */
function describeTool(input: Record<string, unknown> | undefined): string {
  const hint = describeArg(
    input?.file_path,
    input?.path,
    input?.pattern,
    input?.command,
    input?.description,
    input?.prompt
  )
  return hint ? truncate(hint) : ''
}
