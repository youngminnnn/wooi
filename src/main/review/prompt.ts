import type { ReviewFileDiff, ReviewLayerDiff } from '@shared/types'
import { renderFileBody, renderFileHeader } from './diff'

/**
 * 프롬프트가 실제로 쓰는 레이어(= PR 1건) 정보. 저장된 리뷰 레코드에서 그대로 만들 수 있어야 한다.
 */
export interface ReviewPromptLayer {
  number: number
  title: string
  baseRefName: string
  headRefName: string
  headSha: string
  /** 이 레이어의 head 를 붙잡아 둔 로컬 ref. 에이전트가 직접 git 을 돌릴 때 쓴다. */
  localRef: string
  /** base 쪽 로컬 ref. 아래 레이어가 있으면 그 레이어의 localRef, 없으면 origin/<base>. */
  baseRef: string
}

export interface ReviewPromptMeta {
  /** 아래→위. 레이어가 하나면 단일 PR 리뷰다. */
  layers: ReviewPromptLayer[]
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

const TITLE = { type: 'string', description: 'One short line, 80 characters or fewer.' } as const

/**
 * 출력 스키마. **레이어 수에 따라 달라진다** — 스택일 때만 `prNumber` 를 인라인 지적의 필수
 * 필드로 올리고 `stack`·`layers` 를 요구한다. 단일 PR 리뷰에 없던 필드를 요구하면 모델이
 * 쓸 값이 없는 칸을 채우려 든다.
 */
export function reviewOutputSchema(layerCount: number): Record<string, unknown> {
  const stacked = layerCount > 1

  const inlineProps: Record<string, unknown> = {
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
    title: TITLE,
    body: {
      type: 'string',
      description:
        'Markdown. Posted verbatim as an inline comment. You may use a ```suggestion block.'
    }
  }
  const inlineRequired = ['file', 'side', 'line', 'severity', 'title', 'body']
  if (stacked) {
    inlineProps.prNumber = {
      type: 'integer',
      description:
        'The pull request whose diff contains this line — copy it from the [#n] tag on the file header. ' +
        'A comment on the wrong pull request is either rejected or, worse, silently posted in the wrong place.'
    }
    inlineRequired.unshift('prNumber')
  }

  const general = {
    type: 'array',
    description: 'Findings that do not map to a specific diff line.',
    items: {
      type: 'object',
      additionalProperties: false,
      required: stacked ? ['prNumber', 'severity', 'title', 'body'] : ['severity', 'title', 'body'],
      properties: {
        ...(stacked
          ? {
              prNumber: {
                type: 'integer',
                description: 'The pull request this finding is about.'
              }
            }
          : {}),
        severity: SEVERITY,
        title: TITLE,
        body: {
          type: 'string',
          description:
            'Markdown. Posted to GitHub verbatim as a PR comment, so write it as the finished comment.'
        }
      }
    }
  }

  const schema: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: stacked
      ? ['summary', 'general', 'inline', 'stack', 'layers']
      : ['summary', 'general', 'inline'],
    properties: {
      summary: {
        type: 'string',
        description: stacked
          ? 'A 3-6 sentence assessment of the stack as a whole — is it split correctly?'
          : 'A 2-5 sentence overall assessment of the PR.'
      },
      reply: {
        type: 'string',
        description:
          'Only for follow-up turns: your conversational answer to what the user just asked. Leave empty on the first review.'
      },
      general,
      inline: {
        type: 'array',
        description: 'Findings anchored to a specific line of the diff.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: inlineRequired,
          properties: inlineProps
        }
      }
    }
  }

  if (stacked) {
    const props = schema.properties as Record<string, unknown>
    props.stack = {
      type: 'array',
      description:
        'Findings about the stack itself — layer ordering, boundaries, granularity, churn. ' +
        'A finding that would read the same if this pull request were reviewed alone does NOT belong here.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['prNumbers', 'severity', 'title', 'body'],
        properties: {
          prNumbers: {
            type: 'array',
            items: { type: 'integer' },
            description:
              'Every pull request this finding is about, bottom first. It is posted on the lowest one.'
          },
          severity: SEVERITY,
          title: TITLE,
          body: {
            type: 'string',
            description:
              'Markdown, posted verbatim. Name the layers you mean and say what should move where.'
          }
        }
      }
    }
    props.layers = {
      type: 'array',
      description:
        'One short assessment per pull request. Used as the body of the review submitted to that pull request, so it must stand on its own.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['prNumber', 'summary'],
        properties: {
          prNumber: { type: 'integer' },
          summary: { type: 'string', description: '1-3 sentences about this layer alone.' }
        }
      }
    }
  }

  return schema
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

