import { Loader2, Pencil, Save } from 'lucide-react'
import type { FileEditor } from './useFileEditor'

/**
 * 뷰어 툴바의 편집 버튼들. 오버레이와 All files 패널이 같은 것을 써야 해서 따로 뒀다 —
 * 한쪽에만 저장이 붙으면 사용자는 어느 뷰어가 고칠 수 있는 뷰어인지 외워야 한다.
 *
 * 읽기 전용일 땐 Edit 하나, 편집 중일 땐 Save + Cancel 이다. 저장은 **명시적으로** 누른다 —
 * 자동 저장은 에이전트가 같은 파일을 만지는 중에 조용히 끼어들 수 있어서 쓰지 않는다.
 */
export default function FileEditControls({
  editor,
  compact = false
}: {
  editor: FileEditor
  /** 좁은 패널용 — 글자를 빼고 아이콘만 남긴다. */
  compact?: boolean
}): React.JSX.Element {
  const base =
    'shrink-0 flex items-center gap-1.5 h-7 rounded-md text-xs text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100 disabled:opacity-40 disabled:hover:bg-transparent'
  const pad = compact ? 'w-7 justify-center' : 'px-2'

  if (!editor.editing) {
    return (
      <button
        onClick={editor.begin}
        disabled={!editor.canEdit}
        className={`${base} ${pad}`}
        title={
          editor.canEdit
            ? 'Edit this file (⌘E)'
            : 'This file can’t be edited here (binary, or too large to load fully)'
        }
      >
        <Pencil size={13} />
        {!compact && 'Edit'}
      </button>
    )
  }

  return (
    <>
      <button
        onClick={() => void editor.save()}
        disabled={!editor.dirty || editor.saving}
        className={`${base} ${pad} !text-[var(--accent-400)] hover:!text-[var(--accent-300)]`}
        title={editor.dirty ? 'Save to disk (⌘S)' : 'Nothing to save'}
      >
        {editor.saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
        {!compact && (editor.saving ? 'Saving…' : 'Save')}
      </button>
      <button onClick={editor.cancel} className={`${base} ${pad}`} title="Stop editing (Esc)">
        {compact ? '✕' : 'Cancel'}
      </button>
    </>
  )
}
