import { useRef, useState } from 'react'
import { ArrowLeft, AtSign, Maximize2 } from 'lucide-react'
import { PanelToolbar } from './ChangesPanel'
import { useStore } from '../store'
import { appendMention, mentionWithRange } from '../lib/mention'
import { isPaneWindow } from '../lib/paneWindow'
import FileTree from './files/FileTree'
import FileViewer from './files/FileViewer'
import { selectedLineRange } from './files/lineRange'
import type { FileContent } from '@shared/types'

/**
 * 우측 패널의 All files 탭. worktree 파일을 lazy 트리로 탐색하고, 파일을 고르면
 * 읽기 전용 뷰어로 본문을 표시한다.
 *
 * 여기는 폭이 좁아 훑어보기용이다 — 코드를 실제로 읽어야 하면 확대 버튼이나 더블클릭으로
 * 대화창 위의 큰 뷰어([[FileViewerOverlay]])로 넘긴다.
 */
export default function FileBrowser({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const [openFile, setOpenFile] = useState<string | null>(null)
  const [content, setContent] = useState<FileContent | null>(null)
  const [loadingFile, setLoadingFile] = useState(false)
  // 새로고침 시 트리를 통째로 다시 마운트하기 위한 키.
  const [treeKey, setTreeKey] = useState(0)
  const preRef = useRef<HTMLPreElement>(null)

  const setDraft = useStore((s) => s.setDraft)
  const pushToast = useStore((s) => s.pushToast)
  const openFileViewer = useStore((s) => s.openFileViewer)

  /**
   * 큰 뷰어로 넘기기. 분리한 패널 창([[paneWindow]])에서는 제공하지 않는다 —
   * 그 창에는 뷰어가 없고, 메인 창으로 넘기면 보조 모니터에서 누른 파일이 반대편 화면에
   * 뜨게 된다. 패널을 떼어 낸 이유가 그 반대라서, 여기서는 버튼 자체를 내린다
   * (분리한 창은 크게 늘릴 수 있어 인라인 뷰어로도 읽을 만하다).
   */
  const openViewer = isPaneWindow ? undefined : (path: string) => openFileViewer(workspaceId, path)

  const selectFile = (path: string): void => {
    setOpenFile(path)
    setContent(null)
    setLoadingFile(true)
    void window.api.fs.read(workspaceId, path).then((c) => {
      setContent(c)
      setLoadingFile(false)
    })
  }

  /**
   * 열려 있는 파일을 입력창 초안에 `@멘션` 으로 붙인다.
   * 본문을 드래그해 뒀으면 `#L시작-끝` 범위로 좁혀 넣는다 — 큰 파일을 통째로 넣으면
   * CLI 가 앞부분만 잘라 넣거나 아예 버릴 수 있어서, 필요한 구간만 지목하는 편이 확실하다.
   */
  const mentionOpenFile = (): void => {
    if (!openFile) return
    const range = content?.binary ? null : selectedLineRange(preRef.current, content?.text ?? '')
    const token = mentionWithRange(openFile, range?.from, range?.to)
    const draft = useStore.getState().drafts[workspaceId] ?? ''
    setDraft(workspaceId, appendMention(draft, token))
    pushToast('info', `Added ${token.trim()} to the message box`)
  }

  const iconBtn =
    'shrink-0 flex items-center gap-1 text-xs text-neutral-400 hover:text-neutral-100 px-1.5 py-0.5 rounded hover:bg-[var(--surface-2)]'

  if (openFile !== null) {
    return (
      <div className="h-full flex flex-col min-h-0">
        <div className="h-8 shrink-0 flex items-center gap-2 px-2 border-b border-[var(--border)]">
          <button onClick={() => setOpenFile(null)} className={iconBtn}>
            <ArrowLeft size={12} /> Files
          </button>
          <span className="flex-1 truncate text-xs font-mono text-neutral-300" title={openFile}>
            {openFile}
          </span>
          {openViewer && (
            <button
              onClick={() => openViewer(openFile)}
              title="Open in the full-size file viewer (⇧⌘O)"
              className={iconBtn}
            >
              <Maximize2 size={12} />
            </button>
          )}
          <button
            onClick={mentionOpenFile}
            title="Mention this file in the message box (select lines first to mention just that range)"
            className={iconBtn}
          >
            <AtSign size={12} /> Mention
          </button>
        </div>
        <FileViewer content={content} loading={loadingFile} preRef={preRef} />
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <PanelToolbar label="Files" onRefresh={() => setTreeKey((k) => k + 1)} spinning={false} />
      <div className="flex-1 overflow-auto py-1">
        <FileTree
          key={treeKey}
          workspaceId={workspaceId}
          selected={openFile}
          onSelect={selectFile}
          onOpen={openViewer}
        />
      </div>
    </div>
  )
}