/**
 * 이어서 다시 돌릴 때의 프롬프트.
 *
 * 후속 턴과 같은 이유로 diff 를 다시 싣지 않는다 — resume 로 끊긴 대화를 그대로 이어받으므로
 * 모델은 이미 PR 도, 자기가 어디까지 봤는지도 알고 있다. 여기서 할 일은 "그 턴이 결과를 내기
 * 전에 끊겼다" 를 알리고 **이미 한 일을 다시 하지 말라**고 못 박는 것뿐이다.
 */
export function buildResumePrompt(userPrompt: string, context: string[]): string {
  const ctx = context.length
    ? `\n\n## What happened while you were stopped\n\n${context.join('\n\n')}\n`
    : ''
  return `Your previous turn was interrupted before it returned a result — it hit an error or a usage
limit, not a decision to stop. Pick up where you left off and finish that turn.

Do not redo work you already completed; re-read only what you had not gotten to. The review you
were asked for was:

${userPrompt.trim()}${ctx}

---

Return the finished review in the required JSON schema, exactly as if that turn had completed.
Write in the same language the user used.`
}

/**
 * diff 를 프롬프트에 싣는 총예산. 레이어 수가 아니라 **모델의 컨텍스트**가 희소 자원이므로
 * 스택이라고 늘리지 않는다.
 */
const MAX_DIFF_CHARS = 300_000

/** 레이어 하나에 최소한 보장하는 몫. 이게 없으면 큰 레이어가 작은 레이어를 통째로 밀어낸다. */
const MIN_LAYER_CHARS = 20_000

export interface BuildPromptArgs {
  userPrompt: string
  meta: ReviewPromptMeta
  diffs: ReviewLayerDiff[]
}

export interface BuiltPrompt {
  text: string
  /** 예산에 못 들어가 이름만 나열된 파일 수. 세션에 남겨 화면이 알린다. */
  truncatedFiles: number
}

/**
 * 사용자의 자유 프롬프트를 **맨 앞에** 두고 그 뒤에 형식 규약을 붙인다.
 *
 * 순서가 중요하다 — 사용자가 무엇을 원하는지가 리뷰의 주제를 정하고, 아래 규약은 그 결과를
 * 어떻게 돌려줄지만 정한다. 규약을 앞에 두면 모델이 형식에 끌려가 정작 요청을 흘린다.
 *
 * 레이어가 하나면 스택 관련 절은 통째로 빠진다. 그래서 프롬프트 빌더는 하나뿐이고, 흔한
 * 단일 PR 리뷰가 그 코드를 매일 검증해 준다.
 */
export function buildReviewPrompt({ userPrompt, meta, diffs }: BuildPromptArgs): BuiltPrompt {
  const stacked = meta.layers.length > 1
  const skeleton = renderSkeleton(meta, diffs)
  const budget = MAX_DIFF_CHARS - skeleton.length
  const { text: diffBlock, truncatedFiles } = renderBudgetedDiffs(meta, diffs, budget)

  const sections = [
    userPrompt.trim(),
    '',
    '---',
    '',
    '## Review context (added by Wooi)',
    '',
    stacked ? stackIntro(meta) : singleIntro(meta),
    '',
    skeleton,
    '',
    ...(stacked ? [STACK_QUESTIONS, ''] : []),
    anchorRules(stacked),
    '',
    outputRules(stacked),
    '',
    stacked ? '## Diffs, layer by layer' : '## PR diff',
    '',
    diffBlock
  ]
  return { text: sections.join('\n'), truncatedFiles }
}

function singleIntro(meta: ReviewPromptMeta): string {
  const l = meta.layers[0]
  return `You are reviewing GitHub pull request #${l.number}.

Your working directory is a **read-only checkout of this PR's head**. Read files, grep, and run
shell commands freely, but file-editing tools are blocked — report problems, don't fix them.
Running \`git diff ${l.baseRef}...${l.localRef}\` there reproduces this PR's diff.`
}

function stackIntro(meta: ReviewPromptMeta): string {
  const n = meta.layers.length
  return `You are reviewing a **stack of ${n} pull requests** as one unit — not ${n} separate reviews.
The layers are listed below, bottom first: each one is based on the layer beneath it, and they
merge in that order.

Your working directory is a **read-only checkout of the top of the stack**. Every layer's head is
also fetched as a local ref, so you can inspect any layer without switching branches:

  git diff <baseRef>...<headRef>          the diff of one layer
  git show <headRef>:<path>               a file as of that layer
  git log --oneline <baseRef>..<headRef>  that layer's commits

File-editing tools are blocked — report problems, don't fix them.`
}

