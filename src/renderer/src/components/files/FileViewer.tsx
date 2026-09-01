import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowDown, ArrowUp, Loader2, X } from 'lucide-react'
import { highlightFile } from '../../lib/highlight'
import type { FileContent } from '@shared/types'
import type { FileEditor } from './useFileEditor'

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

/** 편집 중 textarea 의 최대 너비(ch). 압축된 한 줄짜리 파일에서 폭이 터지는 것만 막는다. */
const EDIT_MAX_CH = 2000

/**
 * 코드 뷰어. 줄 번호 gutter + 하이라이트 + (선택적) 파일 내 검색, 그리고 `editor` 를 주면
 * 그 자리에서 고칠 수 있다.
 *
 * gutter 는 줄마다 DOM 을 만들지 않고 번호를 개행으로 이어 붙인 <pre> 하나로 그린다 —
 * 1MB 파일이면 줄이 수만 개라, 줄당 엘리먼트를 만들면 스크롤이 바로 무거워진다.
 *
 * 편집은 `<textarea>` 하나다 — 오타 수정 수준이면 충분하고, 풀 에디터를 들이면 하이라이트·
 * 폴딩·자동완성까지 따라와 뷰어가 아니라 IDE 가 된다. 대신 편집 중에는 하이라이트가 꺼진다
 * (textarea 는 서식 있는 텍스트를 담지 못한다). 고칠 게 끝나면 저장하고 다시 색이 돌아온다.
 */
export default function FileViewer({
  content,
  loading,
  preRef,
  density = 'dense',
  focusLine,
  searchOpen = false,
  onCloseSearch,
  editor
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
  /** 주면 인라인 편집이 가능해진다. 없으면 지금까지처럼 읽기 전용이다. */
  editor?: FileEditor
}): React.JSX.Element {
  const { fontSize, lineHeight } = DENSITY[density]
  const scrollRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [matchIdx, setMatchIdx] = useState(0)

  const editing = editor?.editing ?? false
  // 편집 중에는 초안이 곧 본문이다 — gutter 도 검색도 지금 화면에 보이는 글자를 따라야 한다.
  const text = editing ? (editor?.draft ?? '') : content && !content.binary ? content.text : ''

  const html = useMemo(
    () =>
      !editing && content && !content.binary ? highlightFile(content.path, content.text) : null,
    [content, editing]
  )

  const { gutter, gutterWidth, editWidth } = useMemo(() => {
    const rows = text ? text.split('\n') : ['']
    let out = '1'
    for (let i = 2; i <= rows.length; i++) out += `\n${i}`
    // textarea 는 내용에 맞춰 늘어나지 않으므로 가장 긴 줄로 폭을 잡아 준다(등폭이라 1ch=한 글자).
    // 이 폭이 있어야 바깥 컨테이너가 가로로 스크롤되고 gutter 가 왼쪽에 붙어 따라온다.
    const longest = rows.reduce((m, r) => Math.max(m, r.length), 0)
    return {
      gutter: out,
      gutterWidth: `${String(rows.length).length}ch`,
      editWidth: Math.min(EDIT_MAX_CH, Math.max(40, longest + 2))
    }
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

      {editor?.conflict && (
        <ConflictBanner
          conflict={editor.conflict}
          onOverwrite={() => void editor.save(true)}
          onTakeDisk={editor.takeDisk}
          onDismiss={editor.dismissConflict}
        />
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
          {activeLine !== undefined && !editing && (
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
          {editing ? (
            <textarea
              autoFocus
              value={editor?.draft ?? ''}
              onChange={(e) => editor?.change(e.target.value)}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              wrap="off"
              aria-label={`Edit ${content.path}`}
              className="m-0 resize-none border-0 bg-transparent pl-3 pr-4 font-mono text-neutral-100 outline-none"
              style={{
                fontSize,
                lineHeight: `${lineHeight}px`,
                // 줄 수 그대로 높이를 잡아야 gutter 의 번호와 한 줄씩 맞물린다.
                height: (text.split('\n').length || 1) * lineHeight,
                width: `${editWidth}ch`
              }}
            />
          ) : (
            /* 이 <pre> 안에는 파일 본문만 들어가야 한다 — @멘션 라인 범위가 텍스트 오프셋에
               의존하므로 번호를 섞으면 범위가 밀린다(files/lineRange.ts 참고). */
            <pre ref={preRef} className="hljs m-0 bg-transparent pl-3 pr-4 whitespace-pre">
              {html ? (
                <code dangerouslySetInnerHTML={{ __html: html }} />
              ) : (
                <code>{content.text}</code>
              )}
            </pre>
          )}
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

/**
 * 저장이 막혔을 때 뜨는 배너.
 *
 * 모달이 아니라 배너인 이유는, 선택지 중 하나가 "그대로 계속 고친다" 이기 때문이다. 모달은
 * 본문을 가려서 내가 뭘 쓰고 있었는지 보이지 않게 하고, 확인 대화상자는 선택지를 둘로 줄인다.
 * 여기서 필요한 것은 셋이다 — 덮어쓴다 / 디스크 것을 쓴다 / 일단 닫고 더 본다.
 */
function ConflictBanner({
  conflict,
  onOverwrite,
  onTakeDisk,
  onDismiss
}: {
  conflict: NonNullable<FileEditor['conflict']>
  onOverwrite: () => void
  onTakeDisk: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const vanished = conflict.conflict === 'vanished'
  const btn =
    'shrink-0 h-6 rounded px-2 text-xs text-neutral-200 bg-[var(--surface-2)] hover:bg-[var(--surface-3)]'

  return (
    <div
      role="alert"
      className="shrink-0 flex items-center gap-2 border-b border-[var(--warning-500)]/40 bg-[var(--warning-500)]/10 px-3 py-1.5 text-xs text-neutral-200"
    >
      <AlertTriangle size={13} className="shrink-0 text-[var(--warning-500)]" />
      <span className="min-w-0 flex-1">
        {vanished
          ? 'This file was deleted on disk since you opened it. Saving will recreate it.'
          : 'This file changed on disk since you opened it — probably the agent. Saving would overwrite those changes.'}
      </span>
      <button onClick={onOverwrite} className={btn} title="Write my version over what is on disk">
        {vanished ? 'Recreate anyway' : 'Overwrite'}
      </button>
      {!vanished && (
        <button
          onClick={onTakeDisk}
          className={btn}
          title="Throw away my edits and reload the file"
        >
          Discard mine
        </button>
      )}
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 grid h-6 w-6 place-items-center rounded text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100"
      >
        <X size={13} />
      </button>
    </div>
  )
}
