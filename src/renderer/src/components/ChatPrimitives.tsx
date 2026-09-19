import { useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import {
  AlertTriangle,
  ChartNoAxesCombined,
  Check,
  ChevronRight,
  Copy,
  FileText,
  Loader2,
  Wrench
} from 'lucide-react'

/**
 * 대화 한 줄기를 그리는 조각들.
 *
 * 워크스페이스 대화(MessageList)와 PR 리뷰(활동·진행 패널)가 **같은 컴포넌트**를 쓴다 —
 * 같은 에이전트가 같은 일을 하는데 화면마다 도구 로그와 말풍선의 모양이 다르면, 사용자는
 * 리뷰를 다른 제품처럼 느낀다. 형태를 한곳에 모아 두면 한쪽만 바뀌는 일이 없다.
 */

/** 내가 보낸 말. 오른쪽 말풍선. */
export function UserMessage({
  text,
  title,
  children
}: {
  text: string
  title?: string
  /** 본문 위에 얹을 것(첨부 칩 등). */
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex justify-end" title={title}>
      <div className="min-w-0 max-w-[85%] break-words bg-[var(--surface-4)] text-neutral-100 rounded-xl rounded-br-md px-3.5 py-2 text-base">
        {children}
        {text && <div className="whitespace-pre-wrap">{text}</div>}
      </div>
    </div>
  )
}

export type CodexFollowup = { label: string; prompt: string }
export type CodexFileCitation = { path: string }
export type CodexVisualization = { path: string; title?: string; mode?: 'wide' }

export type CodexMessageExtras = {
  body: string
  followups: CodexFollowup[]
  fileCitations: CodexFileCitation[]
  visualizations: CodexVisualization[]
}

/**
 * Codex가 Markdown 목록으로 내보내는 후속 행동을 본문과 분리한다.
 *
 * 목록 한 줄 전체여야만 인식한다. 그래서 인라인 코드, 일반 문장, 깨진 구문은 손대지 않고,
 * fenced/들여쓴 코드 블록도 Markdown의 코드 규칙대로 건너뛴다.
 */
export function extractCodexMessageExtras(text: string): CodexMessageExtras {
  const followups: CodexFollowup[] = []
  const fileCitations: CodexFileCitation[] = []
  const visualizations: CodexVisualization[] = []
  const parts = text.split(/(\r?\n)/)
  let fence: { marker: '`' | '~'; length: number } | undefined

  const body = parts
    .map((part) => {
      if (/^\r?\n$/.test(part)) return part

      const fenceMatch = part.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
      if (fenceMatch) {
        const marker = fenceMatch[1][0] as '`' | '~'
        if (!fence) fence = { marker, length: fenceMatch[1].length }
        else if (
          fence.marker === marker &&
          fenceMatch[1].length >= fence.length &&
          fenceMatch[2].trim() === ''
        )
          fence = undefined
        return part
      }
      if (fence) return part

      const match = part.match(
        /^ {0,3}[-+*]\s+:codex-followup\[([^\]\r\n]+)\]\{prompt=("(?:[^"\\]|\\.)*")\}\s*$/
      )
      if (match) {
        try {
          const prompt = JSON.parse(match[2])
          if (typeof prompt !== 'string') return part
          followups.push({ label: match[1], prompt })
          return ''
        } catch {
          return part
        }
      }

      const citationMatch = part.match(
        /^ {0,3}:codex-file-citation\{path=("(?:[^"\\]|\\.)*") purpose="output"\}\s*$/
      )
      if (citationMatch) {
        try {
          const path = JSON.parse(citationMatch[1])
          if (typeof path !== 'string') return part
          fileCitations.push({ path })
          return ''
        } catch {
          return part
        }
      }

      const visualizationMatch = part.match(/^ {0,3}visualize(\{.*\})\s*$/)
      if (!visualizationMatch) return part

      try {
        const value: unknown = JSON.parse(visualizationMatch[1])
        if (
          value === null ||
          Array.isArray(value) ||
          typeof value !== 'object' ||
          Object.keys(value).some((key) => key !== 'path' && key !== 'title' && key !== 'mode')
        ) {
          return part
        }
        const { path, title, mode } = value as Record<string, unknown>
        if (
          typeof path !== 'string' ||
          (title !== undefined && typeof title !== 'string') ||
          (mode !== undefined && mode !== 'wide')
        ) {
          return part
        }
        visualizations.push({
          path,
          ...(title === undefined ? {} : { title }),
          ...(mode === 'wide' ? { mode } : {})
        })
        return ''
      } catch {
        return part
      }
    })
    .join('')

  return { body, followups, fileCitations, visualizations }
}

