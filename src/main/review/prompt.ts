import type { ReviewDiff } from '@shared/types'
import { renderNumberedDiff } from './diff'

/** 프롬프트가 실제로 쓰는 PR 정보만. 저장된 리뷰 레코드에서 그대로 만들 수 있어야 한다. */
export interface ReviewPromptMeta {
  number: number
  title: string
  baseRefName: string
  headSha: string
}

/**
 * 리뷰 결과를 기계가 읽을 수 있는 모양으로 받아내기 위한 계약.
 *
 * SDK 의 `outputFormat: { type: 'json_schema' }` 로 넘기면 CLI 가 스키마 위반을 스스로
 * 재시도해 준다(실패가 누적되면 result.subtype 이 error_max_structured_output_retries).
 * 덕분에 "JSON 으로 답해줘" 라고 부탁하고 파싱이 깨지길 기도하는 방식보다 훨씬 안정적이다.
 *
 * 의도적으로 nullable union(["integer","null"])을 쓰지 않는다 — 일부 스키마 강제 구현이
 * 거부한다. 선택 필드는 그냥 required 에서 빼는 것으로 표현한다.
 */
const SEVERITY = {
  type: 'string',
  enum: ['blocker', 'major', 'minor', 'nit', 'question', 'praise']
} as const

export const REVIEW_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'general', 'inline'],
  properties: {
    summary: {
      type: 'string',
      description: 'A 2-5 sentence overall assessment of the PR.'
    },
    reply: {
      type: 'string',
      description:
        'Only for follow-up turns: your conversational answer to what the user just asked. Leave empty on the first review.'
    },
    general: {
      type: 'array',
      description: 'Findings that do not map to a specific diff line.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'title', 'body'],
        properties: {
          severity: SEVERITY,
          title: { type: 'string', description: 'One short line, 80 characters or fewer.' },
          body: {
            type: 'string',
            description:
              'Markdown. Posted to GitHub verbatim as a PR comment, so write it as the finished comment.'
          }
        }
      }
    },
    inline: {
      type: 'array',
      description: 'Findings anchored to a specific line of the diff.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'side', 'line', 'severity', 'title', 'body'],
        properties: {
          file: { type: 'string', description: 'The path exactly as shown in the diff.' },
          side: {
            type: 'string',
            enum: ['RIGHT', 'LEFT'],
            description: 'RIGHT = the new file, LEFT = the old file.'
          },
          line: {
            type: 'integer',
            description:
              'Copy the number from the RIGHT:<n> / LEFT:<n> marker on the target line of the diff below.'
          },
          startLine: {
            type: 'integer',
            description:
              'First line of a multi-line finding. Must be less than line and on the same side.'
          },
          severity: SEVERITY,
          title: { type: 'string', description: 'One short line, 80 characters or fewer.' },
          body: {
            type: 'string',
            description:
              'Markdown. Posted verbatim as an inline comment. You may use a ```suggestion block.'
          }
        }
      }
    }
  }
}

/**
 * 후속 턴 프롬프트.
 *
 * diff 나 규약을 다시 싣지 않는다 — resume 로 앞선 대화를 그대로 이어받으므로 모델은 이미
 * PR 과 자기 지적을 알고 있다. 다시 붙이면 컨텍스트만 태우고 오히려 앞선 판단을 흔든다.
 */
export function buildFollowUpPrompt(userText: string, context: string[]): string {
  const ctx = context.length
    ? `\n\n## What happened since your review\n\n${context.join('\n\n')}\n`
    : ''
  return `${userText.trim()}${ctx}

---

Answer in the \`reply\` field of the required JSON schema. If — and only if — this turn produces
genuinely new findings worth posting, add them to \`inline\`/\`general\`; they are **appended** to
your earlier findings, so do not repeat ones you already reported. Leave \`summary\` empty unless
the overall assessment actually changed. Write in the same language the user used.`
}

/** diff 를 프롬프트에 통째로 싣되, 지나치게 큰 PR 에서 컨텍스트를 태우지 않도록 자른다. */
const MAX_DIFF_CHARS = 300_000

export interface BuildPromptArgs {
  userPrompt: string
  meta: ReviewPromptMeta
  diff: ReviewDiff
}

/**
 * 사용자의 자유 프롬프트를 **맨 앞에** 두고 그 뒤에 형식 규약을 붙인다.
 *
 * 순서가 중요하다 — 사용자가 무엇을 원하는지가 리뷰의 주제를 정하고, 아래 규약은 그 결과를
 * 어떻게 돌려줄지만 정한다. 규약을 앞에 두면 모델이 형식에 끌려가 정작 요청을 흘린다.
 */
export function buildReviewPrompt({ userPrompt, meta, diff }: BuildPromptArgs): string {
  const rendered = renderNumberedDiff(diff)
  const diffBlock =
    rendered.length > MAX_DIFF_CHARS
      ? rendered.slice(0, MAX_DIFF_CHARS) +
        `\n\n… diff truncated. Read the rest from your working directory with ` +
        `\`git diff ${meta.baseRefName}...HEAD -- <path>\`. ` +
        `The same line-marker rules apply (RIGHT = new-file line, LEFT = old-file line).`
      : rendered

  return `${userPrompt.trim()}

---

## Review context (added by Wooi)

You are reviewing GitHub pull request #${meta.number}.
  Title: ${meta.title}
  Base:  ${meta.baseRefName}
  Head:  ${meta.headSha.slice(0, 12)}

Your working directory is a **read-only checkout of this PR's head**. Read files, grep, and run
shell commands freely, but file-editing tools are blocked — report problems, don't fix them.
Running \`git diff ${meta.baseRefName}...HEAD\` there reproduces this PR's diff.

## How to anchor a finding to a line

Every line in the diff below is prefixed with a \`RIGHT:<n>\` or \`LEFT:<n>\` marker.
  - \`RIGHT:<n>\` → line n of the new file. Use side "RIGHT", line n.
  - \`LEFT:<n>\`  → line n of the old file. Use side "LEFT", line n.

**Copy the number from the marker. Do not count lines yourself.** You cannot comment on a line
that has no marker — GitHub rejects it. Put anything that doesn't narrow to a specific line in
\`general\` rather than \`inline\`.

## Output

When you're done investigating, return your findings in the required JSON schema. Rules:
  - \`body\` is posted to GitHub **verbatim**. Write it like a real review comment: what's wrong,
    why it matters, and how to fix it. No preamble like "I looked at this and…".
  - Don't invent problems. An empty \`inline\` array is a perfectly good answer.
  - A few high-signal findings beat many low-signal ones.
  - Use \`nit\` for taste-level points and \`praise\` sparingly.
  - Write in the same language the user used in their request above.

## PR diff

${diffBlock}
`
}