/**
 * 스택 골격 — **항상 전부 싣는다.**
 *
 * 순서·독립성·중복 같은 스택 질문은 hunk 내용보다 "어느 레이어가 어느 파일을 건드리는가" 에서
 * 훨씬 많이 나온다. 그 표는 파일 수백 개짜리 스택에서도 몇 KB 라, 잘라 낼 이유가 없다.
 */
function renderSkeleton(meta: ReviewPromptMeta, diffs: ReviewLayerDiff[]): string {
  const out: string[] = ['## The stack']
  meta.layers.forEach((layer, i) => {
    const files = filesOf(diffs, layer.number)
    const adds = files.reduce((n, f) => n + f.additions, 0)
    const dels = files.reduce((n, f) => n + f.deletions, 0)
    out.push('')
    out.push(
      `### Layer ${i + 1} of ${meta.layers.length} — PR #${layer.number}: ${layer.title}`,
      `  base: ${layer.baseRefName}   head: ${layer.headRefName} (${layer.headSha.slice(0, 12)})`,
      `  refs: ${layer.baseRef}...${layer.localRef}`,
      `  ${files.length} file${files.length === 1 ? '' : 's'}, +${adds} −${dels}`
    )
    for (const f of files) {
      out.push(
        `    ${f.path}  (${f.status}, +${f.additions} −${f.deletions}${f.binary ? ', binary' : ''})`
      )
    }
  })

  if (meta.layers.length > 1) {
    const shared = crossLayerFiles(diffs)
    out.push('')
    out.push('### Files touched by more than one layer')
    if (shared.length === 0) {
      out.push('  (none — every file belongs to exactly one layer)')
    } else {
      out.push(
        '  These carry the churn question: did a later layer rewrite or revert what an earlier one did?'
      )
      for (const { path, prNumbers } of shared) {
        out.push(`    ${path}  —  ${prNumbers.map((n) => `#${n}`).join(', ')}`)
      }
    }
  }
  return out.join('\n')
}

/** 여러 레이어가 건드린 경로 → 그 레이어들(아래→위). */
export function crossLayerFiles(
  diffs: ReviewLayerDiff[]
): Array<{ path: string; prNumbers: number[] }> {
  const byPath = new Map<string, number[]>()
  for (const layer of diffs) {
    for (const f of layer.diff.files) {
      const list = byPath.get(f.path)
      if (list) list.push(layer.prNumber)
      else byPath.set(f.path, [layer.prNumber])
    }
  }
  return [...byPath.entries()]
    .filter(([, prNumbers]) => prNumbers.length > 1)
    .map(([path, prNumbers]) => ({ path, prNumbers }))
}

/**
 * 예산 안에서 diff 를 싣는다.
 *
 * 레이어마다 바닥(MIN_LAYER_CHARS)을 먼저 깔고 남은 몫을 크기에 비례해 나눈다. 레이어 안에서는
 * **여러 레이어가 건드린 파일을 먼저** 싣는다 — hunk 수준의 세부가 가장 필요한 것들이다.
 * 못 실은 파일은 이름을 남기고 읽는 방법을 알려 준다. 조용히 자르지 않는다.
 */
function renderBudgetedDiffs(
  meta: ReviewPromptMeta,
  diffs: ReviewLayerDiff[],
  budget: number
): { text: string; truncatedFiles: number } {
  const shared = new Set(crossLayerFiles(diffs).map((f) => f.path))
  const stacked = meta.layers.length > 1
  const shares = allocate(meta, diffs, Math.max(budget, MIN_LAYER_CHARS))

  const out: string[] = []
  let truncatedFiles = 0

  for (const layer of meta.layers) {
    const files = filesOf(diffs, layer.number)
    if (stacked) {
      out.push(`━━━ PR #${layer.number} — ${layer.title}`, '')
    }
    let left = shares.get(layer.number) ?? 0
    const skipped: string[] = []
    // 여러 레이어에 걸친 파일이 먼저. 그다음은 원래 순서(= diff 순서)를 지킨다.
    const ordered = [...files].sort((a, b) => rank(a, shared) - rank(b, shared))
    for (const file of ordered) {
      const chunk = [
        renderFileHeader(file, stacked ? layer.number : undefined),
        ...renderFileBody(file)
      ].join('\n')
      if (chunk.length > left) {
        skipped.push(file.path)
        truncatedFiles++
        continue
      }
      left -= chunk.length
      out.push(chunk)
    }
    if (skipped.length > 0) {
      out.push(
        `… ${skipped.length} file${skipped.length === 1 ? '' : 's'} of PR #${layer.number} did not fit in the prompt:`,
        ...skipped.map((p) => `    ${p}`),
        `Read them with \`git diff ${layer.baseRef}...${layer.localRef} -- <path>\`.`,
        `The same marker rules apply (RIGHT = new-file line, LEFT = old-file line).`,
        ''
      )
    }
  }
  return { text: out.join('\n'), truncatedFiles }
}

/** 여러 레이어가 건드린 파일이 먼저(0), 나머지는 뒤(1). 같은 등급 안에서는 원래 순서 유지. */
function rank(file: ReviewFileDiff, shared: Set<string>): number {
  return shared.has(file.path) ? 0 : 1
}

/** 레이어별 문자 예산. 바닥을 먼저 보장하고 남은 것을 크기에 비례해 나눈다. */
function allocate(
  meta: ReviewPromptMeta,
  diffs: ReviewLayerDiff[],
  budget: number
): Map<number, number> {
  const sizes = new Map<number, number>()
  for (const layer of meta.layers) {
    const files = filesOf(diffs, layer.number)
    sizes.set(
      layer.number,
      files.reduce((n, f) => n + f.additions + f.deletions + 1, 0)
    )
  }
  const out = new Map<number, number>()
  const floor = Math.min(MIN_LAYER_CHARS, Math.floor(budget / Math.max(meta.layers.length, 1)))
  const total = [...sizes.values()].reduce((a, b) => a + b, 0)
  const rest = Math.max(budget - floor * meta.layers.length, 0)
  for (const layer of meta.layers) {
    const share = total > 0 ? Math.floor((rest * (sizes.get(layer.number) ?? 0)) / total) : 0
    out.set(layer.number, floor + share)
  }
  return out
}

function filesOf(diffs: ReviewLayerDiff[], prNumber: number): ReviewFileDiff[] {
  return diffs.find((d) => d.prNumber === prNumber)?.diff.files ?? []
}

const STACK_QUESTIONS = `## What a stack review is for

These questions only exist at stack level, and reviewing each pull request on its own cannot
answer them. They are the point of this review — answer them before anything else:

  1. **Ordering.** Does a lower layer use a symbol, migration, config value, or dependency that a
     higher layer is the one to introduce? Then it cannot merge on its own and the order is wrong.
  2. **Independence.** Can a reviewer understand each layer without reading the layer above it?
  3. **Invalidation.** If you ask for a change in a lower layer, what above it has to move?
     Say so on the finding that asks for the change.
  4. **Granularity.** Should two layers be one, or one layer be two?
  5. **Churn.** Does a later layer revert, rewrite, or delete what an earlier layer added? That
     work should have been folded down.

Put answers to these in \`stack\`, not in \`general\`. A finding that would read exactly the same
if its pull request were reviewed alone is a normal finding — put it in \`inline\`/\`general\`.
Reviewing each layer's code is still worth doing, but it is not what this run is for.`

function anchorRules(stacked: boolean): string {
  const perPr = stacked
    ? `
Each file header carries the pull request it belongs to: \`=== [#13] src/main/store.ts\`.
**Copy that number into \`prNumber\`.** The same path and even the same line number can exist in
more than one layer, and a comment aimed at the wrong one is either rejected or — worse — quietly
posted on a different pull request.`
    : ''
  return `## How to anchor a finding to a line

Every line in the diff below is prefixed with a \`RIGHT:<n>\` or \`LEFT:<n>\` marker.
  - \`RIGHT:<n>\` → line n of the new file. Use side "RIGHT", line n.
  - \`LEFT:<n>\`  → line n of the old file. Use side "LEFT", line n.

**Copy the number from the marker. Do not count lines yourself.** You cannot comment on a line
that has no marker — GitHub rejects it. Put anything that doesn't narrow to a specific line in
\`general\` rather than \`inline\`.${perPr}`
}

function outputRules(stacked: boolean): string {
  const extra = stacked
    ? `
  - \`stack\` is where the stack-level answers go. Name the layers you mean.
  - \`layers\` needs one entry per pull request; each becomes the body of the review submitted to
    that pull request, so write it to stand on its own.`
    : ''
  return `## Output

When you're done investigating, return your findings in the required JSON schema. Rules:
  - \`body\` is posted to GitHub **verbatim**. Write it like a real review comment: what's wrong,
    why it matters, and how to fix it. No preamble like "I looked at this and…".
  - Don't invent problems. An empty \`inline\` array is a perfectly good answer.
  - A few high-signal findings beat many low-signal ones.
  - Use \`nit\` for taste-level points and \`praise\` sparingly.
  - Write in the same language the user used in their request above.${extra}`
}
