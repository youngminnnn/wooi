import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReviewArtifact, ReviewProgressItem } from '@shared/types'
import { codexEffort, execCodex } from '../codex/exec'
import { detectCodex } from '../codex/executable'
import { log } from '../logger'
import { coerceArtifact, describeArg, extractFencedJson, truncate } from './artifact'
import { REVIEW_OUTPUT_SCHEMA } from './prompt'
import type { ReviewRunDeps, ReviewRunResult } from './run'

/**
 * Codex 로 리뷰를 돌린다.
 *
 * 워크스페이스가 쓰는 `codex app-server`(codex/host.ts)를 재사용하지 않고 `codex exec` 를
 * 직접 띄운다. app-server 는 **워크스페이스 하나당 스레드 하나**를 전제로 승인·전달·트랜스크립트
 * 지속과 얽혀 있는데, 리뷰는 워크스페이스가 없는 일회성 실행이라 그 기계장치가 통째로 걸리적거린다.
 * `codex exec` 는 정확히 이 용도(비대화형 1회 실행 + 구조화 출력)로 만들어진 진입점이다.
 */

/** codex 가 리뷰 중 무엇도 고치지 못하게 한다. Claude 쪽 쓰기 도구 차단과 같은 취지다. */
const SANDBOX = 'read-only'

