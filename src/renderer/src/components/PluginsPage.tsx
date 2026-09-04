import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, FileWarning, RefreshCw } from 'lucide-react'
import type { CodexPlugin, CodexPluginDetail, CodexPluginInventory } from '@shared/types'
import { useStore } from '../store'
import { PageFrame, SettingGroup } from './SettingsPrimitives'

/**
 * Codex Agent Plugins 설정 페이지.
 *
 * **읽기 전용이다.** Codex 의 `plugin/install` · `marketplace/add` 는 이 워크스페이스가 아니라
 * 사용자의 codex 설치본 전체를 바꾸는 바깥 방향 동작이라, 목록을 보는 화면에 곁다리로 달지
 * 않는다. 여기서 답하는 것은 하나다 — "이 Codex 에 무엇이 깔려 있고, 어디서 왔고, 지금 쓸 수
 * 있는가". 설치·삭제는 계속 `codex plugin` 이 한다.
 *
 * 목록이 필요한 이유는 이미 Wooi 화면에 결과가 나와 있기 때문이다. 플러그인이 싣고 온 스킬은
 * 입력창 자동완성에 `/supabase:supabase` 처럼 그대로 뜨는데(codex/skills.ts), 그게 어디서 왔는지
 * 앱 안에서 알 방법이 없었다. 행을 펼치면 그 플러그인이 싣는 스킬·MCP 서버·훅이 나온다.
 *
 * MCP 페이지와 같은 이유로 Codex 로그인 상태일 때만 조회한다 — 목록을 읽으려면 app-server 를
 * 띄워야 하고, Codex 를 안 쓰는 사람에게 그 비용을 지울 이유가 없다. 섹션은 늘 그린다.
 */
export default function PluginsPage(): React.JSX.Element {
  const codex = useStore((state) => state.authStatus?.agents.codex)
  const codexLoggedIn = codex?.loggedIn ?? false
  const [inventory, setInventory] = useState<CodexPluginInventory | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(
    (): Promise<void> =>
      window.api.plugins.codexPlugins().then((result) => {
        setInventory(result.inventory ?? null)
        setError(result.error ?? null)
      }),
    []
  )

  useEffect(() => {
    if (codexLoggedIn) void load()
  }, [codexLoggedIn, load])

  // 첫 조회는 빈 목록 자리의 문구가 대신 알려 주므로, 스피너는 사용자가 직접 누른 갱신에만 돈다.
  const reload = (): void => {
    setLoading(true)
    void load().finally(() => setLoading(false))
  }

  const marketplaces = inventory?.marketplaces ?? []
  const total = marketplaces.reduce((count, entry) => count + entry.plugins.length, 0)

  return (
    <PageFrame
      title="Plugins"
      description="Codex Agent Plugins bundle skills, MCP servers, and hooks. Codex installs them for your whole machine, so Wooi shows what is installed here and leaves installing to the codex CLI."
    >
      <SettingGroup
        title="Installed in Codex"
        action={
          <button
            onClick={reload}
            disabled={!codexLoggedIn || loading}
            aria-label="Reload Codex plugins"
            className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs text-neutral-300 hover:bg-[var(--surface-2)] disabled:opacity-50"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Reload
          </button>
        }
      >
        {!codex?.installed ? (
          <Empty>Codex is not installed — its plugins appear here once it is.</Empty>
        ) : !codexLoggedIn ? (
          <Empty>Sign in to Codex from Integrations to see its plugins.</Empty>
        ) : error ? (
          <p className="px-4 py-8 text-center text-sm text-[var(--danger-400)]">{error}</p>
        ) : !inventory ? (
          <Empty>Asking Codex for its plugins…</Empty>
        ) : !inventory.supported ? (
          // 목록이 빈 것과 구분한다 — 이쪽은 사용자가 할 일이 "codex 를 올려라" 로 정해져 있다.
          <Empty>
            This version of Codex does not have Agent Plugins. Update the codex CLI to manage them.
          </Empty>
        ) : total === 0 ? (
          <Empty>
            No plugins installed. Add one with <code>codex plugin install</code>.
          </Empty>
        ) : (
          marketplaces
            .filter((entry) => entry.plugins.length > 0)
            .map((entry) => (
              <MarketplaceSection
                key={entry.name}
                displayName={entry.displayName}
                path={entry.path}
                plugins={entry.plugins}
                marketplaceName={entry.name}
              />
            ))
        )}
      </SettingGroup>

      {/* 읽지 못한 마켓플레이스. 조용히 빠지면 "왜 내 플러그인이 안 보이지" 를 화면에서 알 수 없다. */}
      {inventory && inventory.loadErrors.length > 0 && (
        <SettingGroup title="Could not be read">
          {inventory.loadErrors.map((loadError) => (
            <div key={`${loadError.path}:${loadError.message}`} className="px-4 py-3">
              <div className="flex items-center gap-2 text-sm text-[var(--warning-300)]">
                <FileWarning size={13} className="shrink-0" />
                <span className="truncate font-mono text-xs">
                  {loadError.path || 'Unknown file'}
                </span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-neutral-500">{loadError.message}</p>
            </div>
          ))}
        </SettingGroup>
      )}

      <div className="space-y-2 text-xs leading-relaxed text-neutral-600">
        <p>
          The skills a plugin brings show up in the composer as{' '}
          <span className="text-neutral-400">/plugin:skill</span> in every Codex workspace — expand
          a plugin to see which ones are its.
        </p>
        <p>
          This list is read-only. Installing a plugin or adding a marketplace changes your whole
          Codex installation, not just this workspace, so Wooi leaves those to{' '}
          <code>codex plugin</code>.
        </p>
      </div>
    </PageFrame>
  )
}

