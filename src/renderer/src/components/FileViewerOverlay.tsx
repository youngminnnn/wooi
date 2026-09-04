import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  AtSign,
  PanelLeftClose,
  PanelLeftOpen,
  RotateCw,
  Search,
  X
} from 'lucide-react'
import { useStore } from '../store'
import { appendMention, mentionWithRange } from '../lib/mention'
import FileTree from './files/FileTree'
import FileViewer from './files/FileViewer'
import FileEditControls from './files/FileEditControls'
import { useFileEditor } from './files/useFileEditor'
import { selectedLineRange } from './files/lineRange'
import Splitter from './Splitter'
import { openFileQuickOpen } from '../lib/fileViewer'
import type { FileContent, Workspace } from '@shared/types'

/**
 * 대화창 위에 띄우는 큰 파일 뷰어. 사이드바 오른쪽(대화 + 작업 패널)을 덮고, 브라우저처럼
 * 방문 기록을 앞뒤로 오갈 수 있다. Esc 나 닫기로 대화로 그대로 돌아온다 —
 * 대화는 뒤에 살아 있으므로 스크롤 위치도 입력창 초안도 잃지 않는다.
 */
export default function FileViewerOverlay({
  workspace
}: {
  workspace: Workspace
}): React.JSX.Element {
  const state = useStore((s) => s.fileViewer)
  const treeWidth = useStore((s) => s.fileViewerTreeWidth)
  const setTreeWidth = useStore((s) => s.setFileViewerTreeWidth)
  const toggleTree = useStore((s) => s.toggleFileViewerTree)
  const open = useStore((s) => s.openFileViewer)
  const close = useStore((s) => s.closeFileViewer)
  const navigate = useStore((s) => s.navigateFileViewer)
  const setDraft = useStore((s) => s.setDraft)
  const pushToast = useStore((s) => s.pushToast)
  const confirm = useStore((s) => s.confirm)

  const [content, setContent] = useState<FileContent | null>(null)
  const [loading, setLoading] = useState(true)
  const [searchOpen, setSearchOpen] = useState(false)
  // 새로고침 시 본문을 다시 읽기 위한 카운터(에이전트가 방금 고친 파일을 그 자리에서 확인).
  const [reloadKey, setReloadKey] = useState(0)
  const preRef = useRef<HTMLPreElement>(null)
  const widthBase = useRef(treeWidth)

  const entry = state?.history[state.index]
  const path = entry?.path ?? null

  useEffect(() => {
    if (!path) return
    let alive = true
    setLoading(true)
    setContent(null)
    void window.api.fs.read(workspace.id, path).then((c) => {
      if (!alive) return
      setContent(c)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [workspace.id, path, reloadKey])

  const editor = useFileEditor({
    workspaceId: workspace.id,
    path,
    content,
    onContent: setContent
  })

  // 파일이 바뀌면 검색바는 접는다 — 이전 파일에서 찾던 말이 그대로 남아 있으면 혼란스럽다.
  useEffect(() => setSearchOpen(false), [path])

  const canBack = !!state && state.index > 0
  const canForward = !!state && state.index < state.history.length - 1

  /** 편집을 접는다. 고친 것이 있으면 먼저 확인을 받는다. */
  const cancelWithGuard = async (): Promise<void> => {
    if (editor.dirty) {
      const ok = await confirm({
        title: `Discard unsaved changes to ${path}?`,
        body: 'Your edits were never written to disk.',
        confirmLabel: 'Discard',
        danger: true
      })
      if (!ok) return
    }
    editor.cancel()
  }

  /**
   * 저장하지 않은 초안을 안고 뷰어를 닫으려 할 때 확인을 받는다.
   *
   * 초안은 경로별로 남으므로 뷰어 안을 돌아다니는 동안은 아무것도 잃지 않는다. 잃는 지점은
   * 여기 하나뿐이라 확인도 여기에만 둔다. 승인하면 초안을 버리고 대화로 돌아간다.
   */
  const closeWithGuard = async (): Promise<void> => {
    const unsaved = editor.dirtyPaths
    if (unsaved.length) {
      const ok = await confirm({
        title:
          unsaved.length === 1
            ? `Discard unsaved changes to ${unsaved[0]}?`
            : `Discard unsaved changes to ${unsaved.length} files?`,
        body:
          unsaved.length === 1
            ? 'Your edits were never written to disk. Closing the viewer throws them away.'
            : `${unsaved.join(', ')}\n\nThese edits were never written to disk. Closing the viewer throws them away.`,
        confirmLabel: 'Discard',
        danger: true
      })
      if (!ok) return
      editor.discardAll()
    }
    close()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // 위에 confirm 이나 팔레트가 떠 있으면 그쪽이 먼저다(팔레트는 전파를 끊는다).
      if (useStore.getState().confirmState) return

      if (e.key === 'Escape') {
        e.preventDefault()
        // Esc 는 한 겹씩 벗긴다 — 검색바, 그다음 편집, 그다음 뷰어. 편집 중에 한 번에
        // 닫아 버리면 대화로 돌아가려던 습관적인 Esc 가 초안을 지우는 키가 된다.
        if (searchOpen) setSearchOpen(false)
        else if (editor.editing) void cancelWithGuard()
        else void closeWithGuard()
        return
      }
      if (!e.metaKey) return
      // ⌘S: 저장. 편집 중이 아니면 아무 일도 없다.
      if (e.code === 'KeyS' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        if (editor.editing && editor.dirty && !editor.saving) void editor.save()
        return
      }
      // ⌘E: 편집 시작. ⇧⌘E 는 외부 에디터로 여는 기존 단축키라 건드리지 않는다.
      if (e.code === 'KeyE' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        if (!editor.editing) editor.begin()
        return
      }
      // ⌘F: 파일 내 검색. 뒤쪽 대화 검색은 overlayOpen 동안 양보한다(MessageList 참고).
      if (e.code === 'KeyF' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        setSearchOpen(true)
        return
      }
      // ⌘⌥←/→: 뒤로/앞으로. ⌘[ 는 워크스페이스 뒤로가기라 겹치지 않게 macOS 관례를 따랐다.
      if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault()
        navigate(e.key === 'ArrowLeft' ? -1 : 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close, navigate, searchOpen, editor, confirm])

  /**
   * 보고 있는 파일을 입력창 초안에 `@멘션` 으로 붙인다(작업 패널 뷰어와 같은 동작).
   * 본문을 드래그해 뒀으면 `#L시작-끝` 범위로 좁혀 넣는다.
   */
  const mention = (): void => {
    if (!path) return
    const range = content?.binary ? null : selectedLineRange(preRef.current, content?.text ?? '')
    const token = mentionWithRange(path, range?.from, range?.to)
    const draft = useStore.getState().drafts[workspace.id] ?? ''
    setDraft(workspace.id, appendMention(draft, token))
    pushToast('info', `Added ${token.trim()} to the message box`)
  }

  if (!state || !path) return <></>

  const navBtn =
    'shrink-0 grid h-7 w-7 place-items-center rounded-md text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-neutral-400'

  return (
    <div
      role="dialog"
      aria-label={`File viewer — ${path}`}
      className="no-drag absolute inset-0 z-40 flex flex-col bg-[var(--bg)]"
    >
      <div className="h-11 shrink-0 flex items-center gap-1.5 px-2 border-b border-[var(--border)]">
        <button
          onClick={toggleTree}
          className={navBtn}
          title={state.treeOpen ? 'Hide the file tree' : 'Show the file tree'}
        >
          {state.treeOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
        </button>
        <button
          onClick={() => navigate(-1)}
          disabled={!canBack}
          className={navBtn}
          title="Back (⌘⌥←)"
        >
          <ArrowLeft size={15} />
        </button>
        <button
          onClick={() => navigate(1)}
          disabled={!canForward}
          className={navBtn}
          title="Forward (⌘⌥→)"
        >
          <ArrowRight size={15} />
        </button>

        {/* 주소창 — 누르면 퀵 오픈 팔레트가 떠 다른 파일로 바로 이동한다. */}
        <button
          onClick={openFileQuickOpen}
          title={`${path}\n(click to open another file — ⇧⌘O)`}
          className="flex-1 min-w-0 flex items-center gap-2 h-7 px-2.5 rounded-md bg-[var(--bg-3)] border border-[var(--border)] text-left hover:border-[var(--border-strong)]"
        >
          <Search size={12} className="shrink-0 text-neutral-500" />
          <span className="truncate text-xs font-mono text-neutral-300">{path}</span>
        </button>

        <button
          onClick={() => setReloadKey((k) => k + 1)}
          className={navBtn}
          title="Reload this file from disk"
        >
          <RotateCw size={14} />
        </button>
        <FileEditControls editor={editor} />
        <button
          onClick={mention}
          className="shrink-0 flex items-center gap-1.5 h-7 px-2 rounded-md text-xs text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100"
          title="Mention this file in the message box (select lines first to mention just that range)"
        >
          <AtSign size={13} /> Mention
        </button>
        <button
          onClick={() => void closeWithGuard()}
          className="shrink-0 flex items-center gap-1.5 h-7 px-2 rounded-md text-xs text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100"
          title="Back to the conversation (Esc)"
        >
          <X size={14} /> Close
          <kbd className="rounded bg-[var(--surface-3)] px-1 py-0.5 text-2xs leading-none text-neutral-400">
            esc
          </kbd>
        </button>
      </div>

      <div className="flex-1 flex min-h-0">
        {state.treeOpen && (
          <>
            <div style={{ width: treeWidth }} className="shrink-0 overflow-auto py-1">
              <FileTree
                workspaceId={workspace.id}
                selected={path}
                onSelect={(p) => open(workspace.id, p)}
                onOpen={(p) => open(workspace.id, p)}
              />
            </div>
            <Splitter
              axis="x"
              onStart={() => (widthBase.current = useStore.getState().fileViewerTreeWidth)}
              onDelta={(dx) => setTreeWidth(widthBase.current + dx)}
            />
          </>
        )}
        <div className="flex-1 min-w-0 flex flex-col">
          <FileViewer
            key={path}
            content={content}
            loading={loading}
            preRef={preRef}
            density="comfortable"
            focusLine={entry?.line}
            searchOpen={searchOpen}
            onCloseSearch={() => setSearchOpen(false)}
            editor={editor}
          />
        </div>
      </div>
    </div>
  )
}
