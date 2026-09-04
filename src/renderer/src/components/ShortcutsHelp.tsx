import Modal from './Modal'
import { SHORTCUT_GROUPS } from '../lib/shortcutCatalog'

/**
 * 키보드 단축키 참조 모달(? 로 열림). 앱 전반의 단축키를 한곳에 모아 보여 준다.
 *
 * 목록 자체는 [[lib/shortcutCatalog]] 에 있다 — ⌘K 팔레트가 같은 목록을 읽어 항목을 만든다.
 * 여기서 라벨을 다시 쓰면 두 화면이 서로 다른 앱을 설명하게 된다.
 */
const GROUPS = SHORTCUT_GROUPS

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
