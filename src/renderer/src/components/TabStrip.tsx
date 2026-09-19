import { useState } from 'react'
import { ChartNoAxesCombined, MessageSquare, Globe, FileCode, Layers, Sparkles, Plus, X } from 'lucide-react'
import MenuPanel, { menuItemCls } from './MenuPanel'
import type { WorkspaceTab } from '@shared/types'

/**
 * 워크스페이스 콘텐츠 영역 맨 위의 탭 줄.
 *
 * 대화가 고정된 첫 탭이고, dev 프리뷰·웹·파일 같은 것이 그 오른쪽에 붙는다. 크롬의 탭처럼
 * 활성 탭이 아래 내용과 이어져 보이도록 모서리를 위쪽만 둥글리고 바닥선을 지운다 — 그래야
 * "이 탭이 지금 보고 있는 화면" 이라는 것이 색 하나가 아니라 형태로 읽힌다.
 *
 * 상태를 스스로 들지 않는다. 목록의 주인은 main 이고([[main/workspaceTabs]]) 구독은
 * `App` 이 한 번만 한다 — 여기서 또 구독하면 탭이 바뀔 때마다 같은 일이 두 번 일어난다.
 */
export default function TabStrip({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNew
}: {
  tabs: WorkspaceTab[]
  activeId: string
  onSelect: (tabId: string) => void
  onClose: (tabId: string) => void
  /**
   * 새 탭을 연다.
   *
   * 종류를 고르게 하는 이유: 열 수 있는 것 중에 **다른 입구가 없는 것**이 있다. 아티팩트가
   * 그렇다 — 에이전트가 만들 때 탭이 생기지만 닫고 나면 다시 열 길이 사라진다(dev 는 스크립트
   * 패널, 파일은 All files·퀵오픈이라는 입구가 따로 있다).
   */
  onNew: (kind: 'web' | 'artifact') => void
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <div className="h-9 shrink-0 flex items-end px-2 bg-[var(--bg-2)] border-b border-[var(--border)]">
      {/*
        탭만 스크롤한다. `+` 를 이 안에 두면 `overflow-x-auto` 가 만드는 잘림 상자에 갇혀
        드롭다운이 통째로 잘린다 — 버튼은 눌리는데 메뉴가 안 보이는 증상이 된다. 작업 패널의
        탭 줄이 분리 버튼을 스크롤 바깥에 두는 것과 같은 이유다.
      */}
      <div
        role="tablist"
        aria-label="Workspace tabs"
        className="flex-1 min-w-0 flex items-end gap-px overflow-x-auto no-scrollbar"
      >
        {tabs.map((tab) => (
          <TabButton
            key={tab.id}
            tab={tab}
            active={tab.id === activeId}
            onSelect={() => onSelect(tab.id)}
            onClose={() => onClose(tab.id)}
          />
        ))}
      </div>
      <div className="relative shrink-0 mb-[3px]">
        <button
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="New tab"
          aria-expanded={menuOpen}
          title="New tab"
          className="grid h-6 w-6 place-items-center rounded-md text-neutral-500 hover:bg-[var(--surface)] hover:text-neutral-200"
        >
          <Plus size={13} />
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
            {/*
              오른쪽 끝에 붙여 왼쪽으로 편다. `+` 는 탭 줄의 맨 오른쪽, 즉 창의 오른쪽
              가장자리에서 몇 px 안쪽에 있다 — `left-0` 으로 오른쪽으로 펴면 패널 폭만큼이
              창 밖으로 나가 잘리고, 항목의 아이콘 부분만 남아 보인다.
            */}
            <MenuPanel className="absolute right-0 top-full z-50 mt-1 w-44">
              <button
                className={menuItemCls}
                onClick={() => {
                  setMenuOpen(false)
                  onNew('web')
                }}
              >
                <Globe size={12} className="shrink-0" />
                New web tab
              </button>
              <button
                className={menuItemCls}
                onClick={() => {
                  setMenuOpen(false)
                  onNew('artifact')
                }}
              >
                <Sparkles size={12} className="shrink-0 text-[var(--accent-400)]" />
                Artifacts
              </button>
            </MenuPanel>
          </>
        )}
      </div>
    </div>
  )
}

