import * as acp from '@agentclientprotocol/sdk'
import { randomUUID } from 'node:crypto'
import type { ReviewArtifact, ReviewProgressItem } from '@shared/types'
import {
  CopilotUnavailableError,
  READ_ONLY_TOOL_KINDS,
  allowPermission,
  describeAcpFailure,
  initializeAcp,
  isRecord,
  rejectPermission,
  spawnCopilotAcp
} from '../copilot/acp'
import { toolNameOf } from '../copilot/mapping'
import { log } from '../logger'
import { coerceArtifact, describeArg, extractFencedJson, truncate } from './artifact'
import { schemaFor, type BackendReviewResult, type ReviewRunDeps } from './run'

/**
 * GitHub Copilot 으로 리뷰를 돌린다.
 *
 * 워크스페이스가 쓰는 장수명 연결([[copilot/manager]])을 재사용하지 않고 **일회성 ACP 프로세스**
 * 를 띄운다. 그 연결은 워크스페이스 단위 승인·트랜스크립트와 얽혀 있는데 리뷰는 워크스페이스가
 * 없는 실행이라 그 기계장치가 통째로 걸리적거린다 — `runCodexReview` 가 app-server 대신
 * `codex exec` 를 쓰는 것과 같은 이유다.
 *
 * **claude/codex 경로보다 구조적으로 헐겁다.** 그 둘은 CLI 가 JSON 스키마를 강제하지만
 * (`outputFormat` · `--output-schema`) ACP 에는 그런 자리가 없다. 그래서 스키마를 프롬프트에
 * 실어 유도하고 펜스 파싱으로 회수한다. 못 건지면 rawText 폴백 — 세 백엔드 공통 계약이다.
 */

/** 스키마를 프롬프트 꼬리에 실어 "required JSON schema" 라는 지시에 실체를 준다. */
export function reviewPromptFor(deps: ReviewRunDeps, prompt: string): string {
  return `${prompt}

## Output format

Reply with a single fenced \`\`\`json block and nothing after it. Its contents must validate
against this JSON Schema:

\`\`\`json
${JSON.stringify(schemaFor(deps), null, 2)}
\`\`\``
}

export async function runCopilotReview(
  deps: ReviewRunDeps,
  prompt: string
): Promise<BackendReviewResult> {
  let handle
  try {
    handle = await spawnCopilotAcp(deps.cwd)
  } catch (err) {
    if (err instanceof CopilotUnavailableError) {
      return { artifact: null, rawText: '', sessionId: null, error: err.message }
    }
    throw err
  }

  const { proc, stream } = handle
  let sessionId: string | null = null
  /**
   * 프롬프트를 보낸 뒤부터 참. `session/load` 는 응답보다 먼저 **과거 대화를 재생**하므로
   * (실측) 그 청크를 결과에 섞으면 앞선 리뷰의 JSON 이 이번 답으로 둔갑한다.
   */
  let collecting = false
  const chunks: string[] = []
  let graceTimer: ReturnType<typeof setTimeout> | null = null

  try {
    await acp
      .client({ name: 'wooi-review' })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
        // 리뷰는 읽기 전용이다. 리뷰어가 코드를 고치기 시작하면 리뷰가 아니라 작업이 되고,
        // detached 워크트리에 한 수정은 어차피 어디에도 반영되지 않아 사용자만 헷갈린다.
        // 리뷰 화면에는 승인 UI 가 없으므로 여기서 즉시 판정한다 — 물어보면 세션이 조용히 멈춘다.
        const kind = ctx.params.toolCall.kind
        return kind && READ_ONLY_TOOL_KINDS.has(kind)
          ? allowPermission(ctx.params.options)
          : rejectPermission(ctx.params.options)
      })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        if (!collecting) return
        const update = ctx.params.update
        if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
          chunks.push(update.content.text)
          return
        }
        const item = reviewProgressFrom(update)
        if (item) deps.onProgress(item)
      })
      .connectWith(stream, async (ctx) => {
        await initializeAcp(ctx)
        const params: acp.NewSessionRequest = { cwd: deps.cwd, mcpServers: [] }
        if (deps.resumeSessionId) {
          sessionId = deps.resumeSessionId
          await ctx.request(acp.methods.agent.session.load, { sessionId, ...params })
        } else {
          sessionId = (await ctx.request(acp.methods.agent.session.new, params)).sessionId
        }

        const active = sessionId
        const cancel = (): void => {
          void ctx.notify(acp.methods.agent.session.cancel, { sessionId: active })
          // 정상 서버는 곧 턴을 끝낸다. 파이프가 망가진 경우에만 짧게 기다린 뒤 kill 한다.
          graceTimer = setTimeout(() => proc.kill('SIGTERM'), 1_500)
        }
        deps.abort.signal.addEventListener('abort', cancel, { once: true })
        if (deps.abort.signal.aborted) cancel()

        collecting = true
        try {
          await ctx.request(acp.methods.agent.session.prompt, {
            sessionId: active,
            prompt: [{ type: 'text', text: reviewPromptFor(deps, prompt) }]
          })
        } finally {
          collecting = false
          deps.abort.signal.removeEventListener('abort', cancel)
        }
      })
  } catch (err) {
    const rawText = chunks.join('')
    // 사용자가 끊은 것은 실패가 아니다 — 그때까지 받은 것만 들고 조용히 돌아간다.
    if (deps.abort.signal.aborted) return { artifact: null, rawText, sessionId, error: null }
    log.error('review: copilot ACP failed', err)
    return { artifact: null, rawText, sessionId, error: describeAcpFailure(err, handle.stderr()) }
  } finally {
    if (graceTimer) clearTimeout(graceTimer)
    handle.dispose()
  }

  const rawText = chunks.join('')
  const artifact = extractFencedJson(rawText) ?? parseWholeArtifact(rawText)
  if (!artifact) {
    log.warn('review: copilot produced no structured output — falling back to raw text')
  }
  return { artifact, rawText, sessionId, error: null }
}

/** 펜스를 잊고 JSON 만 낸 경우의 폴백. `extractFencedJson` 이 못 건진 뒤에만 시도한다. */
export function parseWholeArtifact(text: string): ReviewArtifact | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    return coerceArtifact(JSON.parse(trimmed))
  } catch {
    return null
  }
}

/**
 * 진행 항목 한 줄. Claude·Codex 쪽과 같은 어휘("도구 이름 + 인자 요약")로 맞춘다 — 화면은 세
 * 백엔드를 같은 도구 행으로 그리므로, 여기서 모양이 갈리면 리뷰만 딴 제품처럼 보인다.
 *
 * `tool_call` 만 본다 — `tool_call_update` 는 같은 호출에 대해 여러 번 오므로 함께 올리면
 * 진행 로그가 같은 줄로 도배된다(실측: 셸 하나에 3건).
 */
export function reviewProgressFrom(update: acp.SessionUpdate): ReviewProgressItem | null {
  if (update.sessionUpdate !== 'tool_call') return null
  const name = toolNameOf(update)
  const input = isRecord(update.rawInput) ? update.rawInput : {}
  const hint = describeArg(
    input.file_path,
    input.path,
    input.pattern,
    input.command,
    input.description,
    input.prompt
  )
  const detail = hint ? truncate(hint) : ''
  return {
    id: randomUUID(),
    kind: 'tool',
    name,
    detail,
    text: detail ? `${name}  ${detail}` : name,
    ts: Date.now()
  }
}
