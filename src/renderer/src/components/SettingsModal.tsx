import { useEffect, useState } from 'react'
import { Compass, Download, RefreshCw } from 'lucide-react'
import { useStore } from '../store'
import { hasNewVersion, updateStatusText } from '../lib/update'
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
  const [showRunningAgents, setShowRunningAgents] = useState(settings.showRunningAgents)
  const [model, setModel] = useState(settings.model ?? MODEL_OPTIONS[0].id)
  const [effort, setEffort] = useState<EffortSetting | null>(settings.effort)
  const [fastMode, setFastMode] = useState(settings.fastMode)
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
      showRunningAgents,
      model,
      effort,
      fastMode,
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
        {/* 버전·업데이트를 맨 위에 둔다 — 타이틀바의 점을 보고 들어온 사용자가 바로 확인할 수 있게. */}
        <Section title="About">
          <UpdatesSection />
        </Section>

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
                Revisit the quick intro to Wooi&rsquo;s main features.
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

          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={showRunningAgents}
              onChange={(e) => setShowRunningAgents(e.target.checked)}
              className="accent-blue-600 h-3.5 w-3.5 mt-0.5"
            />
            <span className="text-sm text-neutral-300">
              Show running agents in the sidebar
              <span className="block text-xs text-neutral-600">
                Lists the subagents each workspace is running right now, under its sidebar row. Each
                list can also be collapsed individually.
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
              checked={fastMode}
              onChange={(e) => setFastMode(e.target.checked)}
              className="accent-blue-600 h-3.5 w-3.5 mt-0.5"
            />
            <span className="text-sm text-neutral-300">
              Fast mode
              <span className="block text-xs text-neutral-600">
                Runs the same model with faster output (Claude Code’s <code>/fast</code>). Needs a
                fast-capable model (Opus 5 or Opus 4.8) on a paid Anthropic plan, and has its own
                rate limit — sessions fall back to standard speed when it isn’t available. Each
                workspace can override this with <code>/fast</code>.
              </span>
            </span>
          </label>

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

/** 항상 최신 릴리스의 dmg 로 리다이렉트된다(자동 업데이트가 막혔을 때의 수동 경로). */
const DOWNLOAD_URL = 'https://github.com/youngminnnn/wooi/releases/latest/download/Wooi-arm64.dmg'

function UpdatesSection(): React.JSX.Element {
  const [version, setVersion] = useState<string>('')
  // 상태는 store 한 곳에서 구독한다 — 모달을 늦게 열어도 이미 지나간 방송을 놓치지 않는다.
  const status = useStore((s) => s.updateStatus)

  useEffect(() => {
    window.api.app.getVersion().then(setVersion)
  }, [])

  const checking = status.state === 'checking'
  // 확인 진행·결과는 main 이 evtUpdate 로 방송하므로 store 가 알아서 갱신된다.
  const check = (): void => void window.api.update.check()
  const isNew = hasNewVersion(status)

  return (
    <div
      className={
        'flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 ' +
        (isNew
          ? 'border-[var(--accent-500)]/40 bg-[var(--accent-500)]/10'
          : 'border-[var(--border)]')
      }
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm text-neutral-300">
          Wooi <span className="text-neutral-500">v{version || '…'}</span>
          {isNew && (
            <span className="shrink-0 text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-[var(--accent-500)]/20 text-[var(--accent-300)]">
              New version
            </span>
          )}
        </div>
        {status.state !== 'idle' && (
          <div
            className={`text-xs mt-0.5 ${
              status.state === 'blocked'
                ? 'text-amber-500/90 leading-relaxed'
                : 'text-neutral-600 truncate'
            }`}
          >
            {updateStatusText(status)}
          </div>
        )}
      </div>
      {status.state === 'blocked' ? (
        <button
          type="button"
          onClick={() => void window.api.openExternal(DOWNLOAD_URL)}
          className="shrink-0 inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-[var(--border)] text-neutral-300 hover:bg-[var(--surface-2)] transition-colors"
        >
          <Download size={14} />
          Download latest
        </button>
      ) : status.state === 'ready' ? (
        <button
          type="button"
          onClick={() => window.api.update.quitAndInstall()}
          className="shrink-0 inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-[var(--accent-500)] bg-[var(--accent-600)]/15 text-neutral-100 hover:bg-[var(--accent-600)]/25 transition-colors"
        >
          <RefreshCw size={14} />
          Restart & update
        </button>
      ) : (
        <button
          type="button"
          onClick={check}
          disabled={checking}
          className="shrink-0 inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-[var(--border)] text-neutral-300 hover:bg-[var(--surface-2)] disabled:opacity-50 transition-colors"
        >
          <RefreshCw size={14} className={checking ? 'animate-spin' : ''} />
          Check for updates
        </button>
      )}
    </div>
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