function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="px-4 py-8 text-center text-sm text-neutral-600">{children}</p>
}

/**
 * 마켓플레이스 1개와 그 플러그인들.
 *
 * 마켓플레이스가 곧 출처이므로 묶어서 보여 준다 — 같은 이름의 플러그인이 여러 카탈로그에 있을 수
 * 있고, 무엇을 지웠을 때 무엇이 사라지는지도 이 단위로 정해진다.
 */
function MarketplaceSection({
  displayName,
  path,
  plugins,
  marketplaceName
}: {
  displayName: string
  path: string | null
  plugins: CodexPlugin[]
  marketplaceName: string
}): React.JSX.Element {
  return (
    <div>
      <div className="flex items-baseline gap-2 bg-[var(--surface-2)]/30 px-4 py-2">
        <span className="text-xs font-semibold text-neutral-300">{displayName}</span>
        {/* 원격 카탈로그에는 경로가 없다 — 로컬 파일이 아니라는 사실 자체가 정보라 그렇게 적는다. */}
        <span className="min-w-0 flex-1 truncate text-right font-mono text-2xs text-neutral-600">
          {path ?? 'remote catalog'}
        </span>
      </div>
      {plugins.map((plugin) => (
        <PluginRow key={plugin.id} plugin={plugin} marketplaceName={marketplaceName} path={path} />
      ))}
    </div>
  )
}

type DetailState =
  | { phase: 'loading' }
  | { phase: 'ready'; detail: CodexPluginDetail }
  | { phase: 'error'; message: string }

