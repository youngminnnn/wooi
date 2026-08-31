import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bell,
  Blocks,
  Bot,
  Check,
  ChevronRight,
  Clock,
  Compass,
  Download,
  Eye,
  EyeOff,
  Info,
  Laptop,
  Link2,
  Plug,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Trash2,
  X
} from 'lucide-react'
import { useStore } from '../store'
import { openRepoSettings } from '../lib/repoSettings'
import { openMigrate } from '../lib/migrate'
import { hasNewVersion, scheduledRestartText, updateStatusText } from '../lib/update'
import { useNow } from '../lib/useNow'
import { inputClass } from './Modal'
import IntegrationsPanel from './IntegrationsPanel'
import RemoteAccessPanel from './RemoteAccessPanel'
import McpServersPage from './McpServersPage'
import PluginsPage from './PluginsPage'
import { PageFrame, SettingGroup, SettingRow, Switch } from './SettingsPrimitives'
import { permissionModesFor } from '../lib/permission'
import { effortOptionsFor } from '../lib/effort'
import { useAvailableBackends, useBackend, useModels } from '../lib/backends'
import { applyTheme } from '../lib/theme'
import { SETTINGS_PAGE_KEY, type SettingsPage } from '../lib/settingsNavigation'
import {
  DEFAULT_AGENT_SETTINGS,
  DEFAULT_NOTIFICATION_SETTINGS,
  NOTIFICATION_CHANNEL_LABELS,
  NOTIFICATION_EVENT_LABELS,
  NOTIFICATION_SKIP_LABELS,
  agentSettingsFor,
  isBlockedAgentEnvKey,
  isValidAgentEnvKey,
  normalizePermissionMode
} from '@shared/types'
import type {
  AgentBackendId,
  AgentBackendMeta,
  AgentSettings,
  AppSettings,
  EffortSetting,
  NotificationChannel,
  NotificationEvent,
  NotificationSettings,
  NotificationSkip,
  PermissionMode,
  Repo,
  ThemePreference
} from '@shared/types'

type Page = SettingsPage
type SaveState = 'idle' | 'saving' | 'saved' | 'error'
type NotificationPreset = 'recommended' | 'quiet' | 'everything' | 'custom'

const NOTIFICATION_EVENTS: NotificationEvent[] = ['completed', 'error', 'needsInput']
const NOTIFICATION_CHANNELS: NotificationChannel[] = ['osNotification', 'sound', 'badge']
const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' }
]

function PermissionModeHelp({
  backend
}: {
  backend: AgentBackendMeta | undefined
}): React.JSX.Element {
  return (
    <details className="group relative">
      <summary
        className="grid h-7 w-7 cursor-pointer list-none place-items-center rounded-full border border-[var(--border)] text-xs font-medium text-neutral-500 transition-colors hover:border-[var(--border-2)] hover:bg-[var(--surface-2)] hover:text-neutral-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--info-500)] [&::-webkit-details-marker]:hidden"
        aria-label="About permission modes"
      >
        ?
      </summary>
      <div className="absolute right-0 z-30 mt-2 w-80 rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] p-3 shadow-xl">
        <div className="mb-2 text-xs font-medium text-neutral-300">Permission modes</div>
        <div className="space-y-2.5">
          {permissionModesFor(backend).map((item) => (
            <div key={item.id}>
              <div className="text-xs font-medium text-neutral-300">{item.label}</div>
              <div className="mt-0.5 text-xs leading-relaxed text-neutral-500">
                {item.description}
              </div>
            </div>
          ))}
        </div>
      </div>
    </details>
  )
}
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
    id: 'mcp',
    label: 'MCP servers',
    icon: Plug,
    keywords: 'mcp model context protocol server tool stdio http sse claude.json'
  },
  {
    id: 'plugins',
    label: 'Plugins',
    icon: Blocks,
    keywords: 'plugin marketplace codex agent skill hook extension install'
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
  if (repo.runScripts.length) parts.push(`${repo.runScripts.length} run script(s)`)
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
    const stored = localStorage.getItem(SETTINGS_PAGE_KEY) as Page | null
    return PAGES.some((item) => item.id === stored) ? stored! : 'general'
  })
  const [query, setQuery] = useState('')
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // 위에 confirm 대화상자가 떠 있으면 그 대화상자만 닫고 설정은 유지한다.
      if (event.key === 'Escape' && !useStore.getState().confirmState) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const setPage = (next: Page): void => {
    setPageState(next)
    localStorage.setItem(SETTINGS_PAGE_KEY, next)
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
                {/* 원격 접근도 "외부와 연결"이라는 점에서 같은 성격이라 이 페이지에 둔다.
                    기능이 아직 열리지 않았으면 제목까지 통째로 감춘다 — 패널만 비우면
                    빈 구분선과 제목이 남아 "여기 뭔가 있는데 안 보인다"로 읽힌다. */}
                <RemoteAccessSection settings={settings} save={save} />
              </PageFrame>
            )}
            {page === 'mcp' && <McpServersPage settings={settings} save={save} />}
            {page === 'plugins' && <PluginsPage />}
            {page === 'repositories' && <RepositoriesPage repos={repos} onClose={onClose} />}
            {page === 'about' && <AboutPage onStartTour={onStartTour} />}
          </main>
        </div>
      </div>
    </div>
  )
}

