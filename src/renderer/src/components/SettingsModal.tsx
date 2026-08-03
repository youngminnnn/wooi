import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bell,
  Bot,
  Check,
  ChevronRight,
  Clock,
  Compass,
  Download,
  Info,
  Laptop,
  Link2,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  X
} from 'lucide-react'
import { useStore } from '../store'
import { openRepoSettings } from '../lib/repoSettings'
import { hasNewVersion, scheduledRestartText, updateStatusText } from '../lib/update'
import { useNow } from '../lib/useNow'
import { inputClass } from './Modal'
import IntegrationsPanel from './IntegrationsPanel'
import { permissionModesFor } from '../lib/permission'
import { effortOptionsFor } from '../lib/effort'
import { useAvailableBackends, useBackend, useModels } from '../lib/backends'
import { applyTheme } from '../lib/theme'
import {
  DEFAULT_AGENT_SETTINGS,
  DEFAULT_NOTIFICATION_SETTINGS,
  NOTIFICATION_CHANNEL_LABELS,
  NOTIFICATION_EVENT_LABELS,
  agentSettingsFor,
  experimentsOf,
  normalizePermissionMode
} from '@shared/types'
import type {
  AgentBackendId,
  AgentSettings,
  AppSettings,
  EffortSetting,
  NotificationChannel,
  NotificationEvent,
  NotificationSettings,
  PermissionMode,
  Repo,
  ThemePreference
} from '@shared/types'

type Page = 'general' | 'agents' | 'notifications' | 'integrations' | 'repositories' | 'about'
type SaveState = 'idle' | 'saving' | 'saved' | 'error'
type NotificationPreset = 'recommended' | 'quiet' | 'everything' | 'custom'

const PAGE_KEY = 'settings.lastPage'
const NOTIFICATION_EVENTS: NotificationEvent[] = ['completed', 'error', 'needsInput']
const NOTIFICATION_CHANNELS: NotificationChannel[] = ['osNotification', 'sound', 'badge']
const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' }
]
const PAGES: { id: Page; label: string; icon: typeof Settings2; keywords: string }[] = [
  {
    id: 'general',
    label: 'General',
    icon: Settings2,
    keywords: 'theme appearance panel sidebar workspace creation'
  },
  {
    id: 'agents',
    label: 'Agents',
    icon: Bot,
    keywords: 'model permission reasoning effort fast compact claude codex'
  },
  {
    id: 'notifications',
    label: 'Notifications',
    icon: Bell,
    keywords: 'notification sound badge completed error input'
  },
  {
    id: 'integrations',
    label: 'Integrations',
    icon: Link2,
    keywords: 'login account github claude codex connect'
  },
  {
    id: 'repositories',
    label: 'Repositories',
    icon: Laptop,
    keywords: 'repo setup dev archive carry worktree'
  },
  { id: 'about', label: 'About', icon: Info, keywords: 'version update tour help' }
]

function describeRepoConfig(repo: Repo): string {
  const parts: string[] = []
  if (repo.setupScript.trim()) parts.push('setup')
  if (repo.devScript.trim()) parts.push('dev')
  if (repo.archiveScript.trim()) parts.push('archive')
  if (repo.carryItems.length > 0) parts.push(`${repo.carryItems.length} carried file(s)`)
  return parts.length > 0 ? parts.join(' · ') : 'Nothing configured yet'
}

function sameNotifications(a: NotificationSettings, b: NotificationSettings): boolean {
  return NOTIFICATION_EVENTS.every((event) =>
    NOTIFICATION_CHANNELS.every((channel) => a[event][channel] === b[event][channel])
  )
}

function notificationPreset(value: NotificationSettings): NotificationPreset {
  if (sameNotifications(value, DEFAULT_NOTIFICATION_SETTINGS)) return 'recommended'
  if (
    NOTIFICATION_EVENTS.every(
      (event) => !value[event].osNotification && !value[event].sound && value[event].badge
    )
  )
    return 'quiet'
  if (NOTIFICATION_EVENTS.every((event) => NOTIFICATION_CHANNELS.every((c) => value[event][c])))
    return 'everything'
  return 'custom'
}

