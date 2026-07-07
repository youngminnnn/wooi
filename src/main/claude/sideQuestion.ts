import { query } from '@anthropic-ai/claude-agent-sdk'
import type { SDKMessage, SDKUserMessage, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { resolveClaudeExecutable } from './executable'
import { MCP_SETTING_SOURCES } from './mcp'
import type { EffortSetting } from '@shared/types'

// session.ts 와 동일 — 패키징 빌드에서 app.asar 내부 경로로 CLI 를 spawn 해 ENOTDIR 로
// 실패하지 않도록 unpacked 바이너리 경로를 1회 계산해 둔다(dev 에서는 null → SDK 기본값).
const claudeExecutable = resolveClaudeExecutable()

/** 사이드 질문은 도구를 쓰지 않는다(Claude Code /btw 규약과 동일) — 모든 권한 요청을 거부한다. */
const denyAllTools = async (): Promise<PermissionResult> => ({
  behavior: 'deny',
  message: 'Side questions cannot use tools'
})

export interface SideQuestionOptions {
  cwd: string
  /** 맥락을 이어받을 현재 세션 ID. 없으면(대화 시작 전) 맥락 없이 답한다. */
  resumeSessionId: string | null
  model: string | null
  /** reasoning effort 선택값. null 이면 effort 옵션을 넘기지 않는다. */
  effort: EffortSetting | null
  question: string
  /** 답변 텍스트 조각을 받을 때마다 호출(스트리밍). */
  onDelta: (text: string) => void
}

/**
 * /btw 사이드 질문 1건을 처리한다.
 *
 * Claude Code TUI 의 /btw 는 SDK 공개 API(0.3.160)로 노출되지 않으므로, 같은 효과를
 * fork 세션으로 재현한다: 현재 세션을 resume + forkSession 으로 분기해 맥락은 이어받되,
 * 답변은 새 임시 세션에만 기록되어 메인 세션·트랜스크립트가 오염되지 않는다. maxTurns 1 +
 * 모든 도구 거부로 "도구 없이 지금 가진 정보로만 답한다" 는 사이드 질문 규약을 지킨다.
 * 별도 query 프로세스라 메인 작업이 도는 중에도 병렬로 실행된다.
 */
export async function askSideQuestion(opts: SideQuestionOptions): Promise<void> {
  const q = query({
    prompt: oneShot(opts.question),
    options: {
      cwd: opts.cwd,
      includePartialMessages: true,
      maxTurns: 1,
      allowedTools: [],
      canUseTool: denyAllTools,
      // 도구는 안 쓰지만(권한 전면 거부), CLAUDE.md·프로젝트 설정 맥락은 답변 품질에 도움이 된다.
      settingSources: MCP_SETTING_SOURCES,
      ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      // 사이드 질문은 도구·워크플로우를 쓰지 않으므로 ultracode 는 그 effort 성분(xhigh)으로만 환산한다.
      ...(opts.effort ? { effort: opts.effort === 'ultracode' ? 'xhigh' : opts.effort } : {}),
      // resume 한 세션에 답을 덧쓰면 메인 대화가 오염되므로, forkSession 으로 새 임시 세션에 분기한다.
      ...(opts.resumeSessionId ? { resume: opts.resumeSessionId, forkSession: true } : {})
    }
  })

  // 부분 메시지를 한 글자도 받지 못하는 환경을 대비해, 확정 assistant 메시지로 폴백한다.
  let streamed = false
  try {
    for await (const msg of q) {
      if (msg.type === 'stream_event') {
        const event = msg.event as { type: string; delta?: { type: string; text?: string } }
        if (
          event.type === 'content_block_delta' &&
          event.delta?.type === 'text_delta' &&
          event.delta.text
        ) {
          streamed = true
          opts.onDelta(event.delta.text)
        }
        continue
      }

      if (msg.type === 'assistant' && !streamed) {
        const text = assistantText(msg)
        if (text) {
          streamed = true
          opts.onDelta(text)
        }
        continue
      }

      if (msg.type === 'result') break
    }
  } finally {
    q.close()
  }
}

/** 질문 1개만 흘려보내고 입력을 닫는다 — query 가 1턴 처리 후 종료하도록. */
async function* oneShot(question: string): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content: question },
    parent_tool_use_id: null
  }
}

/** 확정 assistant 메시지에서 text 블록만 이어 붙인다. */
function assistantText(msg: Extract<SDKMessage, { type: 'assistant' }>): string {
  const content =
    (msg.message as unknown as { content?: Array<{ type: string; text?: string }> }).content ?? []
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
}