function PluginRow({
  plugin,
  marketplaceName,
  path
}: {
  plugin: CodexPlugin
  marketplaceName: string
  path: string | null
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<DetailState | null>(null)

  // 상세는 플러그인마다 왕복이 한 번씩 더 필요하므로 펼칠 때만, 그리고 한 번만 읽는다.
  const toggle = (): void => {
    const next = !open
    setOpen(next)
    if (!next || detail) return
    setDetail({ phase: 'loading' })
    void window.api.plugins
      .codexPluginDetail({
        pluginName: plugin.name,
        marketplacePath: path,
        marketplaceName
      })
      .then((result) =>
        setDetail(
          result.detail
            ? { phase: 'ready', detail: result.detail }
            : { phase: 'error', message: result.error ?? 'Codex did not return plugin details.' }
        )
      )
  }

  return (
    <div className="px-4 py-3">
      <button
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-start gap-2 text-left"
      >
        {open ? (
          <ChevronDown size={14} className="mt-0.5 shrink-0 text-neutral-500" />
        ) : (
          <ChevronRight size={14} className="mt-0.5 shrink-0 text-neutral-500" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-neutral-200">
              {plugin.displayName}
            </span>
            {plugin.displayName !== plugin.name && (
              <span className="truncate font-mono text-xs text-neutral-600">{plugin.name}</span>
            )}
            <Badge>{plugin.source}</Badge>
            {plugin.version && <span className="text-xs text-neutral-600">v{plugin.version}</span>}
            {!plugin.enabled && <Badge tone="muted">Off</Badge>}
          </div>
          {plugin.description && (
            <p className="mt-0.5 text-xs leading-relaxed text-neutral-500">{plugin.description}</p>
          )}
          {plugin.unavailableReason && (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-[var(--warning-300)]">
              <AlertTriangle size={12} className="shrink-0" />
              {plugin.unavailableReason}
            </p>
          )}
        </div>
      </button>
      {open && (
        <div className="mt-2 ml-6 space-y-2 border-l border-[var(--border)] pl-3">
          {plugin.sourceDetail && (
            <p className="truncate font-mono text-xs text-neutral-600">{plugin.sourceDetail}</p>
          )}
          {!detail || detail.phase === 'loading' ? (
            <p className="text-xs text-neutral-600">Reading plugin…</p>
          ) : detail.phase === 'error' ? (
            <p className="text-xs text-[var(--danger-400)]">{detail.message}</p>
          ) : (
            <PluginContents detail={detail.detail} />
          )}
        </div>
      )}
    </div>
  )
}

/** 펼친 행의 알맹이. 비어 있는 종류는 아예 그리지 않는다 — 대부분의 플러그인은 스킬만 싣는다. */
function PluginContents({ detail }: { detail: CodexPluginDetail }): React.JSX.Element {
  const empty =
    detail.skills.length === 0 &&
    detail.mcpServers.length === 0 &&
    detail.hooks.length === 0 &&
    detail.apps.length === 0 &&
    detail.scheduledTasks.length === 0

  return (
    <>
      {detail.description && (
        <p className="text-xs leading-relaxed text-neutral-500">{detail.description}</p>
      )}
      {detail.skills.length > 0 && (
        <Contents title="Skills">
          {detail.skills.map((skill) => (
            <li key={skill.name} className="flex items-baseline gap-2">
              <code className="shrink-0 text-neutral-300">/{skill.name}</code>
              <span className="min-w-0 truncate text-neutral-600">{skill.description}</span>
              {!skill.enabled && <Badge tone="muted">Off</Badge>}
            </li>
          ))}
        </Contents>
      )}
      {detail.mcpServers.length > 0 && (
        <Contents title="MCP servers">
          {detail.mcpServers.map((name) => (
            <li key={name} className="text-neutral-300">
              {name}
            </li>
          ))}
        </Contents>
      )}
      {detail.hooks.length > 0 && (
        <Contents title="Hooks">
          {detail.hooks.map((hook) => (
            <li key={hook.key} className="flex items-baseline gap-2">
              <span className="text-neutral-300">{hook.key}</span>
              <span className="text-neutral-600">{hook.eventName}</span>
            </li>
          ))}
        </Contents>
      )}
      {detail.apps.length > 0 && (
        <Contents title="Apps">
          {detail.apps.map((app) => (
            <li key={app.id || app.name} className="flex items-baseline gap-2">
              <span className="shrink-0 text-neutral-300">{app.name}</span>
              <span className="min-w-0 truncate text-neutral-600">{app.description}</span>
            </li>
          ))}
        </Contents>
      )}
      {detail.scheduledTasks.length > 0 && (
        <Contents title="Scheduled tasks">
          {detail.scheduledTasks.map((task) => (
            <li key={task.key || task.name} className="text-neutral-300">
              {task.name}
            </li>
          ))}
        </Contents>
      )}
      {empty && <p className="text-xs text-neutral-600">This plugin ships no skills or servers.</p>}
    </>
  )
}

function Contents({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div>
      <div className="text-2xs font-semibold uppercase tracking-wider text-neutral-600">
        {title}
      </div>
      <ul className="mt-1 space-y-0.5 text-xs">{children}</ul>
    </div>
  )
}

function Badge({
  children,
  tone = 'default'
}: {
  children: React.ReactNode
  tone?: 'default' | 'muted'
}): React.JSX.Element {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide ${
        tone === 'muted'
          ? 'bg-[var(--surface-2)] text-neutral-500'
          : 'bg-[var(--surface-2)] text-neutral-400'
      }`}
    >
      {children}
    </span>
  )
}
