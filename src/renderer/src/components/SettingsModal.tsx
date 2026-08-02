import { useEffect, useState } from 'react'
import { Compass, Download, RefreshCw, Settings2 } from 'lucide-react'
import { useStore } from '../store'
import { openRepoSettings } from '../lib/repoSettings'
import { hasNewVersion, updateStatusText } from '../lib/update'
import Modal, { inputClass, labelClass, primaryBtn, ghostBtn } from './Modal'
import IntegrationsPanel from './IntegrationsPanel'
import { permissionModesFor } from '../lib/permission'
import { effortOptionsFor } from '../lib/effort'
import { useAvailableBackends, useBackend, useModels } from '../lib/backends'
import { applyTheme } from '../lib/theme'
import {
  NOTIFICATION_CHANNEL_LABELS,
  NOTIFICATION_EVENT_LABELS,
  agentSettingsFor,
  normalizePermissionMode
} from '@shared/types'
import type {
  AgentBackendId,
  AgentSettings,
  EffortSetting,
  NotificationChannel,
  NotificationEvent,
  NotificationSettings,
  PermissionMode,
  Repo,
  ThemePreference
} from '@shared/types'

/**
 * 리포 행에 붙는 한 줄 요약. "무엇이 설정돼 있는지"를 열어 보지 않고도 알 수 있게 해,
 * 목록 자체가 기능 소개 역할을 하도록 한다(아무것도 없으면 그 사실이 곧 안내가 된다).
 */
