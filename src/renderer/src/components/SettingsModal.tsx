import { useState } from 'react'
import { Compass } from 'lucide-react'
import { useStore } from '../store'
import Modal, { inputClass, labelClass, primaryBtn, ghostBtn } from './Modal'
import IntegrationsPanel from './IntegrationsPanel'
import { PERMISSION_ORDER, PERMISSION_LABELS, PERMISSION_DESCRIPTIONS } from '../lib/permission'
import { MODEL_OPTIONS } from '../lib/models'
import { EFFORT_OPTIONS } from '../lib/effort'
import { applyTheme } from '../lib/theme'
import { NOTIFICATION_CHANNEL_LABELS, NOTIFICATION_EVENT_LABELS } from '@shared/types'
import type {
  EffortSetting,
  NotificationChannel,
  NotificationEvent,
  NotificationSettings,
  PermissionMode,
  ThemePreference
} from '@shared/types'

const NOTIFICATION_EVENTS: NotificationEvent[] = ['completed', 'error', 'needsInput']
const NOTIFICATION_CHANNELS: NotificationChannel[] = ['osNotification', 'sound', 'badge']

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' }
]

export default function SettingsModal({
  onClose,
  onStartTour
}: {
  onClose: () => void
  onStartTour: () => void
}): React.JSX.Element {
  const settings = useStore((s) => s.app!.settings)
  const [mode, setMode] = useState<PermissionMode>(settings.defaultPermissionMode)
  const [manualWorkspaceSetup, setManualWorkspaceSetup] = useState(settings.manualWorkspaceSetup)
  const [notifications, setNotifications] = useState<NotificationSettings>(settings.notifications)
  const [autoCompact, setAutoCompact] = useState(settings.autoCompact)

  const toggleNotification = (event: NotificationEvent, channel: NotificationChannel): void =>
    setNotifications((n) => ({
      ...n,
      [event]: { ...n[event], [channel]: !n[event][channel] }
    }))
  const [defaultRightPanelOpen, setDefaultRightPanelOpen] = useState(settings.defaultRightPanelOpen)
  const [model, setModel] = useState(settings.model ?? MODEL_OPTIONS[0].id)
  const [effort, setEffort] = useState<EffortSetting | null>(settings.effort)
  const [theme, setTheme] = useState<ThemePreference>(settings.theme)

  // 테마는 즉시 미리보기로 적용한다. 저장 없이 닫으면 저장된 테마로 되돌린다.
  const previewTheme = (next: ThemePreference): void => {
    setTheme(next)
    applyTheme(next)
  }
  const cancel = (): void => {
    if (theme !== settings.theme) applyTheme(settings.theme)
    onClose()
  }

  const save = async (): Promise<void> => {
    await window.api.settings.update({
      defaultPermissionMode: mode,
      manualWorkspaceSetup,
      notifications,
      // 하위호환: 레거시 soundOnComplete 를 완료 소리 채널과 동기화해 둔다.
      soundOnComplete: notifications.completed.sound,
      autoCompact,
      defaultRightPanelOpen,
      model,
      effort,
      theme
    })
    onClose()
  }

  return (
    <Modal
      title="Settings"
      onClose={cancel}
      width={560}
      footer={
        <>
          <button className={ghostBtn} onClick={cancel}>
            Cancel
          </button>
          <button className={primaryBtn} onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="space-y-5">
        <Section title="Integrations">
          <IntegrationsPanel />
        </Section>

        <Section title="Getting started">
          <button
            type="button"
            onClick={onStartTour}
            className="flex items-center gap-2.5 w-full text-left px-3 py-2.5 rounded-lg border border-[var(--border)] text-neutral-300 hover:bg-[var(--surface-2)] hover:text-neutral-100 transition-colors"
          >
            <Compass size={16} className="text-[var(--info-400)]" />
            <span className="text-sm">
              Take a tour
              <span className="block text-xs text-neutral-600">
                Revisit the quick intro to Ditto&rsquo;s main features.
              </span>
            </span>
          </button>
        </Section>

        <Section title="Appearance">
          <div>
            <label className={labelClass}>Theme</label>
            <div className="flex gap-1.5">
              {THEME_OPTIONS.map((opt) => {
                const active = theme === opt.value
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => previewTheme(opt.value)}
                    className={
                      'flex-1 text-sm px-3 py-1.5 rounded-lg border transition-colors ' +
                      (active
                        ? 'border-[var(--info-500)] bg-[var(--info-600)]/15 text-neutral-100'
                        : 'border-[var(--border)] text-neutral-300 hover:bg-[var(--surface-2)]')
                    }
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>
            <p className="mt-1.5 text-xs text-neutral-600">
              System follows your OS light/dark setting.
            </p>
          </div>

          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={defaultRightPanelOpen}
              onChange={(e) => setDefaultRightPanelOpen(e.target.checked)}
              className="accent-blue-600 h-3.5 w-3.5 mt-0.5"
            />
            <span className="text-sm text-neutral-300">
              Show the work panel by default
              <span className="block text-xs text-neutral-600">
                Starting state for the right-side work panel (files, changes, terminal). Toggling it
                with ⌘J is remembered and takes over from here.
              </span>
            </span>
          </label>
        </Section>

        <Section title="Workspaces">
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={manualWorkspaceSetup}
              onChange={(e) => setManualWorkspaceSetup(e.target.checked)}
              className="accent-blue-600 h-3.5 w-3.5 mt-0.5"
            />
            <span className="text-sm text-neutral-300">
              Choose name & base branch manually
              <span className="block text-xs text-neutral-600">
                Off: auto-generate a name and branch from the repo&rsquo;s default branch (main).
              </span>
            </span>
          </label>
        </Section>

        <Section title="Notifications">
          <p className="text-xs text-neutral-500 -mt-1">
            Choose how each event notifies you. OS notifications only appear when the window is in
            the background. Mute individual workspaces from the sidebar.
          </p>
          <div className="overflow-hidden rounded-lg border border-[var(--border)]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--surface-2)]/50">
                  <th className="px-3 py-2 text-left font-medium text-neutral-400">Event</th>
                  {NOTIFICATION_CHANNELS.map((c) => (
                    <th
                      key={c}
                      className="px-2 py-2 text-center font-medium text-neutral-400 whitespace-nowrap"
                    >
                      {NOTIFICATION_CHANNEL_LABELS[c]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {NOTIFICATION_EVENTS.map((event) => (
                  <tr key={event} className="border-b border-[var(--border)] last:border-0">
                    <td className="px-3 py-2 text-neutral-300">
                      {NOTIFICATION_EVENT_LABELS[event]}
                    </td>
                    {NOTIFICATION_CHANNELS.map((channel) => (
                      <td key={channel} className="px-2 py-2 text-center">
                        <input
                          type="checkbox"
                          aria-label={`${NOTIFICATION_EVENT_LABELS[event]} — ${NOTIFICATION_CHANNEL_LABELS[channel]}`}
                          checked={notifications[event][channel]}
                          onChange={() => toggleNotification(event, channel)}
                          className="accent-blue-600 h-3.5 w-3.5 align-middle cursor-pointer"
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section title="Agent">
          <div>
            <label className={labelClass}>Default permission mode for new workspaces</label>
            <select
              className={inputClass}
              value={mode}
              onChange={(e) => setMode(e.target.value as PermissionMode)}
            >
              {PERMISSION_ORDER.map((m) => (
                <option key={m} value={m}>
                  {PERMISSION_LABELS[m]} — {PERMISSION_DESCRIPTIONS[m]}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-xs text-neutral-600">
              Press ⇧⇥ in a session to cycle the mode.
            </p>
          </div>

          <div>
            <label className={labelClass}>Model</label>
            <select className={inputClass} value={model} onChange={(e) => setModel(e.target.value)}>
              {MODEL_OPTIONS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
              {!MODEL_OPTIONS.some((m) => m.id === model) && <option value={model}>{model}</option>}
            </select>
            <p className="mt-1.5 text-xs text-neutral-600">
              Default for new workspaces. Each workspace can override this from its header dropdown.
            </p>
          </div>

          <div>
            <label className={labelClass}>Reasoning effort</label>
            <select
              className={inputClass}
              value={effort ?? ''}
              onChange={(e) => setEffort((e.target.value || null) as EffortSetting | null)}
            >
              <option value="">Default — let the model decide</option>
              {EFFORT_OPTIONS.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label} — {e.hint}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-xs text-neutral-600">
              How hard the agent thinks before responding. Higher is slower but more thorough. Each
              workspace can override this from its header dropdown.
            </p>
          </div>

          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={autoCompact}
              onChange={(e) => setAutoCompact(e.target.checked)}
              className="accent-blue-600 h-3.5 w-3.5 mt-0.5"
            />
            <span className="text-sm text-neutral-300">
              Auto-compact conversation when context fills
              <span className="block text-xs text-neutral-600">
                Summarizes the conversation as it approaches the context limit so long sessions keep
                room to continue.
              </span>
            </span>
          </label>
        </Section>
      </div>
    </Modal>
  )
}

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="space-y-3">
      <h4 className="text-xs uppercase tracking-wider text-neutral-500 font-semibold">{title}</h4>
      {children}
    </div>
  )
}
