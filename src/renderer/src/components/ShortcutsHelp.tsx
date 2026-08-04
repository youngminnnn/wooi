import Modal from './Modal'

/** 키보드 단축키 참조 모달(? 로 열림). 앱 전반의 단축키를 한곳에 모아 보여 준다. */
const GROUPS: { title: string; items: { keys: string[]; label: string }[] }[] = [
  {
    title: 'Navigation',
    items: [
      { keys: ['⌘K'], label: 'Quick switcher — search any workspace' },
      { keys: ['⌘1', '–', '⌘9'], label: 'Switch to the top 9 workspaces in the sidebar' },
      { keys: ['⌘↑', '/', '⌘↓'], label: 'Previous / next workspace' },
      { keys: ['⌘['], label: 'Back to the workspace you were just in' },
      { keys: ['⌘U'], label: 'Jump to next unread session' },
      { keys: ['⌘I'], label: 'Jump to next session needing input' }
    ]
  },
  {
    title: 'Session & panels',
    items: [
      { keys: ['⌘N'], label: 'New workspace in the focused repository' },
      { keys: ['⇧⌘R'], label: 'Review a pull request' },
      { keys: ['⌘,'], label: 'Open settings' },
      { keys: ['⌘J'], label: 'Toggle the work panel' },
      { keys: ['⇧⌘S'], label: 'Toggle the scripts panel' },
      { keys: ['⇧⌘D'], label: 'Run / stop the dev script' },
      { keys: ['⇧⇥'], label: 'Cycle permission mode' },
      { keys: ['⇧⌘A'], label: 'Approve all pending permissions' }
    ]
  },
  {
    title: 'Workspace tools',
    items: [
      { keys: ['⇧⌘O'], label: 'Open a file in the big viewer' },
      { keys: ['⇧⌘E'], label: 'Open workspace in editor' },
      { keys: ['⇧⌘F'], label: 'Reveal workspace in Finder' },
      { keys: ['⇧⌘X'], label: 'Export conversation' },
      { keys: ['⇧⌘⌫'], label: 'Archive workspace — or the review you have open' }
    ]
  },
  {
    title: 'File viewer',
    items: [
      { keys: ['⇧⌘O'], label: 'Open a file — type a path, add #L42 to jump to a line' },
      { keys: ['⌘F'], label: 'Find in the open file' },
      { keys: ['⌘⌥←', '/', '⌘⌥→'], label: 'Back / forward through visited files' },
      { keys: ['Esc'], label: 'Close the viewer and return to the conversation' }
    ]
  },
  {
    title: 'Conversation',
    items: [
      { keys: ['⌘F'], label: 'Search the conversation' },
      { keys: ['↑', '/', '↓'], label: 'Recall previous messages (in the input box)' },
      { keys: ['⏎'], label: 'Send message — queues it while a turn is running' },
      { keys: ['⌘⏎'], label: 'Stop the current turn and send the message now' },
      { keys: ['⇧⏎'], label: 'New line' },
      { keys: ['Esc'], label: 'Stop the current turn — or close a card / deny a permission' },
      { keys: ['Esc', 'Esc'], label: 'Rewind — restore code to an earlier message' },
      { keys: ['#'], label: 'Start a message with # to save it to CLAUDE.md' }
    ]
  }
]

export default function ShortcutsHelp({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} width={480}>
      <div className="space-y-5">
        {GROUPS.map((g) => (
          <div key={g.title}>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">
              {g.title}
            </div>
            <div className="space-y-1.5">
              {g.items.map((it, i) => (
                <div key={i} className="flex items-center justify-between gap-4">
                  <span className="text-sm text-neutral-300">{it.label}</span>
                  <span className="flex items-center gap-1 shrink-0">
                    {it.keys.map((k, j) =>
                      k === '–' || k === '/' ? (
                        <span key={j} className="text-xs text-neutral-600">
                          {k}
                        </span>
                      ) : (
                        <kbd
                          key={j}
                          className="rounded bg-[var(--surface-2)] border border-[var(--border-2)] px-1.5 py-0.5 text-xs text-neutral-300 tabular-nums"
                        >
                          {k}
                        </kbd>
                      )
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
        <p className="text-xs text-neutral-600 pt-1">
          Press <kbd className="rounded bg-[var(--surface-2)] px-1 py-0.5">?</kbd> anytime to open
          this help.
        </p>
      </div>
    </Modal>
  )
}