function describeRepoConfig(repo: Repo): string {
  const parts: string[] = []
  if (repo.setupScript.trim()) parts.push('setup')
  if (repo.devScript.trim()) parts.push('dev')
  if (repo.archiveScript.trim()) parts.push('archive')
  if (repo.carryItems.length > 0) parts.push(`${repo.carryItems.length} carried file(s)`)
  return parts.length > 0 ? parts.join(' · ') : 'Nothing configured yet'
}

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
  const repos = useStore((s) => s.app!.repos)
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
  const [theme, setTheme] = useState<ThemePreference>(settings.theme)

  // ── 에이전트 설정 (백엔드별) ────────────────────────────────────────────
  // 모델 ID·권한 모드는 백엔드마다 다르므로 하나의 전역 값으로 편집할 수 없다. 기본 에이전트를
  // 고르고, 그 아래에서 **선택된 백엔드의** 기본값만 편집한다.
  const availableBackends = useAvailableBackends()
  const [defaultAgentBackend, setDefaultAgentBackend] = useState<AgentBackendId>(
    settings.defaultAgentBackend
  )
  const [agents, setAgents] = useState<Record<AgentBackendId, AgentSettings>>(settings.agents)
  // 편집 대상 백엔드. 기본 에이전트를 바꾸면 그 백엔드의 설정을 이어서 보여 준다.
  const [editing, setEditing] = useState<AgentBackendId>(settings.defaultAgentBackend)

  const backend = useBackend(editing)
  const models = useModels(editing)
  const agent = agentSettingsFor({ ...settings, agents }, editing)
  const mode = backend ? normalizePermissionMode(backend, agent.permissionMode) : null
  const selectedModel = models.find((m) => m.id === agent.model)
  const efforts = effortOptionsFor(backend, selectedModel)

  /** 편집 중인 백엔드의 기본값 일부를 갱신한다. 다른 백엔드의 값은 건드리지 않는다. */
  const patchAgent = (patch: Partial<AgentSettings>): void =>
    setAgents((a) => ({
      ...a,
      [editing]: { ...agentSettingsFor({ ...settings, agents: a }, editing), ...patch }
    }))

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
      defaultAgentBackend,
      agents,
      manualWorkspaceSetup,
      notifications,
      // 하위호환: 레거시 soundOnComplete 를 완료 소리 채널과 동기화해 둔다.
      soundOnComplete: notifications.completed.sound,
      autoCompact,
      defaultRightPanelOpen,
      showRunningAgents,
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

        {/* 전역 설정과 리포별 설정은 완전히 분리된 두 모달인데, 서로를 가리키는 링크가 하나도
            없었다. 설정을 찾으러 ⌘, 를 누른 사용자는 여기서 스크립트·carry 를 찾다가 못 찾고
            포기한다 — 그런 것이 리포마다 따로 있다는 사실 자체를 여기서 알려 주고 넘긴다. */}
        <Section title="Repositories">
          <p className="text-xs text-neutral-600 leading-relaxed">
            Setup / dev / archive commands and the files carried into new worktrees are configured
            per repository, not here.
          </p>
          <div className="space-y-1">
            {repos.length === 0 && (
              <p className="text-xs text-neutral-600">
                No repositories yet — add one from the sidebar.
              </p>
            )}
            {repos.map((repo) => (
              <button
                key={repo.id}
                type="button"
                onClick={() => {
                  // 두 모달이 동시에 뜨지 않도록 이쪽을 먼저 닫는다.
                  onClose()
                  openRepoSettings(repo.id)
                }}
                className="flex items-center gap-2.5 w-full text-left px-3 py-2 rounded-lg border border-[var(--border)] text-neutral-300 hover:bg-[var(--surface-2)] hover:text-neutral-100 transition-colors"
              >
                <Settings2 size={14} className="shrink-0 text-neutral-500" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm truncate">{repo.name}</span>
                  <span className="block text-xs text-neutral-600 truncate">
                    {describeRepoConfig(repo)}
                  </span>
                </span>
              </button>
            ))}
          </div>
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
          {/* 에이전트가 둘 이상 준비돼 있을 때만 선택지를 보여 준다 — 하나뿐인 사용자에게
              다른 에이전트 이름을 노출할 이유가 없다. */}
          {availableBackends.length > 1 && (
            <div>
              <label className={labelClass}>Default agent for new workspaces</label>
              <select
                className={inputClass}
                value={defaultAgentBackend}
                onChange={(e) => {
                  const next = e.target.value as AgentBackendId
                  setDefaultAgentBackend(next)
                  // 기본을 바꾸면 아래 설정도 그 에이전트 것으로 따라간다(빈 화면을 남기지 않도록).
                  setEditing(next)
                }}
              >
                {availableBackends.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </select>
              <p className="mt-1.5 text-xs text-neutral-600">
                Each workspace stays on the agent it was created with.
              </p>
            </div>
          )}

          {/* 편집 대상 전환 탭 — 기본 에이전트가 아닌 쪽 설정도 미리 손볼 수 있게 한다. */}
          {availableBackends.length > 1 && (
            <div className="flex gap-1.5">
              {availableBackends.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => setEditing(b.id)}
                  className={
                    'flex-1 text-sm px-3 py-1.5 border rounded-lg transition-colors ' +
                    (editing === b.id
                      ? 'border-[var(--info-500)] bg-[var(--info-600)]/15 text-neutral-100'
                      : 'border-[var(--border)] text-neutral-300 hover:bg-[var(--surface-2)]')
                  }
                >
                  {b.label}
                </button>
              ))}
            </div>
          )}

          <div>
            <label className={labelClass}>Default permission mode for new workspaces</label>
            <select
              className={inputClass}
              value={mode ?? ''}
              disabled={!backend}
              onChange={(e) => patchAgent({ permissionMode: e.target.value as PermissionMode })}
            >
              {permissionModesFor(backend).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} — {m.description}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-xs text-neutral-600">
              Press ⇧⇥ in a session to cycle the mode.
            </p>
          </div>

          <div>
            <label className={labelClass}>Model</label>
            <select
              className={inputClass}
              value={agent.model ?? ''}
              onChange={(e) => patchAgent({ model: e.target.value || null })}
            >
              {/* Codex 는 모델을 지정하지 않으면 자기 설정/카탈로그 기본값을 쓴다. */}
              <option value="">Default — let {backend?.label ?? 'the agent'} decide</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
              {/* 저장된 값이 카탈로그에 없으면(구버전·조회 실패) 그대로 한 줄 보여 준다. */}
              {agent.model && !models.some((m) => m.id === agent.model) && (
                <option value={agent.model}>{agent.model}</option>
              )}
            </select>
            <p className="mt-1.5 text-xs text-neutral-600">
              Default for new workspaces. Each workspace can override this from its header dropdown.
            </p>
          </div>

          <div>
            <label className={labelClass}>Reasoning effort</label>
            <select
              className={inputClass}
              value={agent.effort ?? ''}
              onChange={(e) =>
                patchAgent({ effort: (e.target.value || null) as EffortSetting | null })
              }
            >
              <option value="">Default — let the model decide</option>
              {efforts.map((e) => (
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

          {/* 백엔드가 fast service tier 를 지원할 때만 표시한다. */}
          {backend?.capabilities.fastMode && (
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={agent.fastMode}
                onChange={(e) => patchAgent({ fastMode: e.target.checked })}
                className="accent-blue-600 h-3.5 w-3.5 mt-0.5"
              />
              <span className="text-sm text-neutral-300">
                Fast mode
                <span className="block text-xs text-neutral-600">
                  Runs the same model through the backend’s faster service tier. Availability and
                  billing depend on the selected agent and account. Each workspace can override
                  this with <code>/fast</code>.
                </span>
              </span>
            </label>
          )}

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