/**
 * 원격 접근 구역. 가용성은 main 이 판정해 `evt:remote` 로 방송하므로 여기서 물어본다.
 * 패널이 스스로 감출 수도 있지만, 그러면 제목과 구분선만 남는다.
 */
function RemoteAccessSection({
  settings,
  save
}: {
  settings: AppSettings
  save: (patch: Partial<AppSettings>) => void
}): React.JSX.Element | null {
  const [available, setAvailable] = useState(false)

  useEffect(() => {
    void window.api.remote.getStatus().then((status) => setAvailable(status.available))
    return window.api.onRemote((status) => setAvailable(status.available))
  }, [])

  if (!available) return null
  return (
    <div className="mt-8 border-t border-[var(--border)] pt-6">
      <h4 className="mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-500">
        Remote access
      </h4>
      <RemoteAccessPanel settings={settings} save={save} />
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
          title="Tool log style"
          description="Applies to Claude and Codex tool cards. Live command cards keep their terminal layout; both styles share the same summaries and folding policy."
        >
          <div className="flex gap-1 rounded-lg bg-[var(--bg-2)] p-1">
            {(['wooi', 'terminal'] as const).map((style) => (
              <button
                key={style}
                onClick={() => save({ toolLogStyle: style })}
                className={`rounded-md px-3 py-1 text-xs capitalize ${settings.toolLogStyle === style ? 'bg-[var(--surface-2)] text-neutral-100 shadow-sm' : 'text-neutral-500 hover:text-neutral-300'}`}
              >
                {style}
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
        <SettingRow
          title="Show tips"
          description="Small cards that point out a feature the moment you're about to need it (e.g. opening a pull request)."
        >
          <Switch
            label="Show tips"
            checked={settings.showHints}
            onChange={(value) => save({ showHints: value })}
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
  const [editing, setEditing] = useState<AgentBackendId>(settings.defaultAgentBackend)
  // 저장값이 지금 못 쓰는 백엔드를 가리킬 때(그 CLI 를 지운 등) 그 사실을 한 줄로 알리는 데 쓴다.
  const savedDefaultMeta = useBackend(settings.defaultAgentBackend)
  // Solo/팀은 여기서 고르지 않는다. 새 워크스페이스는 언제나 Solo 로 시작하고, 팀은 필요해지는
  // 순간 그 워크스페이스에서 켠다 — 만들기도 전에 정하게 하면 사용자가 가장 모르는 때에 고르게
  // 하는 셈이다([[main/workspaces]] createWorkspace).
  const backend = useBackend(editing)
  const models = useModels(editing)
  const agent = agentSettingsFor(settings, editing)
  const mode = backend ? normalizePermissionMode(backend, agent.permissionMode) : null
  const selectedModel = models.find((model) => model.id === agent.model)
  const primaryModel = agent.model ?? backend?.defaultModel ?? null
  const efforts = effortOptionsFor(backend, selectedModel)
  const patchAgent = (patch: Partial<AgentSettings>): void =>
    save({ agents: { ...settings.agents, [editing]: { ...agent, ...patch } } })
  const resetAgent = (): void => patchAgent(DEFAULT_AGENT_SETTINGS)

  return (
    <PageFrame
      title="Agents"
      description="Defaults for new workspaces. Existing workspaces keep their current agent and can override model settings."
    >
      {availableBackends.length > 1 ? (
        <SettingGroup title="Default agent">
          <SettingRow
            title="Agent"
            description="Each workspace stays with the agent it was created with. It can delegate to the others once you make it an agent team from its header."
          >
            <select
              className={inputClass + ' w-60 text-sm'}
              value={settings.defaultAgentBackend}
              onChange={(event) => {
                const next = event.target.value as AgentBackendId
                setEditing(next)
                save({ defaultAgentBackend: next })
              }}
            >
              {availableBackends.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </SettingRow>
        </SettingGroup>
      ) : (
        availableBackends.length === 1 && (
          // 하나만 연결됐으면 고를 게 없다 — 그래도 어떤 에이전트가 기본인지는 보여준다
          // (전엔 이 그룹 자체가 숨어서 단일 에이전트 사용자는 이 설정의 존재조차 몰랐다).
          <SettingGroup title="Default agent">
            <SettingRow
              title="Agent"
              description={
                settings.defaultAgentBackend === availableBackends[0].id
                  ? 'Each workspace stays with the agent it was created with.'
                  : `Saved default was ${savedDefaultMeta?.label ?? settings.defaultAgentBackend} — using ${availableBackends[0].label} since that's the only agent connected.`
              }
            >
              <span className="text-sm text-neutral-300">
                {availableBackends[0].label}
                <span className="text-neutral-600"> · the only agent connected</span>
              </span>
            </SettingRow>
          </SettingGroup>
        )
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
          <div className="flex items-center gap-2">
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
                  {item.label}
                </option>
              ))}
            </select>
            <PermissionModeHelp backend={backend} />
          </div>
        </SettingRow>
        <SettingRow title="Model" description="Workspace override available">
          <select
            className={inputClass + ' w-56 text-sm'}
            value={agent.model ?? ''}
            onChange={(event) => {
              const model = event.target.value || null
              patchAgent({
                model,
                fallbackModels: agent.fallbackModels.filter((id) => id !== model)
              })
            }}
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
        {editing === 'claude' && (
          <SettingRow
            title="Fallback models"
            description="Tried in order when the primary model is overloaded or temporarily unavailable."
          >
            <div className="space-y-1.5">
              {[0, 1, 2].map((index) => {
                const selected = agent.fallbackModels[index] ?? ''
                const unavailable = new Set([
                  primaryModel,
                  ...agent.fallbackModels.filter((_, i) => i !== index)
                ])
                return (
                  <div key={index} className="flex items-center gap-2">
                    <span className="w-4 text-right text-xs text-neutral-600">{index + 1}</span>
                    <select
                      className={inputClass + ' w-56 text-sm'}
                      value={selected}
                      onChange={(event) => {
                        const next = agent.fallbackModels.slice(0, 3)
                        const value = event.target.value
                        if (value) next[index] = value
                        else next.splice(index, 1)
                        patchAgent({ fallbackModels: next.filter(Boolean) })
                      }}
                    >
                      <option value="">None</option>
                      {models
                        .filter((model) => model.id === selected || !unavailable.has(model.id))
                        .map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.label}
                          </option>
                        ))}
                    </select>
                  </div>
                )
              })}
            </div>
          </SettingRow>
        )}
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
        {editing === 'claude' && (
          <SettingRow
            title="Auto-compact long conversations"
            description="Summarizes Claude Code context near its limit so sessions can continue."
          >
            <Switch
              label="Auto-compact long conversations"
              checked={settings.autoCompact}
              onChange={(value) => save({ autoCompact: value })}
            />
          </SettingRow>
        )}
      </SettingGroup>

      <SettingGroup title="Conversations">
        <SettingRow
          title="Continue after rate limits"
          description="Waits for Claude or Codex account usage limits to reset, then continues the unfinished task in the same conversation."
        >
          <Switch
            label="Continue after rate limits"
            checked={settings.autoResumeAfterRateLimit}
            onChange={(value) => save({ autoResumeAfterRateLimit: value })}
          />
        </SettingRow>
        <SettingRow
          title="Resolve rebase conflicts with the agent"
          description='When a restack or stack sync hits a rebase conflict, asks that workspace’s agent to resolve it, spending an agent turn. Leave this off to use the "resolve with agent" button yourself.'
        >
          <Switch
            label="Resolve rebase conflicts with the agent"
            checked={settings.autoResolveConflicts}
            onChange={(value) => save({ autoResolveConflicts: value })}
          />
        </SettingRow>
      </SettingGroup>

      <AgentEnvSection
        // 백엔드 탭을 바꾸면 다시 마운트해 그 백엔드의 값에서 새로 시작한다. 편집 중에는 행 배열이
        // 원본이라(빈 키 행은 아직 저장되지 않는다) props 로 되돌리면 방금 더한 행이 사라진다.
        key={editing}
        backendLabel={backend?.label ?? editing}
        // codex 는 app-server 를 모든 워크스페이스가 공유하는 단일 프로세스로 띄우고 그 환경이
        // 기동 시점에 굳는다([[codex/appServer]]). claude 는 세션마다 SDK 에 실어 보내므로 즉시다.
        restartRequired={editing === 'codex'}
        value={agent.env ?? {}}
        onChange={(env) => patchAgent({ env })}
      />
    </PageFrame>
  )
}

/**
 * 백엔드별 기본 환경 변수 편집기.
 *
 * 범위를 환경 변수로 못 박은 이유는 [[shared/types]] 에 적어 두었다 — Wooi 는 Claude Agent SDK 와
 * Codex CLI 를 감싸므로 임의 인자 주입은 그 계약을 조용히 깬다.
 *
 * 편집 중에는 배열이 원본이다. `Record` 를 직접 고치면 키를 지우고 다시 치는 사이 행이 사라지고,
 * 빈 키/중복 키를 만드는 순간 다른 행을 덮어쓴다. 저장할 때만 레코드로 접는다.
 */
function AgentEnvSection({
  backendLabel,
  restartRequired,
  value,
  onChange
}: {
  backendLabel: string
  /** 이 백엔드가 값을 프로세스 기동 시점에 굳히는가(codex-host). 사실대로 알린다. */
  restartRequired: boolean
  value: Record<string, string>
  onChange: (next: Record<string, string>) => void
}): React.JSX.Element {
  // 마운트 시 한 번만 씨를 뿌린다. 이후 원본은 이 배열이고, 저장된 레코드는 commit 이 만든다.
  const [rows, setRows] = useState<Array<{ key: string; value: string }>>(() =>
    Object.entries(value).map(([key, item]) => ({ key, value: item }))
  )
  const [revealed, setRevealed] = useState<Set<number>>(() => new Set())

  const commit = (next: Array<{ key: string; value: string }>): void => {
    setRows(next)
    // 빈 키 행은 아직 쓰는 중이다 — 저장하지 않는다. 같은 키를 두 번 적으면 마지막 것이 이긴다.
    const record: Record<string, string> = {}
    for (const row of next) {
      const key = row.key.trim()
      if (key) record[key] = row.value
    }
    onChange(record)
  }

  return (
    <SettingGroup
      title="Environment variables"
      action={
        <button
          onClick={() => commit([...rows, { key: '', value: '' }])}
          className="text-xs text-neutral-500 hover:text-neutral-300"
        >
          Add variable
        </button>
      }
    >
      {rows.length === 0 ? (
        <div className="px-4 py-3.5 text-xs leading-relaxed text-neutral-600">
          No variables. Anything you add here is passed to every new {backendLabel} session — use it
          for things like <code className="text-neutral-500">HTTPS_PROXY</code> or a provider token
          your hooks need.
        </div>
      ) : (
        rows.map((row, index) => {
          const name = row.key.trim()
          const blocked = name.length > 0 && isBlockedAgentEnvKey(name)
          const malformed = name.length > 0 && !isValidAgentEnvKey(name)
          const problem = blocked
            ? `Wooi sets ${name} itself — this one is ignored.`
            : malformed
              ? 'Use letters, digits and underscores, starting with a letter or underscore.'
              : null
          return (
            <div key={index} className="px-4 py-2.5">
              <div className="flex items-center gap-2">
                <div className="w-52 shrink-0">
                  <input
                    className={inputClass + ' font-mono text-xs'}
                    placeholder="NAME"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    aria-label="Variable name"
                    value={row.key}
                    onChange={(event) =>
                      commit(
                        rows.map((item, i) =>
                          i === index ? { ...item, key: event.target.value } : item
                        )
                      )
                    }
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <input
                    className={inputClass + ' font-mono text-xs'}
                    placeholder="value"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    aria-label="Variable value"
                    // 값은 토큰일 수 있다. 기본은 가리고, 확인이 필요할 때만 사용자가 연다.
                    type={revealed.has(index) ? 'text' : 'password'}
                    value={row.value}
                    onChange={(event) =>
                      commit(
                        rows.map((item, i) =>
                          i === index ? { ...item, value: event.target.value } : item
                        )
                      )
                    }
                  />
                </div>
                <button
                  aria-label={revealed.has(index) ? 'Hide value' : 'Show value'}
                  onClick={() =>
                    setRevealed((prev) => {
                      const next = new Set(prev)
                      if (next.has(index)) next.delete(index)
                      else next.add(index)
                      return next
                    })
                  }
                  className="shrink-0 p-1 text-neutral-600 hover:text-neutral-300"
                >
                  {revealed.has(index) ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
                <button
                  aria-label="Remove variable"
                  onClick={() => commit(rows.filter((_, i) => i !== index))}
                  className="shrink-0 p-1 text-neutral-600 hover:text-neutral-300"
                >
                  <Trash2 size={13} />
                </button>
              </div>
              {problem && <p className="mt-1 text-xs text-[var(--warn-400)]">{problem}</p>}
            </div>
          )
        })
      )}
      <div className="px-4 py-3 text-xs leading-relaxed text-neutral-600">
        {restartRequired
          ? `${backendLabel} reads these when it starts, so restart Wooi to apply changes.`
          : `New ${backendLabel} turns pick these up right away.`}{' '}
        <code className="text-neutral-500">PATH</code>,{' '}
        <code className="text-neutral-500">HOME</code> and{' '}
        <code className="text-neutral-500">WOOI_*</code> can’t be overridden — Wooi needs them to
        find your agent CLI and keep workspaces apart.
      </div>
    </SettingGroup>
  )
}

/**
 * 마지막으로 건너뛴 알림 1건.
 *
 * 알림은 조건이 여러 겹이라(음소거 · 채널 · 포커스 · OS 권한) 안 울렸을 때 어디서 막혔는지
 * 결과만 보고는 알 수 없다 — 특히 macOS 는 권한이 없거나 집중 모드면 **오류 없이** 삼킨다.
 * 그 침묵을 여기서 문장으로 돌려준다.
 *
 * 값은 main 메모리에만 있으므로(진단값이라 디스크에 남기지 않는다) 이 페이지를 열 때 읽는다.
 */
function LastNotificationSkip(): React.JSX.Element {
  const [skip, setSkip] = useState<NotificationSkip | null>(null)
  useEffect(() => {
    let alive = true
    void window.api.notify
      .lastSkip()
      .then((value) => {
        if (alive) setSkip(value)
      })
      .catch(() => {
        // 진단 줄이 없다고 설정 화면이 망가질 이유는 없다.
      })
    return () => {
      alive = false
    }
  }, [])

  if (!skip) {
    return (
      <p className="text-xs leading-relaxed text-neutral-600">
        OS notifications appear only while Wooi is in the background. If macOS notifications are
        disabled, allow Wooi in System Settings → Notifications.
      </p>
    )
  }
  return (
    <p className="text-xs leading-relaxed text-neutral-600">
      Last skipped notification: {NOTIFICATION_EVENT_LABELS[skip.event].toLowerCase()} for{' '}
      <span className="text-neutral-400">{skip.workspaceName}</span> —{' '}
      {NOTIFICATION_SKIP_LABELS[skip.reason]}.
    </p>
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
      <SettingGroup title="Focus">
        <SettingRow
          title="Stay quiet for the workspace I’m watching"
          description="Skips the OS notification when Wooi is in front and that workspace is the one on screen. Other workspaces still notify — you can be looking at one while another finishes."
        >
          <Switch
            label="Stay quiet for the workspace I’m watching"
            checked={settings.suppressWhenFocused !== false}
            onChange={(value) => save({ suppressWhenFocused: value })}
          />
        </SettingRow>
      </SettingGroup>

      <LastNotificationSkip />

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
      {/* 리포를 가리지 않는 상시 입구. 사이드바 안내는 리포가 하나도 없을 때만 뜨고 + 메뉴는
          리포 하나만 보므로, 여러 리포에 흩어진 worktree 를 한 번에 훑는 자리는 여기다. */}
      <button
        onClick={() => {
          onClose()
          openMigrate()
        }}
        className="flex w-full items-center gap-3 rounded-xl border border-[var(--border)] px-4 py-3 text-left hover:bg-[var(--surface-2)]"
      >
        <Download size={15} className="text-neutral-500" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-neutral-200">
            Import existing worktrees
          </span>
          <span className="block text-xs text-neutral-600">
            Turns worktrees that already exist — including ones Conductor or Orca made — into
            workspaces, and can pick up the agent conversation that was running in them.
          </span>
        </span>
        <ChevronRight size={15} className="text-neutral-600" />
      </button>
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