/** 탭 하나. 작업 탭은 닫을 수 없고 줄어들지도 않는다 — 늘 제자리에 있어야 돌아올 곳이 분명하다. */
function TabButton({
  tab,
  active,
  onSelect,
  onClose
}: {
  tab: WorkspaceTab
  active: boolean
  onSelect: () => void
  onClose: () => void
}): React.JSX.Element {
  const pinned = tab.kind === 'work'
  return (
    <div
      className={
        'group relative flex items-center gap-1.5 h-[29px] rounded-t-lg pl-2.5 pr-1.5 text-xs ' +
        (pinned ? 'shrink-0 pr-2.5 ' : 'flex-1 basis-[150px] max-w-[160px] min-w-[44px] ') +
        (active
          ? 'bg-[var(--bg)] text-neutral-100 shadow-[inset_1px_0_0_var(--border),inset_-1px_0_0_var(--border),inset_0_1px_0_var(--border)]'
          : 'text-neutral-400 hover:bg-[var(--surface)] hover:text-neutral-300')
      }
    >
      {/* 활성 탭의 바닥선을 지워 아래 내용과 이어 붙인다. */}
      {active && <span className="absolute inset-x-0 -bottom-px h-px bg-[var(--bg)]" />}
      <button
        role="tab"
        aria-selected={active}
        onClick={onSelect}
        title={tab.title ?? tabLabel(tab)}
        className="relative min-w-0 flex-1 flex items-center gap-1.5 text-left"
      >
        <TabIcon tab={tab} />
        <span className="truncate">{tab.title ?? tabLabel(tab)}</span>
      </button>
      {!pinned && (
        <button
          onClick={onClose}
          aria-label={`Close ${tab.title ?? tabLabel(tab)}`}
          className={
            'relative shrink-0 grid h-[15px] w-[15px] place-items-center rounded ' +
            'opacity-0 group-hover:opacity-50 hover:!opacity-100 hover:bg-[var(--surface-3)] ' +
            (active ? 'opacity-50' : '')
          }
        >
          <X size={11} strokeWidth={2.5} />
        </button>
      )}
    </div>
  )
}

function TabIcon({ tab }: { tab: WorkspaceTab }): React.JSX.Element {
  if (tab.kind === 'work') return <MessageSquare size={12} className="shrink-0" />
  // dev 서버는 "도는 중" 이 곧 정체성이라 점으로 그린다 — 아이콘을 하나 더 두는 것보다 읽기 쉽다.
  if (tab.kind === 'dev')
    return <span className="shrink-0 h-[7px] w-[7px] rounded-full bg-[var(--success-400)]" />
  if (tab.kind === 'file') return <FileCode size={12} className="shrink-0" />
  if (tab.kind === 'stack') return <Layers size={12} className="shrink-0" />
  // 모델이 만든 것은 한눈에 갈려야 한다 — dev 서버나 진짜 사이트로 착각하면 안 된다.
  if (tab.kind === 'artifact')
    return <Sparkles size={12} className="shrink-0 text-[var(--accent-400)]" />
  if (tab.kind === 'visualization')
    return <ChartNoAxesCombined size={12} className="shrink-0 text-sky-300" />
  return <Globe size={12} className="shrink-0" />
}

/** 이름을 안 붙인 탭의 기본 표기. 주소가 있으면 그걸 줄여 쓰고, 없으면 종류를 쓴다. */
function tabLabel(tab: WorkspaceTab): string {
  if (tab.kind === 'work') return 'Work'
  // target 은 앵커 워크스페이스 id라 그대로 쓰면 읽을 수 없다 — 종류 이름으로 대신한다.
  if (tab.kind === 'stack') return 'Stack'
  if (tab.kind === 'artifact') return 'Artifacts'
  if (tab.kind === 'visualization') return 'Visualization'
  if (!tab.target) return tab.kind
  try {
    const url = new URL(tab.target)
    return url.port ? `${url.hostname}:${url.port}` : url.hostname
  } catch {
    // 주소가 아니면(파일 경로 등) 마지막 조각이 가장 알아보기 쉽다.
    return tab.target.split('/').filter(Boolean).at(-1) ?? tab.target
  }
}
