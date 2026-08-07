import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { AlertTriangle, Check, ChevronRight, Copy, Loader2, Wrench } from 'lucide-react'

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
      <div className="max-w-[85%] bg-[var(--surface-4)] text-neutral-100 rounded-2xl rounded-br-md px-3.5 py-2 text-base">
        {children}
        {text && <div className="whitespace-pre-wrap">{text}</div>}
      </div>
    </div>
  )
}

/** 에이전트가 한 말. 마크다운 + 마우스를 올리면 복사 버튼. */
export function AgentMessage({
  text,
  title,
  copyable = true
}: {
  text: string
  title?: string
  copyable?: boolean
}): React.JSX.Element {
  return (
    <div className="group/msg relative md text-base text-neutral-200" title={title}>
      <MarkdownBody text={text} />
      {copyable && text && (
        <div className="absolute -top-1 right-0 opacity-0 group-hover/msg:opacity-100 transition">
          <CopyButton text={text} />
        </div>
      )}
    </div>
  )
}

/** 마크다운 본문만. 링크는 기본 브라우저로, 코드 블록에는 복사 버튼이 붙는다. */
export function MarkdownBody({ text }: { text: string }): React.JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{ a: ExternalLinkRenderer, pre: PreWithCopy }}
    >
      {text}
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
      <div className="absolute top-1.5 right-1.5 opacity-0 group-hover/code:opacity-100 transition">
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
