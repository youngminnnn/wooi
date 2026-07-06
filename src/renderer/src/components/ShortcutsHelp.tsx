import Modal from './Modal'

/** 키보드 단축키 참조 모달(? 로 열림). 앱 전반의 단축키를 한곳에 모아 보여 준다. */
const GROUPS: { title: string; items: { keys: string[]; label: string }[] }[] = [
  {
    title: 'Navigation',
    items: [
      { keys: ['⌘1', '–', '⌘9'], label: 'Switch to workspace 1–9' },
      { keys: ['⌘['], label: 'Previous workspace' },
      { keys: ['⌘]'], label: 'Next workspace' },
      { keys: ['⌘U'], label: 'Jump to next unread session' },
      { keys: ['⌘I'], label: 'Jump to next session needing input' }
    ]
  },
  {
    title: 'Session & panels',
    items: [
      { keys: ['⌘J'], label: 'Toggle the work panel' },
      { keys: ['⇧⌘S'], label: 'Toggle the scripts panel' },
      { keys: ['⇧⇥'], label: 'Cycle permission mode' },
      { keys: ['⇧⌘A'], label: 'Approve all pending permissions' }
    ]
  },
  {
    title: 'Workspace tools',
    items: [
      { keys: ['⇧⌘E'], label: 'Open workspace in editor' },
      { keys: ['⇧⌘F'], label: 'Reveal workspace in Finder' },
      { keys: ['⇧⌘⌫'], label: 'Archive workspace' }
    ]
  },
  {
    title: 'Conversation',
    items: [
      { keys: ['⌘F'], label: 'Search the conversation' },
      { keys: ['↑', '/', '↓'], label: 'Recall previous messages (in the input box)' },
      { keys: ['⏎'], label: 'Send message' },
      { keys: ['⇧⏎'], label: 'New line' },
      { keys: ['Esc'], label: 'Deny a permission / close a dialog' }
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