export async function runCodexReview(
  deps: ReviewRunDeps,
  prompt: string
): Promise<ReviewRunResult> {
  const install = await detectCodex()
  if (!install.usable || !install.path) {
    return {
      artifact: null,
      rawText: '',
      sessionId: null,
      error: install.reason ?? 'The Codex CLI is not available.'
    }
  }

  // 스키마는 파일로만 넘길 수 있고, 최종 메시지도 파일로 받는 편이 가장 확실하다
  // (JSONL 의 마지막 agent_message 와 같은 내용이지만 파싱 실패 위험이 없다).
  const dir = await mkdtemp(join(tmpdir(), 'wooi-review-'))
  const schemaPath = join(dir, 'schema.json')
  const lastMessagePath = join(dir, 'last-message.txt')

  try {
    await writeFile(schemaPath, JSON.stringify(strictSchema(REVIEW_OUTPUT_SCHEMA)), 'utf8')

    // resume 는 -s/-C 를 받지 않는다(하위 명령이라 옵션 집합이 다르다) — 샌드박스는 -c 로 주고
    // 작업 디렉터리는 자식 프로세스의 cwd 로 정한다.
    const args = deps.resumeSessionId
      ? ['exec', 'resume', deps.resumeSessionId, '-c', `sandbox_mode="${SANDBOX}"`]
      : ['exec', '-s', SANDBOX]
    args.push('--json', '--output-schema', schemaPath, '-o', lastMessagePath)
    // 리뷰 워크트리는 git worktree 라 저장소 안이지만, 판정을 codex 에 맡길 이유가 없다.
    // 어차피 읽기 전용이라 저장소 밖이어도 위험하지 않다.
    args.push('--skip-git-repo-check')
    if (deps.model) args.push('-m', deps.model)
    const effort = codexEffort(deps.effort)
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`)
    // 프롬프트는 stdin 으로 — diff 를 통째로 실으므로 인자 길이 한계에 걸린다.
    args.push('-')

    const reader = createCodexReader(deps.onProgress)
    const outcome = await execCodex(install.path, args, prompt, deps, reader)
    const run = reader.out
    if (outcome.aborted)
      return { artifact: null, rawText: run.rawText, sessionId: run.threadId, error: null }
    if (outcome.error) run.error = outcome.error

    const artifact =
      (await readArtifactFile(lastMessagePath)) ??
      run.artifact ??
      extractFencedJson(run.rawText) ??
      null
    if (!artifact && !run.error) {
      log.warn('review: codex produced no structured output — falling back to raw text')
    }

    return {
      artifact,
      rawText: run.rawText,
      sessionId: run.threadId,
      // 결과가 남았으면 종료 코드가 어떻든 리뷰는 건진다. 아무것도 없을 때만 실패로 본다.
      error: artifact ? null : run.error
    }
  } catch (err) {
    log.error('review: codex exec failed', err)
    return { artifact: null, rawText: '', sessionId: null, error: String(err) }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * 스키마를 OpenAI 구조화 출력(strict)이 받아 주는 모양으로 좁힌다.
 *
 * codex 는 `--output-schema` 를 Responses API 의 strict json_schema 로 그대로 넘기는데,
 * strict 는 **properties 의 모든 키가 required 에 있어야** 한다. 선택 필드를 required 에서
 * 빼면 요청 자체가 400 으로 죽는다(실제로 `startLine` 에서 났다). 그래서 전부 required 로
 * 올리되 원래 선택이던 것은 타입에 `null` 을 더해 "안 낼 자유" 를 남긴다 — coerceArtifact 는
 * null 을 이미 없는 값으로 취급하므로 결과 해석은 그대로다.
 *
 * Claude 쪽 스키마는 건드리지 않는다. 이 제약은 codex 경로에만 있다.
 */
export function strictSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictSchema)
  if (!node || typeof node !== 'object') return node

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    out[key] = strictSchema(value)
  }

  const props = out.properties
  if (props && typeof props === 'object' && !Array.isArray(props)) {
    const bag = props as Record<string, unknown>
    const keys = Object.keys(bag)
    const required = new Set(Array.isArray(out.required) ? (out.required as string[]) : [])
    for (const key of keys) {
      if (required.has(key)) continue
      const prop = bag[key]
      if (prop && typeof prop === 'object' && !Array.isArray(prop)) {
        const p = prop as Record<string, unknown>
        p.type = withNull(p.type)
      }
    }
    out.required = keys
  }
  return out
}

function withNull(type: unknown): unknown {
  if (typeof type === 'string') return type === 'null' ? type : [type, 'null']
  if (Array.isArray(type)) return type.includes('null') ? type : [...type, 'null']
  // 타입을 안 적은 필드는 이미 무엇이든 받는다 — 손댈 것이 없다.
  return type
}

/** JSONL 스트림에서 읽어낸 것. 프로세스 종료 사유(중단·비정상 종료)는 execCodex 가 따로 준다. */
export interface CodexRun {
  rawText: string
  artifact: ReviewArtifact | null
  threadId: string | null
  error: string | null
}

// ── 이벤트 해석 ──────────────────────────────────────────────────────────
// `codex exec --json` 의 JSONL 스키마. 우리가 쓰는 필드만 옮겨 적는다.

/**
 * stdout 조각을 받아 JSONL 이벤트로 접는 리더.
 *
 * 스트림은 줄 경계로 잘려 오지 않는다 — 청크 중간에서 끊긴 JSON 을 그대로 파싱하면 이벤트가
 * 통째로 사라진다. 남은 조각을 물고 있다가 다음 청크와 이어 붙이는 책임이 여기 있다.
 */
export function createCodexReader(
  onProgress: (item: ReviewProgressItem) => void,
  /**
   * 최종 메시지를 리뷰 결과(ReviewArtifact)로 파싱할지. 리뷰는 `--output-schema` 로 JSON 을
   * 강제하므로 기본값이 true 다.
   *
   * **스키마 없이 돌리는 호출자는 반드시 false 를 준다.** coerceArtifact 는 `summary` 문자열만
   * 있어도 아티팩트로 인정하므로, 그냥 JSON 을 답으로 낸 실행에서 최종 메시지가 rawText 에
   * 들어가지 못하고 통째로 사라진다(위임 실행이 정확히 그 경우다).
   */
  options: { parseArtifacts?: boolean } = {}
): {
  out: CodexRun
  push: (chunk: string) => void
  end: () => void
} {
  const parseArtifacts = options.parseArtifacts ?? true
  const out: CodexRun = { rawText: '', artifact: null, threadId: null, error: null }
  const seen = new Set<string>()
  let buffer = ''

  const line = (text: string): void => {
    const trimmed = text.trim()
    if (!trimmed) return
    let event: CodexEvent
    try {
      event = JSON.parse(trimmed) as CodexEvent
    } catch {
      // JSONL 이 아닌 진단 출력. 버린다 — 실패 메시지는 stderr 로 온다.
      return
    }
    consume(event, out, seen, onProgress, parseArtifacts)
  }

  return {
    out,
    push: (chunk) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const l of lines) line(l)
    },
    end: () => {
      if (buffer) line(buffer)
      buffer = ''
    }
  }
}

interface CodexItem {
  id?: string
  type?: string
  text?: string
  command?: string
  path?: string
  query?: string
  tool?: string
  server?: string
  message?: string
  status?: string
}

interface CodexEvent {
  type?: string
  thread_id?: string
  item?: CodexItem
  message?: string
  error?: { message?: string } | string
}

function consume(
  event: CodexEvent,
  out: CodexRun,
  seen: Set<string>,
  onProgress: (item: ReviewProgressItem) => void,
  parseArtifacts: boolean
): void {
  switch (event.type) {
    case 'thread.started':
      // 후속 턴을 `codex exec resume <id>` 로 이어 붙이기 위한 유일한 열쇠다.
      if (event.thread_id) out.threadId = event.thread_id
      return

    case 'item.started':
    case 'item.completed': {
      const item = event.item
      if (!item) return
      if (item.type === 'agent_message') {
        // --output-schema 를 쓰면 모든 agent_message 가 JSON 이다. 파싱되면 결과로,
        // 안 되면 사용자에게 보여 줄 말로 취급한다.
        const text = item.text ?? ''
        const parsed = parseArtifacts ? parseArtifact(text) : null
        if (parsed) {
          out.artifact = parsed
          return
        }
        if (!text.trim() || !markSeen(seen, item)) return
        out.rawText += `${text}\n`
        onProgress({ id: randomUUID(), kind: 'text', text: text.trim(), ts: Date.now() })
        return
      }
      if (!markSeen(seen, item)) return
      const tool = describeItem(item)
      if (tool) {
        onProgress({
          id: randomUUID(),
          kind: 'tool',
          name: tool.name,
          detail: tool.detail,
          text: tool.detail ? `${tool.name}  ${tool.detail}` : tool.name,
          ts: Date.now()
        })
      }
      return
    }

    case 'turn.failed':
    case 'error': {
      const message = errorMessage(event)
      if (message) {
        out.error = message
        onProgress({ id: randomUUID(), kind: 'error', text: message, ts: Date.now() })
      }
      return
    }
  }
}

/**
 * 이 항목을 이미 보여 줬는지. 항목 하나가 started·completed 로 두 번 오므로 먼저 온 쪽만
 * 남긴다 — 오래 걸리는 명령도 시작하는 순간 화면에 뜨는 편이 낫다.
 */
function markSeen(seen: Set<string>, item: CodexItem): boolean {
  const id = item.id
  if (!id) return true
  if (seen.has(id)) return false
  seen.add(id)
  return true
}

function parseArtifact(text: string): ReviewArtifact | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    return coerceArtifact(JSON.parse(trimmed))
  } catch {
    return null
  }
}

/**
 * 진행 항목 한 줄. Claude 쪽과 같은 어휘("도구 이름 + 인자 요약")로 맞춘다 — 화면은 두
 * 백엔드를 같은 도구 행으로 그리므로, 여기서 모양이 갈리면 리뷰만 딴 제품처럼 보인다.
 * 도구 이름도 워크스페이스 대화의 Codex 매핑(WebSearch, server/tool)과 같은 것을 쓴다.
 */
function describeItem(item: CodexItem): { name: string; detail: string } | null {
  switch (item.type ?? 'work') {
    case 'command_execution':
      return { name: 'Bash', detail: truncate(item.command ?? '') }
    case 'file_change':
      return { name: 'Read', detail: truncate(item.path ?? 'a file') }
    case 'web_search':
      return { name: 'WebSearch', detail: truncate(item.query ?? '') }
    case 'mcp_tool_call':
      return { name: `${item.server ?? 'mcp'}/${item.tool ?? 'tool'}`, detail: '' }
    case 'error':
      return item.message ? { name: 'Error', detail: truncate(item.message) } : null
    // reasoning·todo_list 등은 굳이 진행 로그에 남기지 않는다 — 잡음만 늘린다.
    default:
      return null
  }
}

function errorMessage(event: CodexEvent): string | null {
  const fromError =
    typeof event.error === 'string' ? event.error : describeArg(event.error?.message, event.message)
  return fromError ? truncate(fromError, 400) : null
}

/**
 * `-o` 로 받은 최종 메시지. JSONL 을 놓치더라도 이 파일 하나면 결과를 복원할 수 있다.
 */
async function readArtifactFile(path: string): Promise<ReviewArtifact | null> {
  try {
    const text = await readFile(path, 'utf8')
    return parseArtifact(text) ?? extractFencedJson(text)
  } catch {
    return null
  }
}
