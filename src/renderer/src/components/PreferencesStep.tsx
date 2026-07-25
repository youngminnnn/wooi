import { useState } from 'react'
import { PanelRight, PanelRightClose } from 'lucide-react'
import { useStore } from '../store'
import { primaryBtn } from './Modal'
import { PERMISSION_ORDER, PERMISSION_LABELS, PERMISSION_DESCRIPTIONS } from '../lib/permission'
import { applyTheme } from '../lib/theme'
import type { AppSettings, PermissionMode, ThemePreference } from '@shared/types'

/**
 * 온보딩 마지막 단계 — 가장 자주 바꾸는 기본값을 미리 고르게 한다.
 * 기능 투어 바로 뒤에 오는 이유: 투어가 권한 모드(⇧⇥)와 작업 패널(⌘J)을 방금 설명했으므로,
 * 사용자가 개념을 이해한 상태에서 고를 수 있다. 설정을 뒤져 원하는 상태로 만들 필요가 없어진다.
 *
 * 여기서 고르는 값은 전부 Settings 에도 그대로 있는 항목이라, 나중에 언제든 바꿀 수 있다.
 */

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' }
]

/** 선택된 항목을 강조하는 공통 테두리/배경(설정 모달의 테마 선택과 같은 시각 언어). */
function choiceClass(active: boolean): string {
  return (
    'transition-colors border rounded-lg ' +
    (active
      ? 'border-[var(--info-500)] bg-[var(--info-600)]/15 text-neutral-100'
      : 'border-[var(--border)] text-neutral-300 hover:bg-[var(--surface-2)]')
  )
}

export default function PreferencesStep({
  onDone
}: {
  /** 고른 값을 저장하고 온보딩을 끝낸다(모달을 닫는 것은 상위의 설정 갱신). */
  onDone: (patch: Partial<AppSettings>) => void
}): React.JSX.Element {
  const settings = useStore((s) => s.app!.settings)
  const setRightPanelOpen = useStore((s) => s.setRightPanelOpen)

  const [mode, setMode] = useState<PermissionMode>(settings.defaultPermissionMode)
  const [rightPanelOpen, setPanel] = useState(settings.defaultRightPanelOpen)
  const [theme, setTheme] = useState<ThemePreference>(settings.theme)

  // 테마는 고르는 즉시 적용해 실제 모습을 보여준다(설정 모달의 미리보기와 같은 방식).
  const previewTheme = (next: ThemePreference): void => {
    setTheme(next)
    applyTheme(next)
  }

  const finish = (): void => {
    // 고른 패널 상태를 지금 화면에도 즉시 반영한다 — 온보딩을 닫자마자 그 상태로 시작하도록.
    setRightPanelOpen(rightPanelOpen)
    onDone({ defaultPermissionMode: mode, defaultRightPanelOpen: rightPanelOpen, theme })
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60">
      <div className="no-drag w-[520px] max-w-[92vw] max-h-[88vh] flex flex-col bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden">
        <div className="px-6 pt-6 pb-3 text-center">
          <h2 className="text-lg font-semibold text-neutral-100">Make it yours</h2>
          <p className="mt-1.5 text-sm text-neutral-500 leading-relaxed">
            A few defaults to start with. You can change all of these later in{' '}
            <b className="text-neutral-400">Settings</b>.
          </p>
        </div>

        <div className="px-6 py-2 space-y-5 overflow-y-auto">
          <Field
            label="How much can the agent do on its own?"
            hint="Applies to new workspaces. ⇧⇥ switches modes any time during a session."
          >
            <div className="flex flex-col gap-1.5">
              {PERMISSION_ORDER.map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setMode(value)}
                  className={choiceClass(mode === value) + ' text-left px-3 py-2'}
                >
                  <span className="text-sm">{PERMISSION_LABELS[value]}</span>
                  <span className="block text-xs text-neutral-500">
                    {PERMISSION_DESCRIPTIONS[value]}
                  </span>
                </button>
              ))}
            </div>
          </Field>

          <Field
            label="Work panel"
            hint="Files, changes, checks and the terminal. ⌘J toggles it, and your last toggle is remembered from then on."
          >
            <div className="flex gap-1.5">
              <PanelChoice
                active={rightPanelOpen}
                onClick={() => setPanel(true)}
                icon={<PanelRight size={15} />}
                label="Open"
                hint="See changes as they happen"
              />
              <PanelChoice
                active={!rightPanelOpen}
                onClick={() => setPanel(false)}
                icon={<PanelRightClose size={15} />}
                label="Collapsed"
                hint="Full-width chat, fewer distractions"
              />
            </div>
          </Field>

          <Field label="Theme" hint="System follows your OS light/dark setting.">
            <div className="flex gap-1.5">
              {THEME_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => previewTheme(opt.value)}
                  className={choiceClass(theme === opt.value) + ' flex-1 text-sm px-3 py-1.5'}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </Field>
        </div>

        <div className="px-6 py-4 border-t border-[var(--border)] flex justify-end">
          <button className={primaryBtn} onClick={finish}>
            Start using Wooi
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div>
      <div className="mb-2">
        <div className="text-sm font-medium text-neutral-200">{label}</div>
        <div className="text-xs text-neutral-600 leading-relaxed">{hint}</div>
      </div>
      {children}
    </div>
  )
}

function PanelChoice({
  active,
  onClick,
  icon,
  label,
  hint
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
  hint: string
}): React.JSX.Element {
  return (
    <button type="button" onClick={onClick} className={choiceClass(active) + ' flex-1 px-3 py-2'}>
      <span className="flex items-center gap-2 text-sm">
        {icon}
        {label}
      </span>
      <span className="block mt-0.5 text-xs text-neutral-500 text-left">{hint}</span>
    </button>
  )
}
