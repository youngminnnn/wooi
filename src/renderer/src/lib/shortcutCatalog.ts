/**
 * 앱 전체 단축키의 **정본**. 도움말 모달(`ShortcutsHelp`)과 명령 팔레트(`QuickSwitcher`)가
 * 둘 다 여기를 읽는다.
 *
 * 라벨을 팔레트용으로 복제하지 않는 이유는 단순하다 — 복제한 순간 한쪽만 고쳐지고, 그때부터
 * 도움말과 팔레트가 서로 다른 앱을 설명하게 된다. 목록이 하나면 어긋날 자리가 없다.
 * `commandPalette.test` 가 이 배열의 모든 항목이 팔레트 인덱스에 들어오는지 지킨다.
 */

/**
 * 팔레트에서 **실행할 수 있는** 동작의 이름.
 *
 * 단축키가 있다고 전부 여기 오지는 않는다. `⏎ 전송`·`⇧⏎ 줄바꿈` 같은 타건 제스처와
 * `⌘↑ / ⌘↓` 처럼 한 줄이 두 방향을 함께 설명하는 항목은 "누를 수는 있어도 고를 수는 없는"
 * 것들이라, 팔레트에서는 참조 행으로만 남는다(검색은 되고 Enter 는 듣지 않는다).
 *
 * 실제 구현은 `App.tsx` 가 들고 있다 — 전역 keydown 과 팔레트가 **같은 함수**를 부른다.
 */
export type PaletteActionId =
  | 'open-shortcuts'
  | 'search-conversations'
  | 'next-unread'
  | 'next-needs-input'
  | 'new-workspace'
  | 'new-workspace-choose-agent'
  | 'undo-workspace-action'
  | 'reopen-archived'
  | 'review-pull-request'
  | 'open-stack-view'
  | 'open-settings'
  | 'toggle-work-panel'
  | 'toggle-scripts-panel'
  | 'toggle-dev-script'
  | 'cycle-permission-mode'
  | 'approve-all-permissions'
  | 'open-file'
  | 'open-in-editor'
  | 'reveal-in-finder'
  | 'export-conversation'
  | 'archive-workspace'
  | 'delete-workspace'
  | 'focus-composer'
  | 'toggle-tool-results'

export interface ShortcutItem {
  /** 도움말에 그리는 글쇠들. `–` 와 `/` 는 kbd 가 아니라 구분 기호로 그려진다. */
  keys: string[]
  label: string
  /** 팔레트에서 고를 수 있는 동작이면 그 이름. 없으면 검색만 되는 참조 행이다. */
  action?: PaletteActionId
}

