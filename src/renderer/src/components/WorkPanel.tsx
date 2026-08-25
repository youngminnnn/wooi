import { useEffect, useRef, useState } from 'react'
import {
  Files,
  GitCompare,
  GitCommitVertical,
  CheckCheck,
  MonitorPlay,
  SquareArrowOutUpRight
} from 'lucide-react'
import FileBrowser from './FileBrowser'
import ChangesPanel from './ChangesPanel'
import CommitsPanel from './CommitsPanel'
import ChecksPanel from './ChecksPanel'
import PreviewPanel from './PreviewPanel'
import { useStore } from '../store'
import { isPaneWindow } from '../lib/paneWindow'
import type { Workspace } from '@shared/types'

type Tab = 'files' | 'changes' | 'commits' | 'check' | 'preview'

const TABS: {
  id: Tab
  label: string
  icon: React.ComponentType<{ size?: number; className?: string }>
}[] = [
  { id: 'files', label: 'All files', icon: Files },
  { id: 'changes', label: 'Changes', icon: GitCompare },
  { id: 'commits', label: 'Commits', icon: GitCommitVertical },
  { id: 'check', label: 'Check', icon: CheckCheck },
  { id: 'preview', label: 'Preview', icon: MonitorPlay }
]

/** 우상단 탭 패널: All files / Changes / Check / Preview. */
export default function WorkPanel({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('changes')
  const detachPane = useStore((s) => s.detachPane)

  // Preview 는 한 번 연 뒤로는 계속 붙여 둔다(탭을 옮길 때마다 언마운트하면 보고 있던 dev
  // 서버 페이지가 매번 처음부터 다시 로드된다). 열기 전에는 만들지 않는다 — 쓰지도 않을
  // 게스트 프로세스를 워크스페이스마다 띄울 이유가 없다.
  const [previewOpened, setPreviewOpened] = useState(!!workspace.previewUrl)
  // "Open in Preview" 로 들어오는 이동 명령. 같은 주소를 다시 눌러도 반응하도록 seq 를 붙인다.
  const [navTarget, setNavTarget] = useState<{ url: string; seq: number } | null>(null)
  const navSeq = useRef(0)

  const openPreview = (url?: string): void => {
    setPreviewOpened(true)
    setTab('preview')
    if (url) setNavTarget({ url, seq: ++navSeq.current })
  }

  // 스크립트 패널의 "Open in Preview". 그 패널은 다른 창(분리한 scripts 창)에 있을 수 있어
  // main 을 거쳐 방송된다([[main/preview]]).
  useEffect(() => {
    return window.api.preview.onOpen((e) => {
      if (e.workspaceId !== workspace.id) return
      openPreview(e.url)
    })
  }, [workspace.id])

  return (
    <div className="h-full flex flex-col min-h-0 bg-[var(--bg)]">
      {/*
        탭 줄이 자기 폭을 기준으로 스스로 줄어든다. 이 패널은 창 폭이 아니라 스플리터로 정해지므로
        viewport 미디어 쿼리로는 맞출 수 없다 — 워크스페이스 헤더가 같은 이유로 컨테이너 쿼리를
        쓴다([[index.css]] .workspace-header). 좁아지면 라벨이 사라지고 아이콘만 남는다.
      */}
      <div className="workpanel-tabs h-9 shrink-0 flex items-center gap-1 px-2 border-b border-[var(--border)]">
        {/* 아이콘만 남을 정도로 좁아지면 그마저도 넘칠 수 있다. 그때는 눌리는 대신 스크롤한다
            (터미널 탭이 쓰는 방식과 같다 — TerminalPane 의 탭 줄). */}
        <div className="flex-1 min-w-0 flex items-center gap-1 overflow-x-auto no-scrollbar">
          {TABS.map(({ id, label, icon: Icon }) => {
            const active = tab === id
            return (
              <button
                key={id}
                onClick={() => (id === 'preview' ? openPreview() : setTab(id))}
                // 라벨이 감춰지면 버튼에 남는 것은 아이콘뿐이라, 이름을 여기서 보장한다.
                aria-label={label}
                title={label}
                className={
                  'flex items-center gap-1.5 shrink-0 text-sm px-2.5 py-1 rounded-md ' +
                  (active
                    ? 'bg-[var(--surface-2)] text-neutral-100'
                    : 'text-neutral-400 hover:text-neutral-200')
                }
              >
                <Icon size={13} className="shrink-0" />
                <span className="workpanel-tab-label">{label}</span>
              </button>
            )
          })}
        </div>

        {/* 이미 별도 창이면 더 뗄 곳이 없다 — 인라인일 때만 분리 버튼을 보여 준다. */}
        {!isPaneWindow && (
          <button
            onClick={() => detachPane('work')}
            aria-label="Open work panel in a separate window"
            title="Open in a separate window"
            className="h-6 w-6 shrink-0 grid place-items-center rounded-md text-neutral-500 hover:bg-[var(--surface-2)] hover:text-neutral-200"
          >
            <SquareArrowOutUpRight size={13} />
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0">
        {tab === 'files' && <FileBrowser workspaceId={workspace.id} />}
        {tab === 'changes' && (
          <ChangesPanel workspaceId={workspace.id} baseBranch={workspace.baseBranch} />
        )}
        {tab === 'commits' && <CommitsPanel workspaceId={workspace.id} />}
        {tab === 'check' && <ChecksPanel workspaceId={workspace.id} />}
        {/* 다른 탭과 달리 조건부 렌더가 아니라 감추기다 — 위 previewOpened 주석 참고. */}
        {previewOpened && (
          <div className={tab === 'preview' ? 'h-full' : 'hidden'}>
            <PreviewPanel workspace={workspace} navTarget={navTarget} active={tab === 'preview'} />
          </div>
        )}
      </div>
    </div>
  )
}
