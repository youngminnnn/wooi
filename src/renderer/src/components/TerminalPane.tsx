import { useCallback, useEffect, useRef, useState } from 'react'
import { TerminalSquare, RotateCw, Plus, X } from 'lucide-react'
import type { TerminalTab, TerminalTabsState } from '@shared/types'
import { useStore } from '../store'
import TerminalView from './TerminalView'

/** 이름을 붙이지 않은 탭의 표시 이름. 첫 탭은 예전 그대로 "Terminal" 이다. */
function tabLabel(tab: TerminalTab, index: number): string {
  return tab.title?.trim() || (index === 0 ? 'Terminal' : `Terminal ${index + 1}`)
}

/**
 * 우하단 인터랙티브 터미널. 워크스페이스마다 탭을 여러 개 둘 수 있고, 탭 하나가 PTY 하나다.
 *
 * 탭 구성의 주인은 메인 프로세스다([[main/terminal]]) — 작업 패널을 별도 창으로 떼어 내면
 * 탭을 만드는 창과 보는 창이 갈릴 수 있어서, 변경은 IPC 로 보내고 방송(onTabs)으로 되받는다.
 * 화면에는 활성 탭 하나만 붙인다. 배경 탭의 출력은 메인의 버퍼에 계속 쌓이고, 그 탭으로 돌아오면
 * 버퍼가 재생돼 복원된다 — 워크스페이스를 옮겼다 돌아올 때와 똑같은 경로다.
 *
 * 탭이 하나뿐이면 탭바를 그리지 않는다. 그때 화면은 예전(단일 터미널)과 같은 머리글 한 줄이고,
 * 새 탭 버튼은 패널에 마우스를 올렸을 때만 드러난다 — 탭을 안 쓰는 사용자에게 탭을 강요하지 않는다.
 */