export interface ShortcutGroup {
  title: string
  items: ShortcutItem[]
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Navigation',
    items: [
      { keys: ['⌘K'], label: 'Quick switcher — search any workspace' },
      {
        keys: ['⇧⌘K'],
        label: 'Search conversations across every workspace',
        action: 'search-conversations'
      },
      { keys: ['⌘1', '–', '⌘9'], label: 'Switch to the top 9 workspaces in the sidebar' },
      { keys: ['⌘↑', '/', '⌘↓'], label: 'Previous / next workspace' },
      { keys: ['⌘[', '/', '⌘]'], label: 'Back / forward through workspaces you visited' },
      { keys: ['⌘U'], label: 'Jump to next unread session', action: 'next-unread' },
      { keys: ['⌘I'], label: 'Jump to next session needing input', action: 'next-needs-input' },
      { keys: ['?'], label: 'Show keyboard shortcuts', action: 'open-shortcuts' }
    ]
  },
  {
    title: 'Session & panels',
    items: [
      { keys: ['⌘N'], label: 'New workspace in the focused repository', action: 'new-workspace' },
      {
        keys: ['⇧⌘N'],
        label: 'Choose an agent for a new workspace',
        action: 'new-workspace-choose-agent'
      },
      {
        keys: ['⌘Z'],
        label: 'Undo — delete the workspace you just created',
        action: 'undo-workspace-action'
      },
      {
        keys: ['⇧⌘T'],
        label: 'Reopen the workspace you just archived',
        action: 'reopen-archived'
      },
      { keys: ['⇧⌘R'], label: 'Review a pull request', action: 'review-pull-request' },
      {
        keys: ['⇧⌘L'],
        label: 'Lay out the whole stack of the selected workspace',
        action: 'open-stack-view'
      },
      { keys: ['⇧⌘B'], label: 'Rebase the workspace onto its base branch' },
      { keys: ['⌘,'], label: 'Open settings', action: 'open-settings' },
      { keys: ['⌘J'], label: 'Toggle the work panel', action: 'toggle-work-panel' },
      { keys: ['⇧⌘S'], label: 'Toggle the scripts panel', action: 'toggle-scripts-panel' },
      { keys: ['⇧⌘D'], label: 'Run / stop the dev script', action: 'toggle-dev-script' },
      { keys: ['⇧⇥'], label: 'Cycle permission mode', action: 'cycle-permission-mode' },
      {
        keys: ['⇧⌘A'],
        label: 'Approve all pending permissions',
        action: 'approve-all-permissions'
      }
    ]
  },
  {
    title: 'Workspace tools',
    items: [
      { keys: ['⇧⌘O'], label: 'Open a file in the big viewer', action: 'open-file' },
      { keys: ['⇧⌘E'], label: 'Open workspace in editor', action: 'open-in-editor' },
      { keys: ['⇧⌘F'], label: 'Reveal workspace in Finder', action: 'reveal-in-finder' },
      { keys: ['⇧⌘X'], label: 'Export conversation', action: 'export-conversation' },
      {
        keys: ['⇧⌘⌫'],
        label: 'Archive workspace — or the review you have open',
        action: 'archive-workspace'
      },
      {
        keys: ['⌥⌘⌫'],
        label: 'Delete workspace for good — worktree, branch and history',
        action: 'delete-workspace'
      }
    ]
  },
  {
    title: 'Terminal tabs',
    items: [
      { keys: ['⌃⇧T'], label: 'New terminal tab' },
      { keys: ['⌃⇧W'], label: 'Close the terminal tab you are on' },
      { keys: ['⌃⇥', '/', '⇧⌃⇥'], label: 'Next / previous terminal tab' },
      { keys: ['Double-click'], label: 'Rename a tab' }
    ]
  },
  {
    title: 'File viewer',
    items: [
      {
        keys: ['⇧⌘O'],
        label: 'Open a file — type a path, add #L42 to jump to a line',
        action: 'open-file'
      },
      { keys: ['⌘F'], label: 'Find in the open file' },
      { keys: ['⌘⌥←', '/', '⌘⌥→'], label: 'Back / forward through visited files' },
      { keys: ['Esc'], label: 'Close the viewer and return to the conversation' }
    ]
  },
  {
    title: 'Changes',
    items: [
      { keys: ['F7'], label: 'Jump to the next change in the diff' },
      { keys: ['⇧F7'], label: 'Jump to the previous change in the diff' }
    ]
  },
  {
    title: 'Pull request review',
    items: [
      { keys: ['⇧⌘R'], label: 'Review a pull request', action: 'review-pull-request' },
      { keys: ['n', '/', 'p'], label: 'Next / previous comment on the diff' },
      { keys: ['⌥⌘↓', '/', '⌥⌘↑'], label: 'Next / previous comment — same thing, with modifiers' },
      { keys: ['⇧⌘⌫'], label: 'Archive the review you have open', action: 'archive-workspace' }
    ]
  },
  {
    title: 'Conversation',
    items: [
      { keys: ['⌘L'], label: 'Focus the message input', action: 'focus-composer' },
      { keys: ['⌘F'], label: 'Search the conversation' },
      { keys: ['⌘+', '/', '⌘-'], label: 'Bigger / smaller conversation text' },
      { keys: ['⌘0'], label: 'Reset conversation text size' },
      {
        keys: ['⌃O'],
        label: 'Expand or collapse all tool results',
        action: 'toggle-tool-results'
      },
      { keys: ['⇧⌘↓'], label: 'Jump to the latest message' },
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
