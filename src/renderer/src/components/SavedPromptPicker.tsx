import { useEffect, useRef, useState } from 'react'
import { BookMarked } from 'lucide-react'
import type { SavedPrompt } from '@shared/types'
import MenuPanel, { menuItemCls } from './MenuPanel'

/**
 * 리포에 저장해 둔 프롬프트를 고르는 드롭다운.
 *
 * 고르는 것이 **전송이 아니다.** onPick 은 받는 쪽 입력창을 채우기만 하고, 보낼지 말지는
 * 사용자가 정한다 — 고르자마자 나가면 시키지도 않은 턴을 만드는 셈이다. 컴포저와 fan-out
 * 모달이 그 규칙을 똑같이 쓰도록 한 곳에 둔다.
 *
 * 저장된 것이 없으면 아무것도 그리지 않는다. 빈 목록으로 가는 버튼은 컴포저의 좁은 줄에서
 * 자리만 차지하고, 등록은 어차피 리포 설정에서만 할 수 있다.
 */
export default function SavedPromptPicker({
  prompts,
  onPick,
  disabled = false
}: {
  prompts: SavedPrompt[]
  onPick: (prompt: string) => void
  disabled?: boolean
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  // 바깥을 누르거나 Esc 를 치면 닫는다. 리스너는 열려 있는 동안에만 단다.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // 컴포저의 Esc 는 턴 중단이다 — 메뉴가 열려 있을 때는 여기서 멈춰 세운다.
      e.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  if (!prompts.length) return null

  return (
    <div ref={root} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title="Insert a saved prompt (fills the box — it does not send)"
        aria-label="Insert a saved prompt"
        aria-expanded={open}
        className={
          'h-8 w-8 grid place-items-center rounded-lg border border-[var(--border)] text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 ' +
          (open ? 'bg-[var(--surface-2)] text-neutral-100' : '')
        }
      >
        <BookMarked size={15} />
      </button>
      {open && (
        <MenuPanel className="absolute bottom-full right-0 z-20 mb-1.5 max-h-72 w-72 overflow-y-auto">
          {prompts.map((item) => (
            <button
              key={item.id}
              type="button"
              className={menuItemCls + ' flex-col items-start gap-0.5'}
              onClick={() => {
                setOpen(false)
                onPick(item.prompt)
              }}
            >
              <span className="w-full truncate font-medium text-neutral-100">{item.name}</span>
              <span className="w-full truncate text-xs text-neutral-500">{item.prompt}</span>
            </button>
          ))}
        </MenuPanel>
      )}
    </div>
  )
}