export default function TerminalPane({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const [activeId, setActiveId] = useState('')
  /** 셸이 죽은 탭(있으면). 탭별로 기억해야 다른 탭으로 옮겼을 때 Restart 가 따라붙지 않는다. */
  const [exitedId, setExitedId] = useState<string | null>(null)
  const [restartToken, setRestartToken] = useState(0)
  const [editingId, setEditingId] = useState<string | null>(null)

  const apply = useCallback(
    (state: TerminalTabsState) => {
      if (state.workspaceId !== workspaceId || !state.tabs.length) return
      setTabs(state.tabs)
      setActiveId(state.activeId)
    },
    [workspaceId]
  )

  // 탭 구성을 읽어 오고, 이후 변경은 방송으로 따라간다(다른 창에서 만든 탭도 여기로 들어온다).
  // 워크스페이스가 바뀌면 이 컴포넌트는 통째로 다시 마운트되므로(WorkArea 의 key) 여기서
  // 이전 워크스페이스의 탭을 지울 일은 없다.
  useEffect(() => {
    let alive = true
    void window.api.terminal.tabs(workspaceId).then((state) => {
      if (alive) apply(state)
    })
    const off = window.api.terminal.onTabs(apply)
    return () => {
      alive = false
      off()
    }
  }, [workspaceId, apply])

  const activeIndex = tabs.findIndex((t) => t.id === activeId)
  const exited = !!activeId && exitedId === activeId

  const createTab = useCallback((): void => {
    void window.api.terminal.createTab(workspaceId).then(apply)
  }, [workspaceId, apply])

  const closeTab = useCallback(
    (terminalId: string): void => {
      void window.api.terminal.closeTab(workspaceId, terminalId).then(apply)
    },
    [workspaceId, apply]
  )

  const selectTab = useCallback(
    (terminalId: string): void => {
      if (terminalId === activeId) return
      setActiveId(terminalId)
      void window.api.terminal.selectTab(workspaceId, terminalId).then(apply)
    },
    [workspaceId, activeId, apply]
  )

  const renameTab = useCallback(
    (terminalId: string, title: string): void => {
      setEditingId(null)
      void window.api.terminal.renameTab(workspaceId, terminalId, title).then(apply)
    },
    [workspaceId, apply]
  )

  // 단축키: ⌃⇧T 새 탭, ⌃⇧W 탭 닫기, ⌃⇥ / ⌃⇧⇥ 다음·이전 탭.
  // ⌘ 조합은 워크스페이스 이동·헤더 도구가 이미 쓰고 있어 ⌃ 계열로 잡았다. 캡처 단계에서
  // 가로채 stopPropagation 하는 이유는 두 가지다 — xterm 의 키 입력으로 새어 들어가지 않게,
  // 그리고 App 의 전역 단축키(⇧⇥ 권한 모드)와 겹치지 않게.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.metaKey || e.altKey) return
      const st = useStore.getState()
      if (st.overlayOpen || st.confirmState) return

      if (e.shiftKey && e.code === 'KeyT') createTab()
      else if (e.shiftKey && e.code === 'KeyW') {
        if (activeId) closeTab(activeId)
      } else if (e.code === 'Tab') {
        if (tabs.length < 2) return
        const from = activeIndex < 0 ? 0 : activeIndex
        const next = (from + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length
        selectTab(tabs[next].id)
      } else return

      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [tabs, activeId, activeIndex, createTab, closeTab, selectTab])

  const multi = tabs.length > 1

  return (
    <div className="group h-full flex flex-col min-h-0 bg-[var(--bg-2)]">
      <div className="h-7 shrink-0 flex items-center gap-1.5 px-3 border-b border-[var(--border)] text-xs text-neutral-500">
        {multi ? (
          <div className="flex-1 min-w-0 flex items-center gap-1 overflow-x-auto no-scrollbar">
            {tabs.map((tab, i) => (
              <TabChip
                key={tab.id}
                label={tabLabel(tab, i)}
                title={tab.title ?? ''}
                active={tab.id === activeId}
                editing={editingId === tab.id}
                onSelect={() => selectTab(tab.id)}
                onStartRename={() => setEditingId(tab.id)}
                onRename={(title) => renameTab(tab.id, title)}
                onCancelRename={() => setEditingId(null)}
                onClose={() => closeTab(tab.id)}
              />
            ))}
          </div>
        ) : (
          <>
            <TerminalSquare size={12} />
            {editingId && tabs[0] ? (
              <RenameInput
                initial={tabs[0].title ?? ''}
                placeholder={tabLabel(tabs[0], 0)}
                onCommit={(title) => renameTab(tabs[0].id, title)}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <span
                onDoubleClick={() => tabs[0] && setEditingId(tabs[0].id)}
                title="Double-click to rename"
              >
                {tabs[0] ? tabLabel(tabs[0], 0) : 'Terminal'}
              </span>
            )}
            <div className="flex-1" />
          </>
        )}
        {exited && (
          <button
            onClick={() => setRestartToken((n) => n + 1)}
            className="flex items-center gap-1 shrink-0 text-[var(--success-400)] hover:text-[var(--success-300)]"
            title="Restart shell"
          >
            <RotateCw size={11} /> Restart
          </button>
        )}
        <button
          onClick={createTab}
          // 탭이 하나뿐일 때는 평소에 감춰 예전 화면 그대로 보이게 하고, 패널에 마우스를 올리거나
          // 키보드로 짚었을 때만 드러낸다.
          className={`shrink-0 rounded p-0.5 text-neutral-600 hover:bg-[var(--surface-2)] hover:text-neutral-300 focus-visible:opacity-100 ${
            multi ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
          }`}
          title="New terminal tab (⌃⇧T)"
          aria-label="New terminal tab"
        >
          <Plus size={12} />
        </button>
      </div>
      {activeId ? (
        <TerminalView
          key={`${workspaceId}:${activeId}`}
          workspaceId={workspaceId}
          terminalId={activeId}
          restartToken={restartToken}
          onExited={(dead) => setExitedId(dead ? activeId : null)}
        />
      ) : (
        <div className="flex-1 min-h-0" />
      )}
    </div>
  )
}

/** 탭 하나(여러 개일 때만 그린다). 더블클릭하면 이름을 고칠 수 있다. */
function TabChip({
  label,
  title,
  active,
  editing,
  onSelect,
  onStartRename,
  onRename,
  onCancelRename,
  onClose
}: {
  /** 화면에 보이는 이름(이름을 안 붙였으면 순번으로 만든 기본 이름). */
  label: string
  /** 사용자가 붙인 이름(없으면 빈 문자열) — 이름을 고칠 때 입력에 채우는 값. */
  title: string
  active: boolean
  editing: boolean
  onSelect: () => void
  onStartRename: () => void
  onRename: (title: string) => void
  onCancelRename: () => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <div
      onClick={onSelect}
      onDoubleClick={onStartRename}
      className={`group/tab flex items-center gap-1 h-5 pl-2 pr-1 rounded shrink-0 cursor-default ${
        active
          ? 'bg-[var(--surface-2)] text-neutral-200'
          : 'text-neutral-500 hover:bg-[var(--surface-2)]/60 hover:text-neutral-300'
      }`}
      title={editing ? undefined : 'Double-click to rename'}
    >
      {editing ? (
        <RenameInput
          initial={title}
          placeholder={label}
          onCommit={onRename}
          onCancel={onCancelRename}
        />
      ) : (
        <span className="max-w-[10rem] truncate">{label}</span>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        className="rounded p-0.5 text-neutral-600 opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100 hover:bg-[var(--surface-3)] hover:text-neutral-200"
        title="Close tab (⌃⇧W)"
        aria-label={`Close ${label}`}
      >
        <X size={10} />
      </button>
    </div>
  )
}

/** 탭 이름 편집 입력. ⏎ 로 확정, Esc 로 취소, 포커스를 잃으면 확정한다. */
function RenameInput({
  initial,
  placeholder,
  onCommit,
  onCancel
}: {
  initial: string
  placeholder: string
  onCommit: (title: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    ref.current?.select()
  }, [])

  return (
    <input
      ref={ref}
      autoFocus
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') onCommit(value)
        else if (e.key === 'Escape') onCancel()
      }}
      className="w-24 bg-transparent border-b border-[var(--border-2)] text-xs text-neutral-200 outline-none"
    />
  )
}