/** @deprecated Use extractCodexMessageExtras when file citations are also needed. */
export function extractCodexFollowups(text: string): { body: string; followups: CodexFollowup[] } {
  const { body, followups } = extractCodexMessageExtras(text)
  return { body, followups }
}

function fileBasename(path: string): string {
  const segments = path.split(/[\\/]/)
  return segments.at(-1) || path
}

/** 에이전트가 한 말. 마크다운 + 마우스를 올리면 복사 버튼. */
export function AgentMessage({
  text,
  title,
  copyable = true,
  followups = [],
  fileCitations = [],
  visualizations = [],
  onOpenVisualization,
  onFollowup
}: {
  text: string
  title?: string
  copyable?: boolean
  /** 일반 워크스페이스 대화에서만 MessageList가 채워 준다. */
  followups?: readonly CodexFollowup[]
  /** 완료된 Codex 응답이 남긴 출력 파일. 경로는 title에서만 확인한다. */
  fileCitations?: readonly CodexFileCitation[]
  /** Codex가 만든 독립 HTML 시각화. 본문 HTML은 renderer에 넣지 않는다. */
  visualizations?: readonly CodexVisualization[]
  /** main이 검증한 안전한 hosted view로 여는 opaque action. */
  onOpenVisualization?: (visualization: CodexVisualization) => Promise<void>
  onFollowup?: (prompt: string) => Promise<void>
}): React.JSX.Element {
  const [sendingPrompt, setSendingPrompt] = useState<string>()
  const sendingRef = useRef(false)

  const sendFollowup = async (prompt: string) => {
    if (!onFollowup || sendingRef.current) return
    sendingRef.current = true
    setSendingPrompt(prompt)
    try {
      await onFollowup(prompt)
    } finally {
      sendingRef.current = false
      setSendingPrompt(undefined)
    }
  }

  return (
    <div className="group/msg relative md text-base text-neutral-200" title={title}>
      <MarkdownBody text={text} />
      {followups.length > 0 && onFollowup && (
        <div className="mt-3 flex flex-wrap gap-2" aria-label="Suggested follow-ups">
          {followups.map((followup, index) => {
            const sending = sendingPrompt === followup.prompt
            return (
              <button
                key={`${followup.label}:${followup.prompt}:${index}`}
                type="button"
                disabled={sendingPrompt !== undefined}
                onClick={() => void sendFollowup(followup.prompt)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-sm text-neutral-300 transition hover:border-[var(--border-strong)] hover:bg-[var(--surface-2)] disabled:cursor-wait disabled:opacity-60"
              >
                {sending && <Loader2 size={13} className="animate-spin" />}
                {sending ? 'Sending…' : followup.label}
              </button>
            )
          })}
        </div>
      )}
      {fileCitations.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2" aria-label="Output files">
          {fileCitations.map((citation, index) => (
            <span
              key={`${citation.path}:${index}`}
              title={citation.path}
              className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-sm text-neutral-300"
            >
              <FileText size={13} className="shrink-0 text-neutral-400" />
              <span className="truncate">{fileBasename(citation.path)}</span>
            </span>
          ))}
        </div>
      )}
      {visualizations.length > 0 && (
        <div className="mt-3 flex flex-col gap-2" aria-label="Visualizations">
          {visualizations.map((visualization, index) => (
            <CodexVisualizationCard
              key={`${visualization.path}:${index}`}
              visualization={visualization}
              onOpen={onOpenVisualization}
            />
          ))}
        </div>
      )}
      {/* focus-visible 이 아니라 focus-within 을 쓴다 — opacity-0 을 쥔 이 div 자체는
          포커스를 받지 않고, 안의 CopyButton 이 받는다. focus-visible 은 자기 자신이
          포커스일 때만 반응하므로 자식이 포커스여도 절대 켜지지 않는다. */}
      {copyable && text && (
        <div className="absolute -top-1 right-0 opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100 transition">
          <CopyButton text={text} />
        </div>
      )}
    </div>
  )
}

