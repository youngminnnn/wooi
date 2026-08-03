import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Loader2, X } from 'lucide-react'
import { highlightFile } from '../../lib/highlight'
import type { FileContent } from '@shared/types'

/**
 * 표시 밀도. 우측 패널은 좁으니 촘촘하게, 오버레이 뷰어는 읽기 좋게 키운다.
 * gutter 와 본문이 **정확히** 같은 줄 높이를 써야 번호가 어긋나지 않으므로 px 로 못 박는다.
 */
const DENSITY = {
  dense: { fontSize: 12, lineHeight: 18 },
  comfortable: { fontSize: 13, lineHeight: 20 }
} as const

/** 본문 위아래 여백(px). 줄 강조 밴드 위치 계산에 그대로 쓰인다. */
const PAD_Y = 8

/**
 * 읽기 전용 코드 뷰어. 줄 번호 gutter + 하이라이트 + (선택적) 파일 내 검색.
 *
 * gutter 는 줄마다 DOM 을 만들지 않고 번호를 개행으로 이어 붙인 <pre> 하나로 그린다 —
 * 1MB 파일이면 줄이 수만 개라, 줄당 엘리먼트를 만들면 스크롤이 바로 무거워진다.
 */
export default function FileViewer({
  content,
  loading,
  preRef,
  density = 'dense',
  focusLine,
  searchOpen = false,
  onCloseSearch
}: {
  content: FileContent | null
  loading: boolean
  /** 본문 선택 영역을 줄 번호로 환산할 때 쓰는 <pre> 참조(@멘션 라인 범위용). */
  preRef: React.RefObject<HTMLPreElement | null>
  density?: keyof typeof DENSITY
  /** 열자마자 가운데로 스크롤하고 강조할 줄(1-based). */
  focusLine?: number
  /** 파일 내 검색바 표시 여부(부모가 ⌘F 로 토글). */
  searchOpen?: boolean
  onCloseSearch?: () => void
}): React.JSX.Element {
  const { fontSize, lineHeight } = DENSITY[density]
  const scrollRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [matchIdx, setMatchIdx] = useState(0)

  const text = content && !content.binary ? content.text : ''

  const html = useMemo(
    () => (content && !content.binary ? highlightFile(content.path, content.text) : null),
    [content]
  )

  const { gutter, gutterWidth } = useMemo(() => {
    const lines = text ? text.split('\n').length : 1
    let out = '1'
    for (let i = 2; i <= lines; i++) out += `\n${i}`
    return { gutter: out, gutterWidth: `${String(lines).length}ch` }
  }, [text])

  /**
   * 검색어를 포함한 줄 번호들(1-based). 줄 단위로만 찾는다 — 이동 대상이 줄이라서 충분하다.
   * 검색바를 닫으면 질의를 지우지 않고 결과만 비운다(다시 열면 찾던 말이 그대로 남아 있다).
   */
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!searchOpen || !q || !text) return []
    const out: number[] = []
    text.split('\n').forEach((line, i) => {
      if (line.toLowerCase().includes(q)) out.push(i + 1)
    })
    return out
  }, [query, text, searchOpen])

  const safeIdx = matches.length ? Math.min(matchIdx, matches.length - 1) : 0
  const activeLine = matches.length ? matches[safeIdx] : focusLine

  // 검색바를 다시 열면 남아 있던 질의를 통째로 선택해 바로 덮어쓸 수 있게 한다.
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.select()
  }, [searchOpen])

  // 강조 줄을 화면 가운데로. content 를 deps 에 넣어, 같은 줄 번호로 다른 파일을 열어도 다시 맞춘다.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !activeLine) return
    el.scrollTo({ top: Math.max(0, PAD_Y + (activeLine - 1) * lineHeight - el.clientHeight / 2) })
  }, [activeLine, lineHeight, content])

  const step = (delta: number): void => {
    if (!matches.length) return
    setMatchIdx((i) => (Math.min(i, matches.length - 1) + delta + matches.length) % matches.length)
  }

  if (loading) {
    return (
      <div className="flex-1 grid place-items-center text-neutral-500">
        <Loader2 size={18} className="animate-spin" />
      </div>
    )
  }
  if (!content) {
    return (
      <div className="flex-1 grid place-items-center text-sm text-neutral-600">
        Couldn’t read file.
      </div>
    )
  }
  if (content.binary) {
    return (
      <div className="flex-1 grid place-items-center text-sm text-neutral-600">
        Binary file — not shown.
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {searchOpen && (
        <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-[var(--border)] bg-[var(--bg-3)]">
          <input
            ref={searchInputRef}
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              // 검색어가 바뀌면 첫 매치부터 다시 훑는다.
              setMatchIdx(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                onCloseSearch?.()
              } else if (e.key === 'Enter') {
                e.preventDefault()
                step(e.shiftKey ? -1 : 1)
              }
            }}
            placeholder="Find in file…"
            aria-label="Find in file"
            className="flex-1 min-w-0 bg-transparent text-sm text-neutral-100 placeholder:text-neutral-600 outline-none"
          />
          <span className="shrink-0 text-xs text-neutral-500 tabular-nums">
            {query.trim()
              ? matches.length
                ? `${safeIdx + 1}/${matches.length} lines`
                : 'none'
              : ''}
          </span>
          <button
            onClick={() => step(-1)}
            disabled={!matches.length}
            aria-label="Previous match"
            className="shrink-0 grid h-6 w-6 place-items-center rounded text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100 disabled:opacity-40"
          >
            <ArrowUp size={13} />
          </button>
          <button
            onClick={() => step(1)}
            disabled={!matches.length}
            aria-label="Next match"
            className="shrink-0 grid h-6 w-6 place-items-center rounded text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100 disabled:opacity-40"
          >
            <ArrowDown size={13} />
          </button>
          <button
            onClick={onCloseSearch}
            aria-label="Close search"
            className="shrink-0 grid h-6 w-6 place-items-center rounded text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100"
          >
            <X size={13} />
          </button>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-auto bg-[var(--code-bg)]">
        <div
          className="relative flex min-w-max font-mono"
          style={{
            fontSize,
            lineHeight: `${lineHeight}px`,
            paddingTop: PAD_Y,
            paddingBottom: PAD_Y
          }}
        >
          {/* 강조 밴드는 gutter 보다 위에 그린다 — 반투명이라 번호가 비쳐 보이고,
              활성 줄이 gutter 쪽에서도 같이 짚인다. */}
          {activeLine !== undefined && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 z-20 bg-[var(--accent-500)]/15"
              style={{ top: PAD_Y + (activeLine - 1) * lineHeight, height: lineHeight }}
            />
          )}
          <pre
            aria-hidden
            className="sticky left-0 z-10 m-0 shrink-0 select-none px-2 text-right text-neutral-600 bg-[var(--code-bg)] whitespace-pre"
            style={{ width: `calc(${gutterWidth} + 1rem)` }}
          >
            {gutter}
          </pre>
          {/* 이 <pre> 안에는 파일 본문만 들어가야 한다 — @멘션 라인 범위가 텍스트 오프셋에
              의존하므로 번호를 섞으면 범위가 밀린다(files/lineRange.ts 참고). */}
          <pre ref={preRef} className="hljs m-0 bg-transparent pl-3 pr-4 whitespace-pre">
            {html ? (
              <code dangerouslySetInnerHTML={{ __html: html }} />
            ) : (
              <code>{content.text}</code>
            )}
          </pre>
        </div>
      </div>

      {content.truncated && (
        <div className="shrink-0 px-3 py-1 text-xs text-[var(--warning-500)]/80">
          File truncated (too large to show fully).
        </div>
      )}
    </div>
  )
}