function presetNotifications(preset: Exclude<NotificationPreset, 'custom'>): NotificationSettings {
  if (preset === 'recommended') return structuredClone(DEFAULT_NOTIFICATION_SETTINGS)
  const on = preset === 'everything'
  return Object.fromEntries(
    NOTIFICATION_EVENTS.map((event) => [
      event,
      { osNotification: on, sound: on, badge: preset === 'quiet' || on }
    ])
  ) as NotificationSettings
}

export default function SettingsModal({
  onClose,
  onStartTour
}: {
  onClose: () => void
  onStartTour: () => void
}): React.JSX.Element {
  const settings = useStore((s) => s.app!.settings)
  const repos = useStore((s) => s.app!.repos)
  const updateStatus = useStore((s) => s.updateStatus)
  const auth = useStore((s) => s.authStatus)
  const [page, setPageState] = useState<Page>(() => {
    const stored = localStorage.getItem(PAGE_KEY) as Page | null
    return PAGES.some((item) => item.id === stored) ? stored! : 'general'
  })
  const [query, setQuery] = useState('')
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const setPage = (next: Page): void => {
    setPageState(next)
    localStorage.setItem(PAGE_KEY, next)
    setQuery('')
  }

  const save = (patch: Partial<AppSettings>): void => {
    setSaveState('saving')
    if (saveTimer.current) clearTimeout(saveTimer.current)
    void window.api.settings
      .update(patch)
      .then(() => {
        setSaveState('saved')
        saveTimer.current = setTimeout(() => setSaveState('idle'), 1800)
      })
      .catch(() => setSaveState('error'))
  }

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    },
    []
  )

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return []
    return PAGES.filter((item) => `${item.label} ${item.keywords}`.toLowerCase().includes(needle))
  }, [query])

  const integrationWarning = auth
    ? [auth.agents.claude, auth.agents.codex].every((agent) => !agent.loggedIn) ||
      !auth.github.loggedIn
    : false

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/55" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="no-drag bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl w-[900px] max-w-[94vw] h-[680px] max-h-[90vh] flex flex-col overflow-hidden"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="shrink-0 flex items-center justify-between px-5 h-13 border-b border-[var(--border)]">
          <div className="flex items-center gap-3">
            <h3 id="settings-title" className="text-base font-semibold text-neutral-100">
              Settings
            </h3>
            <SaveIndicator state={saveState} />
          </div>
          <button
            onClick={onClose}
            aria-label="Close settings"
            className="h-7 w-7 grid place-items-center rounded-md text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100"
          >
            <X size={15} />
          </button>
        </header>

        <div className="min-h-0 flex flex-1">
          <aside className="w-52 shrink-0 border-r border-[var(--border)] bg-[var(--bg-2)]/35 p-3">
            <div className="relative mb-3">
              <Search size={13} className="absolute left-2.5 top-2.5 text-neutral-600" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search settings"
                aria-label="Search settings"
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] py-2 pl-8 pr-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-[var(--border-strong)]"
              />
            </div>
            <nav className="space-y-0.5" aria-label="Settings categories">
              {(query ? matches : PAGES).map((item) => {
                const Icon = item.icon
                const badge =
                  (item.id === 'about' && hasNewVersion(updateStatus)) ||
                  (item.id === 'integrations' && integrationWarning)
                return (
                  <button
                    key={item.id}
                    onClick={() => setPage(item.id)}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors ${
                      page === item.id && !query
                        ? 'bg-[var(--surface-2)] text-neutral-100'
                        : 'text-neutral-400 hover:bg-[var(--surface-2)]/60 hover:text-neutral-200'
                    }`}
                  >
                    <Icon size={15} />
                    <span>{item.label}</span>
                    {badge && (
                      <span className="ml-auto h-2 w-2 rounded-full bg-[var(--accent-500)]" />
                    )}
                  </button>
                )
              })}
              {query && matches.length === 0 && (
                <p className="px-2 py-3 text-xs leading-relaxed text-neutral-600">
                  No matching settings.
                </p>
              )}
            </nav>
          </aside>

          <main className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
            {page === 'general' && <GeneralPage settings={settings} save={save} />}
            {page === 'agents' && <AgentsPage settings={settings} save={save} />}
            {page === 'notifications' && <NotificationsPage settings={settings} save={save} />}
            {page === 'integrations' && (
              <PageFrame
                title="Integrations"
                description="Connect the tools Wooi uses to run agents and work with pull requests."
              >
                <IntegrationsPanel />
              </PageFrame>
            )}
            {page === 'repositories' && <RepositoriesPage repos={repos} onClose={onClose} />}
            {page === 'about' && <AboutPage onStartTour={onStartTour} />}
          </main>
        </div>
      </div>
    </div>
  )
}

function SaveIndicator({ state }: { state: SaveState }): React.JSX.Element | null {
  if (state === 'idle') return null
  return (
    <span
      className={`flex items-center gap-1 text-xs ${state === 'error' ? 'text-[var(--danger-400)]' : 'text-neutral-500'}`}
    >
      {state === 'saving' && <RefreshCw size={11} className="animate-spin" />}
      {state === 'saved' && <Check size={11} className="text-[var(--success-400)]" />}
      {state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : 'Could not save'}
    </span>
  )
}

function PageFrame({
  title,
  description,
  children
}: {
  title: string
  description: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="mx-auto max-w-2xl">
      <h2 className="text-xl font-semibold text-neutral-100">{title}</h2>
      <p className="mt-1 mb-6 text-sm text-neutral-500">{description}</p>
      <div className="space-y-6">{children}</div>
    </div>
  )
}

function SettingGroup({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="overflow-hidden rounded-xl border border-[var(--border)]">
      <h3 className="border-b border-[var(--border)] bg-[var(--bg-2)]/45 px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-neutral-500">
        {title}
      </h3>
      <div className="divide-y divide-[var(--border)]">{children}</div>
    </section>
  )
}

function SettingRow({
  title,
  description,
  children
}: {
  title: string
  description?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3.5">
      <div className="min-w-0">
        <div className="text-sm font-medium text-neutral-200">{title}</div>
        {description && (
          <p className="mt-0.5 text-xs leading-relaxed text-neutral-600">{description}</p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function Switch({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 rounded-full transition-colors ${checked ? 'bg-[var(--info-600)]' : 'bg-[var(--border-2)]'}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : 'translate-x-0'}`}
      />
    </button>
  )
}

function GeneralPage({
  settings,
  save
}: {
  settings: AppSettings
  save: (patch: Partial<AppSettings>) => void
}): React.JSX.Element {
  const changeTheme = (theme: ThemePreference): void => {
    applyTheme(theme)
    save({ theme })
  }
  // 저장된 설정에 항목이 없을 수 있으므로(구버전에서 올라옴) 항상 기본값과 병합해 읽는다.
  const experiments = experimentsOf(settings)
  return (
    <PageFrame title="General" description="Choose how Wooi looks and how new workspaces start.">
      <SettingGroup title="Appearance">
        <SettingRow title="Theme" description="System follows your operating system appearance.">
          <div className="flex gap-1 rounded-lg bg-[var(--bg-2)] p-1">
            {THEME_OPTIONS.map((option) => (
              <button
                key={option.value}
                onClick={() => changeTheme(option.value)}
                className={`rounded-md px-3 py-1 text-xs ${settings.theme === option.value ? 'bg-[var(--surface-2)] text-neutral-100 shadow-sm' : 'text-neutral-500 hover:text-neutral-300'}`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </SettingRow>
        <SettingRow
          title="Work panel on launch"
          description="Used until you manually toggle the files, changes, or terminal panel."
        >
          <Switch
            label="Work panel on launch"
            checked={settings.defaultRightPanelOpen}
            onChange={(value) => save({ defaultRightPanelOpen: value })}
          />
        </SettingRow>
        <SettingRow
          title="Running agents in sidebar"
          description="Show active subagents below each workspace. Tracking continues when hidden."
        >
          <Switch
            label="Running agents in sidebar"
            checked={settings.showRunningAgents}
            onChange={(value) => save({ showRunningAgents: value })}
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Workspace creation">
        <SettingRow
          title="New workspace setup"
          description="This only affects workspaces created from now on."
        >
          <select
            className={inputClass + ' w-52 text-sm'}
            value={settings.manualWorkspaceSetup ? 'manual' : 'automatic'}
            onChange={(event) => save({ manualWorkspaceSetup: event.target.value === 'manual' })}
          >
            <option value="automatic">Create automatically</option>
            <option value="manual">Ask for name and branch</option>
          </select>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Experimental">
        <SettingRow
          title="Multi-agent delegation"
          description="Let a workspace hand tasks to a different coding agent — Claude Code delegating to Codex, or the reverse. Rough edges expected."
        >
          <Switch
            label="Multi-agent delegation"
            checked={experiments.multiAgent}
            // 실험 스위치는 켜고 끄는 즉시 다음 세션부터 반영된다. 이미 만들어 둔 멀티 에이전트
            // 워크스페이스의 설정은 지우지 않으므로, 껐다 켜면 그대로 살아난다.
            onChange={(value) => save({ experiments: { ...experiments, multiAgent: value } })}
          />
        </SettingRow>
      </SettingGroup>
    </PageFrame>
  )
}

function AgentsPage({
  settings,
  save
}: {
  settings: AppSettings
  save: (patch: Partial<AppSettings>) => void
}): React.JSX.Element {
  const availableBackends = useAvailableBackends()
  const experiments = experimentsOf(settings)
  const [editing, setEditing] = useState<AgentBackendId>(settings.defaultAgentBackend)
  // 멀티 항목은 조율할 수 있는 백엔드에만 있다. 저장된 조합이 그렇지 않으면(설정 손편집, 실험을
  // 끈 뒤, 나중에 capability 가 바뀐 경우) 존재하지 않는 value 를 가리켜 select 가 빈 칸이 되므로,
  // 그때는 평범한 백엔드 선택으로 되돌려 보여 준다.
  const multiOption =
    experiments.multiAgent &&
    settings.defaultMultiAgent === true &&
    availableBackends.some((b) => b.id === settings.defaultAgentBackend && b.capabilities.delegate)
  const backend = useBackend(editing)
  const models = useModels(editing)
  const agent = agentSettingsFor(settings, editing)
  const mode = backend ? normalizePermissionMode(backend, agent.permissionMode) : null
  const selectedModel = models.find((model) => model.id === agent.model)
  const efforts = effortOptionsFor(backend, selectedModel)
  const patchAgent = (patch: Partial<AgentSettings>): void =>
    save({ agents: { ...settings.agents, [editing]: { ...agent, ...patch } } })
  const resetAgent = (): void => patchAgent(DEFAULT_AGENT_SETTINGS)

  return (
    <PageFrame
      title="Agents"
      description="Defaults for new workspaces. Existing workspaces keep their current agent and can override model settings."
    >
      {availableBackends.length > 1 && (
        <SettingGroup title="Default agent">
          <SettingRow
            title="Agent for new workspaces"
            description={
              multiOption
                ? 'New workspaces start in multi-agent mode — the main agent can run tasks with other agents. Each workspace keeps the agent it was created with.'
                : 'Each workspace stays with the agent it was created with.'
            }
          >
            <select
              className={inputClass + ' w-60 text-sm'}
              value={
                multiOption ? `multi:${settings.defaultAgentBackend}` : settings.defaultAgentBackend
              }
              onChange={(event) => {
                // 값 하나에 두 설정을 실어 보낸다 — 사용자에게는 한 줄의 선택이지만 저장은
                // 메인 에이전트와 모드로 나뉜다(둘은 직교한다).
                const raw = event.target.value
                const multiAgent = raw.startsWith('multi:')
                const next = (multiAgent ? raw.slice('multi:'.length) : raw) as AgentBackendId
                setEditing(next)
                save({ defaultAgentBackend: next, defaultMultiAgent: multiAgent })
              }}
            >
              {availableBackends.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
              {/* 멀티 에이전트는 메인 에이전트를 함께 정해야 의미가 있으므로, 조율할 수 있는
                  백엔드마다 한 줄씩 낸다 — "Multi-agent" 만 있으면 대화 상대가 누구인지 감춰진다. */}
              {experiments.multiAgent &&
                availableBackends
                  .filter((item) => item.capabilities.delegate)
                  .map((item) => (
                    <option key={`multi:${item.id}`} value={`multi:${item.id}`}>
                      Multi-agent · {item.label}
                    </option>
                  ))}
            </select>
          </SettingRow>
        </SettingGroup>
      )}

      <div className="flex items-center justify-between">
        <div className="flex gap-1 rounded-lg bg-[var(--bg-2)] p-1">
          {availableBackends.map((item) => (
            <button
              key={item.id}
              onClick={() => setEditing(item.id)}
              className={`rounded-md px-3 py-1.5 text-sm ${editing === item.id ? 'bg-[var(--surface-2)] text-neutral-100 shadow-sm' : 'text-neutral-500 hover:text-neutral-300'}`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button
          onClick={resetAgent}
          className="flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-300"
        >
          <RotateCcw size={12} /> Reset {backend?.label ?? 'agent'} defaults
        </button>
      </div>

      <SettingGroup title={`${backend?.label ?? 'Agent'} defaults`}>
        <SettingRow
          title="Permission mode"
          description="Controls how much the agent can do without asking. You can cycle it with ⇧⇥ during a session."
        >
          <select
            className={inputClass + ' w-56 text-sm'}
            value={mode ?? ''}
            disabled={!backend}
            onChange={(event) =>
              patchAgent({ permissionMode: event.target.value as PermissionMode })
            }
          >
            {permissionModesFor(backend).map((item) => (
              <option key={item.id} value={item.id}>
                {item.label} — {item.description}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow title="Model" description="Workspace override available">
          <select
            className={inputClass + ' w-56 text-sm'}
            value={agent.model ?? ''}
            onChange={(event) => patchAgent({ model: event.target.value || null })}
          >
            <option value="">Default — let {backend?.label ?? 'agent'} decide</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
            {agent.model && !models.some((model) => model.id === agent.model) && (
              <option value={agent.model}>{agent.model}</option>
            )}
          </select>
        </SettingRow>
        <SettingRow
          title="Reasoning effort"
          description="Higher effort is slower but more thorough. Workspace override available."
        >
          <select
            className={inputClass + ' w-56 text-sm'}
            value={agent.effort ?? ''}
            onChange={(event) =>
              patchAgent({ effort: (event.target.value || null) as EffortSetting | null })
            }
          >
            <option value="">Default — let the model decide</option>
            {efforts.map((effort) => (
              <option key={effort.id} value={effort.id}>
                {effort.label} — {effort.hint}
              </option>
            ))}
          </select>
        </SettingRow>
        {backend?.capabilities.fastMode && (
          <SettingRow
            title="Fast mode"
            description="Uses the backend’s faster service tier. Availability and billing depend on your account."
          >
            <Switch
              label="Fast mode"
              checked={agent.fastMode}
              onChange={(value) => patchAgent({ fastMode: value })}
            />
          </SettingRow>
        )}
      </SettingGroup>

      <SettingGroup title="Conversations">
        <SettingRow
          title="Auto-compact long conversations"
          description="A global Wooi setting. Summarizes context near its limit so sessions can continue."
        >
          <Switch
            label="Auto-compact long conversations"
            checked={settings.autoCompact}
            onChange={(value) => save({ autoCompact: value })}
          />
        </SettingRow>
      </SettingGroup>
    </PageFrame>
  )
}

function NotificationsPage({
  settings,
  save
}: {
  settings: AppSettings
  save: (patch: Partial<AppSettings>) => void
}): React.JSX.Element {
  const preset = notificationPreset(settings.notifications)
  const update = (notifications: NotificationSettings): void =>
    save({ notifications, soundOnComplete: notifications.completed.sound })
  const toggle = (event: NotificationEvent, channel: NotificationChannel): void =>
    update({
      ...settings.notifications,
      [event]: {
        ...settings.notifications[event],
        [channel]: !settings.notifications[event][channel]
      }
    })
  return (
    <PageFrame
      title="Notifications"
      description="Choose a simple preset or customize how each event gets your attention. Individual workspaces can be muted from the sidebar."
    >
      <div className="grid grid-cols-4 gap-2">
        {(['recommended', 'quiet', 'everything', 'custom'] as NotificationPreset[]).map((item) => (
          <button
            key={item}
            disabled={item === 'custom'}
            onClick={() => item !== 'custom' && update(presetNotifications(item))}
            className={`rounded-lg border px-3 py-2 text-sm capitalize transition-colors ${preset === item ? 'border-[var(--info-500)] bg-[var(--info-600)]/15 text-neutral-100' : 'border-[var(--border)] text-neutral-500 hover:bg-[var(--surface-2)] hover:text-neutral-300'} disabled:cursor-default`}
          >
            {item}
          </button>
        ))}
      </div>
      <div className="overflow-hidden rounded-xl border border-[var(--border)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] bg-[var(--bg-2)]/50">
              <th className="px-4 py-2.5 text-left font-medium text-neutral-400">Event</th>
              {NOTIFICATION_CHANNELS.map((channel) => (
                <th key={channel} className="px-3 py-2.5 text-center font-medium text-neutral-400">
                  {NOTIFICATION_CHANNEL_LABELS[channel]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {NOTIFICATION_EVENTS.map((event) => (
              <tr key={event} className="border-b border-[var(--border)] last:border-0">
                <td className="px-4 py-3 text-neutral-300">{NOTIFICATION_EVENT_LABELS[event]}</td>
                {NOTIFICATION_CHANNELS.map((channel) => (
                  <td key={channel} className="p-1 text-center">
                    <button
                      aria-label={`${NOTIFICATION_EVENT_LABELS[event]} — ${NOTIFICATION_CHANNEL_LABELS[channel]}`}
                      onClick={() => toggle(event, channel)}
                      className="grid h-9 w-full place-items-center rounded-md hover:bg-[var(--surface-2)]"
                    >
                      <span
                        className={`grid h-4 w-4 place-items-center rounded border ${settings.notifications[event][channel] ? 'border-[var(--info-500)] bg-[var(--info-600)] text-white' : 'border-[var(--border-2)]'}`}
                      >
                        {settings.notifications[event][channel] && <Check size={11} />}
                      </span>
                    </button>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs leading-relaxed text-neutral-600">
        OS notifications appear only while Wooi is in the background. If macOS notifications are
        disabled, allow Wooi in System Settings → Notifications.
      </p>
      <button
        onClick={() => update(structuredClone(DEFAULT_NOTIFICATION_SETTINGS))}
        className="flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-300"
      >
        <RotateCcw size={12} /> Reset notification defaults
      </button>
    </PageFrame>
  )
}

function RepositoriesPage({
  repos,
  onClose
}: {
  repos: Repo[]
  onClose: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [configuredOnly, setConfiguredOnly] = useState(false)
  const filtered = repos.filter((repo) => {
    const configured = describeRepoConfig(repo) !== 'Nothing configured yet'
    return (!configuredOnly || configured) && repo.name.toLowerCase().includes(query.toLowerCase())
  })
  return (
    <PageFrame
      title="Repositories"
      description="Setup, dev and archive commands—and files carried into new worktrees—are configured per repository."
    >
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-2.5 text-neutral-600" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search repositories"
            className={inputClass + ' py-2 pl-9 text-sm'}
          />
        </div>
        <button
          onClick={() => setConfiguredOnly((value) => !value)}
          className={`rounded-lg border px-3 text-xs ${configuredOnly ? 'border-[var(--info-500)] bg-[var(--info-600)]/15 text-neutral-200' : 'border-[var(--border)] text-neutral-500'}`}
        >
          Configured only
        </button>
      </div>
      <div className="overflow-hidden rounded-xl border border-[var(--border)] divide-y divide-[var(--border)]">
        {filtered.map((repo) => (
          <button
            key={repo.id}
            onClick={() => {
              onClose()
              openRepoSettings(repo.id)
            }}
            className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-[var(--surface-2)]"
          >
            <Settings2 size={15} className="text-neutral-500" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-neutral-200">
                {repo.name}
              </span>
              <span className="block truncate text-xs text-neutral-600">
                {describeRepoConfig(repo)}
              </span>
            </span>
            <ChevronRight size={15} className="text-neutral-600" />
          </button>
        ))}
        {filtered.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-neutral-600">
            {repos.length === 0
              ? 'No repositories yet — add one from the sidebar.'
              : 'No matching repositories.'}
          </p>
        )}
      </div>
    </PageFrame>
  )
}

function AboutPage({ onStartTour }: { onStartTour: () => void }): React.JSX.Element {
  return (
    <PageFrame
      title="About"
      description="Version information, updates, and help getting around Wooi."
    >
      <UpdatesSection />
      <button
        type="button"
        onClick={onStartTour}
        className="flex w-full items-center gap-3 rounded-xl border border-[var(--border)] px-4 py-3 text-left text-neutral-300 hover:bg-[var(--surface-2)] hover:text-neutral-100"
      >
        <Compass size={17} className="text-[var(--info-400)]" />
        <span className="text-sm font-medium">
          Take a tour
          <span className="mt-0.5 block text-xs font-normal text-neutral-600">
            Revisit the quick introduction to Wooi’s main features.
          </span>
        </span>
        <ChevronRight size={15} className="ml-auto text-neutral-600" />
      </button>
    </PageFrame>
  )
}

const DOWNLOAD_URL = 'https://github.com/youngminnnn/wooi/releases/latest/download/Wooi-arm64.dmg'

function UpdatesSection(): React.JSX.Element {
  const [version, setVersion] = useState('')
  const status = useStore((s) => s.updateStatus)
  useEffect(() => {
    void window.api.app.getVersion().then(setVersion)
  }, [])
  // 카운트다운이 걸린 동안만 초 단위로 다시 그린다(배너와 같은 규칙).
  const now = useNow(1000, !!status.restartAt)
  const checking = status.state === 'checking'
  const isNew = hasNewVersion(status)
  const scheduled = !!status.restartWhenIdle
  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-3 ${isNew ? 'border-[var(--accent-500)]/40 bg-[var(--accent-500)]/10' : 'border-[var(--border)]'}`}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm text-neutral-300">
          Wooi <span className="text-neutral-500">v{version || '…'}</span>
          {isNew && (
            <span className="rounded bg-[var(--accent-500)]/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--accent-300)]">
              New version
            </span>
          )}
        </div>
        {status.state !== 'idle' && (
          <div
            className={`mt-0.5 text-xs ${status.state === 'blocked' ? 'text-[var(--warning-300)]' : 'text-neutral-600'}`}
          >
            {updateStatusText(status)}
          </div>
        )}
        {scheduled && (
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-[var(--accent-300)]">
            <Clock size={12} /> {scheduledRestartText(status, now)}
          </div>
        )}
      </div>
      {status.state === 'blocked' ? (
        <button
          onClick={() => void window.api.openExternal(DOWNLOAD_URL)}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-neutral-300 hover:bg-[var(--surface-2)]"
        >
          <Download size={14} /> Download latest
        </button>
      ) : status.state === 'ready' ? (
        // 지금 재시작하면 진행 중인 턴이 끊긴다 — 자리를 비울 때를 위해 "다 끝나면" 예약을 나란히 둔다.
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={() => void window.api.update.setRestartWhenIdle(!scheduled)}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm ${
              scheduled
                ? 'border-[var(--accent-500)]/50 text-[var(--accent-300)]'
                : 'border-[var(--border)] text-neutral-300 hover:bg-[var(--surface-2)]'
            }`}
          >
            <Clock size={14} /> {scheduled ? 'Cancel schedule' : 'When work finishes'}
          </button>
          <button
            onClick={() => window.api.update.quitAndInstall()}
            className="flex items-center gap-1.5 rounded-lg border border-[var(--accent-500)] bg-[var(--accent-600)]/15 px-3 py-1.5 text-sm text-neutral-100"
          >
            <RefreshCw size={14} /> Restart & update
          </button>
        </div>
      ) : (
        <button
          onClick={() => void window.api.update.check()}
          disabled={checking}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-neutral-300 hover:bg-[var(--surface-2)] disabled:opacity-50"
        >
          <RefreshCw size={14} className={checking ? 'animate-spin' : ''} /> Check for updates
        </button>
      )}
    </div>
  )
}