function CodexVisualizationCard({
  visualization,
  onOpen
}: {
  visualization: CodexVisualization
  onOpen?: (visualization: CodexVisualization) => Promise<void>
}): React.JSX.Element {
  const [opening, setOpening] = useState(false)
  const label = visualization.title || fileBasename(visualization.path) || 'Visualization'

  const open = async () => {
    if (!onOpen || opening) return
    setOpening(true)
    try {
      await onOpen(visualization)
    } finally {
      setOpening(false)
    }
  }

  return (
    <div
      className={`flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 ${
        visualization.mode === 'wide' ? 'w-full' : 'max-w-xl'
      }`}
      title={visualization.path}
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[var(--surface-3)] text-sky-300">
        <ChartNoAxesCombined size={17} aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-neutral-200">{label}</span>
        <span className="block text-xs text-neutral-500">Interactive visualization</span>
      </span>
      {onOpen ? (
        <button
          type="button"
          disabled={opening}
          onClick={() => void open()}
          className="shrink-0 rounded-lg border border-[var(--border-strong)] px-2.5 py-1.5 text-sm text-neutral-300 hover:bg-[var(--surface-2)] disabled:cursor-wait disabled:opacity-60"
        >
          {opening ? 'Opening…' : 'Open'}
        </button>
      ) : (
        <span className="shrink-0 text-xs text-neutral-500">Preview unavailable</span>
      )}
    </div>
  )
}

/**
 * Codex가 저장한 수식의 `\\(...\\)` / `\\[...\\]` 표기를 remark-math 표기로 맞춘다.
 *
 * Markdown의 코드 영역은 그대로 둔다. 특히 사용자가 프롬프트에 수식 문법을 예시로 쓴
 * 경우까지 렌더링하면 복사할 원문을 잃기 때문이다.
 */
function normalizeLatexDelimiters(text: string): string {
  const replaceLatex = (source: string): string =>
    source
      .replace(/\\{1,2}\[([\s\S]*?)\\{1,2}\]/g, (_, math: string) => `$$${math}$$`)
      .replace(/\\{1,2}\(([\s\S]*?)\\{1,2}\)/g, (_, math: string) => `$${math}$`)

  const normalizeText = (source: string): string => {
    let result = ''
    let cursor = 0

    while (cursor < source.length) {
      const opening = source.indexOf('`', cursor)
      if (opening === -1) {
        result += replaceLatex(source.slice(cursor))
        break
      }

      result += replaceLatex(source.slice(cursor, opening))

      const marker = source.slice(opening).match(/^`+/)?.[0]
      if (!marker) break
      const closing = source.indexOf(marker, opening + marker.length)
      if (closing === -1) {
        result += source.slice(opening)
        break
      }
      result += source.slice(opening, closing + marker.length)
      cursor = closing + marker.length
    }

    return result
  }

  let result = ''
  let prose = ''
  let fence: '`' | '~' | undefined

  for (const line of text.split(/(?<=\n)/)) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as '`' | '~'
      const openingFence = !fence
      if (!fence) {
        result += normalizeText(prose)
        prose = ''
        fence = marker
      }
      result += line
      if (!openingFence && fence === marker) fence = undefined
      continue
    }

    if (fence) result += line
    else prose += line
  }

  return result + normalizeText(prose)
}

/** 마크다운 본문만. 링크는 기본 브라우저로, 코드 블록에는 복사 버튼이 붙는다. */
export function MarkdownBody({ text }: { text: string }): React.JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeHighlight, rehypeKatex]}
      components={{ a: ExternalLinkRenderer, pre: PreWithCopy }}
    >
      {normalizeLatexDelimiters(text)}
    </ReactMarkdown>
  )
}

/**
 * 도구 호출 한 줄. 이름 + 인자 요약을 한 줄로 접어 두고, 펼칠 것이 있을 때만 셰브런을 준다.
 */
export function ToolUseRow({
  name,
  summary,
  pending,
  trailing,
  details,
  children
}: {
  name: string
  /** 인자 한 줄 요약(파일 경로·명령어 등). */
  summary?: string
  /** 아직 결과가 오지 않았다 — 스피너로 바꾼다. */
  pending?: boolean
  /** 이름 오른쪽에 붙는 것(변경 줄 수 등). */
  trailing?: React.ReactNode
  /** 셰브런으로 펼쳤을 때 보일 것(원시 입력 등). 없으면 셰브런도 없다. */
  details?: React.ReactNode
  /** 접지 않고 항상 보일 것(파일 변경 diff 등). */
  children?: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const Row = details ? 'button' : 'div'
  return (
    <div className="text-sm">
      <Row
        {...(details ? { onClick: () => setOpen((v) => !v), type: 'button' as const } : {})}
        className={
          'flex items-center gap-1.5 text-neutral-400 w-full text-left ' +
          (details ? 'hover:text-neutral-200' : '')
        }
      >
        {pending ? (
          <Loader2 size={12} className="text-[var(--warning-500)]/80 shrink-0 animate-spin" />
        ) : (
          <Wrench size={12} className="text-[var(--warning-500)]/80 shrink-0" />
        )}
        <span className="font-medium text-neutral-300 shrink-0">{name}</span>
        {summary && <span className="text-neutral-500 truncate">{summary}</span>}
        {trailing}
        {details && (
          <ChevronRight
            size={12}
            className={(open ? 'rotate-90 ' : '') + 'ml-auto shrink-0 transition'}
          />
        )}
      </Row>
      {children}
      {open && details}
    </div>
  )
}

/** 실패 한 줄. 대화 흐름 안에서 눈에 띄되 흐름을 끊지 않는 정도로. */
export function ErrorRow({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 text-sm text-[var(--danger-400)] bg-[var(--danger-500)]/10 border border-[var(--danger-500)]/20 rounded-lg px-3 py-2">
      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
      <span className="whitespace-pre-wrap break-words">{text}</span>
    </div>
  )
}

/** 클립보드 복사 버튼(체크 표시로 피드백). */
export function CopyButton({
  text,
  className
}: {
  text: string
  className?: string
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }
  return (
    <button
      onClick={copy}
      title="Copy"
      className={
        'h-6 w-6 grid place-items-center rounded-md bg-[var(--surface-2)]/80 text-neutral-400 hover:text-neutral-100 ' +
        (className ?? '')
      }
    >
      {copied ? <Check size={12} className="text-[var(--success-400)]" /> : <Copy size={12} />}
    </button>
  )
}

/** 코드 블록에 복사 버튼을 얹는다. */
export function PreWithCopy({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="group/code relative">
      {/* 위 CopyButton(메시지 헤더)와 같은 이유로 focus-within 을 쓴다 — 이 div 는 포커스를
          받지 않고, 안의 CopyButton 이 받는다. */}
      <div className="absolute top-1.5 right-1.5 opacity-0 group-hover/code:opacity-100 focus-within:opacity-100 transition">
        <CopyButton text={extractText(children)} />
      </div>
      <pre>{children}</pre>
    </div>
  )
}

/** 채팅 메시지 안의 링크는 항상 사용자의 기본 브라우저로 연다(앱 내 이동 방지). */
export function ExternalLinkRenderer({
  href,
  children
}: {
  href?: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault()
        if (href) void window.api.openExternal(href)
      }}
    >
      {children}
    </a>
  )
}

/** React 노드 트리에서 텍스트만 모은다(코드 복사용). */
function extractText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (typeof node === 'object' && 'props' in node) {
    return extractText((node as { props: { children?: React.ReactNode } }).props.children)
  }
  return ''
}
