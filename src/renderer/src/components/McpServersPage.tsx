import { useCallback, useEffect, useMemo, useState } from 'react'
import { ExternalLink, FileWarning, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { isValidMcpServerName, mcpSettingsOf } from '@shared/types'
import type {
  AppSettings,
  CodexMcpServer,
  InheritedMcpServer,
  McpInventory,
  McpSettings,
  WooiMcpServer
} from '@shared/types'
import { useStore } from '../store'
import Modal, { ghostBtn, inputClass, labelClass, primaryBtn } from './Modal'
import { PageFrame, SettingGroup, Switch } from './SettingsPrimitives'

/**
 * MCP 서버 설정 페이지.
 *
 * 두 종류를 한 화면에서 보여 준다.
 *  - **승계(inherited)**: `~/.claude.json` 에 사용자가 `claude` CLI 로 등록해 둔 서버. Wooi 는 이
 *    파일을 읽기만 한다 — 다른 도구와 소유권이 겹치는 파일을 앱이 고쳐 쓰면 상대의 편집을
 *    조용히 뭉갠다. 그래서 편집은 "파일 열기" 한 가지고, 우리가 줄 수 있는 건 주입 제외뿐이다.
 *  - **Wooi 관리**: 이 앱이 소유하는 목록(wooi.json). 자유롭게 추가·수정·삭제한다.
 *  - **Codex**: `~/.codex/config.toml`. 여기만은 토글이 사용자 파일에 직접 쓴다 — codex 는 자기
 *    설정을 스스로 읽으므로 "우리 목록에서 빼기" 에 해당하는 경로가 없다. 그 차이를 섹션 설명에
 *    적어 둔다. 목록은 파일을 파싱하지 않고 codex app-server 에 물어본다.
 *
 * 이름이 겹치면 `~/.claude.json` 이 이긴다. 그 규칙을 문장으로만 적어 두면 아무도 안 읽으므로,
 * 가려진 항목 행에 직접 표시하고 해소 방법(승계 항목 끄기)까지 같은 자리에 적는다.
 */
export default function McpServersPage({
  settings,
  save
}: {
  settings: AppSettings
  save: (patch: Partial<AppSettings>) => void
}): React.JSX.Element {
  const mcp = mcpSettingsOf(settings)
  const [inventory, setInventory] = useState<McpInventory | null>(null)
  const [editing, setEditing] = useState<WooiMcpServer | null>(null)
  const [loading, setLoading] = useState(true)
  // Codex 목록을 읽으려면 app-server 프로세스가 떠야 한다. Codex 를 실제로 쓰는 사람에게만
  // 그 비용을 지운다 — 로그인 상태를 "이 에이전트를 쓴다" 의 대리 신호로 삼는다.
  const codexLoggedIn = useStore((state) => state.authStatus?.agents.codex.loggedIn ?? false)
  const [codexServers, setCodexServers] = useState<CodexMcpServer[] | null>(null)
  const [codexError, setCodexError] = useState<string | null>(null)
  const [codexBusy, setCodexBusy] = useState<string | null>(null)

  const load = useCallback(
    (): Promise<void> =>
      window.api.mcp
        .inventory()
        .then(setInventory)
        .finally(() => setLoading(false)),
    []
  )
  // 승계 목록은 남의 파일이라 앱 상태 방송에 실리지 않는다 — 페이지를 열 때 한 번 읽고,
  // 사용자가 파일을 고치고 돌아왔을 때를 위해 수동 새로고침을 둔다.
  useEffect(() => {
    void load()
  }, [load])

  const refresh = (): void => {
    setLoading(true)
    void load()
  }

  useEffect(() => {
    if (!codexLoggedIn) return
    void window.api.mcp.codexServers().then((result) => {
      setCodexServers(result.servers ?? [])
      setCodexError(result.error ?? null)
    })
  }, [codexLoggedIn])

  const toggleCodex = (name: string, enabled: boolean): void => {
    setCodexBusy(name)
    void window.api.mcp
      .setCodexServerEnabled(name, enabled)
      .then((result) => {
        // 실패하면 목록을 건드리지 않는다 — 스위치가 되돌아가는 것이 곧 "안 됐다" 는 신호다.
        if (result.servers) setCodexServers(result.servers)
        setCodexError(result.error ?? null)
      })
      .finally(() => setCodexBusy(null))
  }

  const disabledInherited = useMemo(() => new Set(mcp.disabledInherited), [mcp.disabledInherited])
  /** 지금 실제로 주입되는 승계 이름들 — Wooi 항목이 가려지는지 판단하는 기준이다. */
  const activeInherited = useMemo(
    () =>
      new Set(
        (inventory?.inherited ?? [])
          .filter((server) => !disabledInherited.has(server.name))
          .map((server) => server.name)
      ),
    [inventory, disabledInherited]
  )

  const patch = (next: Partial<McpSettings>): void => save({ mcp: { ...mcp, ...next } })

  const upsert = (server: WooiMcpServer): void => {
    const exists = mcp.servers.some((item) => item.id === server.id)
    patch({
      servers: exists
        ? mcp.servers.map((item) => (item.id === server.id ? server : item))
        : [...mcp.servers, server]
    })
    setEditing(null)
  }

  const remove = (id: string): void =>
    patch({ servers: mcp.servers.filter((item) => item.id !== id) })

  const toggleInherited = (name: string, enabled: boolean): void =>
    patch({
      disabledInherited: enabled
        ? mcp.disabledInherited.filter((item) => item !== name)
        : [...mcp.disabledInherited, name]
    })

  return (
    <PageFrame
      title="MCP servers"
      description="Model Context Protocol servers give agents extra tools. Wooi injects these into every workspace session — changes take effect the next time a session starts."
    >
      <SettingGroup
        title="Wooi-managed"
        action={
          <button
            onClick={() => setEditing(blankServer())}
            className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs text-neutral-300 hover:bg-[var(--surface-2)]"
          >
            <Plus size={12} /> Add server
          </button>
        }
      >
        {mcp.servers.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-neutral-600">
            No servers yet. Add one to make its tools available in every workspace.
          </p>
        ) : (
          mcp.servers.map((server) => (
            <WooiServerRow
              key={server.id}
              server={server}
              shadowed={server.enabled && activeInherited.has(server.name.trim())}
              onToggle={(enabled) => upsert({ ...server, enabled })}
              onEdit={() => setEditing(server)}
              onDelete={() => remove(server.id)}
            />
          ))
        )}
      </SettingGroup>

      <SettingGroup
        title="From ~/.claude.json"
        action={
          <div className="flex items-center gap-1">
            <button
              onClick={refresh}
              aria-label="Reload inherited servers"
              className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs text-neutral-300 hover:bg-[var(--surface-2)]"
            >
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Reload
            </button>
            <button
              onClick={() => void window.api.mcp.openConfig()}
              className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs text-neutral-300 hover:bg-[var(--surface-2)]"
            >
              <ExternalLink size={12} /> Open file
            </button>
          </div>
        }
      >
        {loading && !inventory ? (
          <p className="px-4 py-8 text-center text-sm text-neutral-600">Reading your config…</p>
        ) : !inventory?.configExists ? (
          <p className="px-4 py-8 text-center text-sm text-neutral-600">
            No ~/.claude.json yet — register servers with <code>claude mcp add</code> and they show
            up here.
          </p>
        ) : inventory.inherited.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-neutral-600">
            Your config has no MCP servers for the repositories registered in Wooi.
          </p>
        ) : (
          inventory.inherited.map((server) => (
            <InheritedServerRow
              key={`${server.origin}:${server.projectPath ?? ''}:${server.name}`}
              server={server}
              enabled={!disabledInherited.has(server.name)}
              onToggle={(enabled) => toggleInherited(server.name, enabled)}
            />
          ))
        )}
      </SettingGroup>

      {codexLoggedIn && (
        <SettingGroup title="From ~/.codex/config.toml">
          {codexServers === null ? (
            <p className="px-4 py-8 text-center text-sm text-neutral-600">
              Asking Codex for its servers…
            </p>
          ) : codexError ? (
            <p className="px-4 py-8 text-center text-sm text-[var(--danger-400)]">{codexError}</p>
          ) : codexServers.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-neutral-600">
              Codex has no MCP servers configured.
            </p>
          ) : (
            codexServers.map((server) => (
              <CodexServerRow
                key={server.name}
                server={server}
                busy={codexBusy === server.name}
                onToggle={(enabled) => toggleCodex(server.name, enabled)}
              />
            ))
          )}
        </SettingGroup>
      )}

      <div className="space-y-2 text-xs leading-relaxed text-neutral-600">
        <p>
          Entries in ~/.claude.json are read-only here — Wooi never writes that file, so other tools
          keep ownership of it. If a name appears in both lists, the ~/.claude.json entry wins; turn
          it off above to let the Wooi-managed one take the name.
        </p>
        {codexLoggedIn && (
          <p>
            The ~/.codex/config.toml switches are the exception:{' '}
            <span className="text-neutral-400">they write that file</span>, because Codex reads its
            own config and Wooi cannot leave a server out on its side. Changes apply to Codex right
            away.
          </p>
        )}
        <p>
          Codex sessions receive Wooi-managed <span className="text-neutral-400">stdio</span>{' '}
          servers only, and pick up changes after Wooi restarts.
        </p>
      </div>

      {editing && (
        <McpServerEditor
          server={editing}
          takenNames={mcp.servers.filter((s) => s.id !== editing.id).map((s) => s.name.trim())}
          onCancel={() => setEditing(null)}
          onSave={upsert}
        />
      )}
    </PageFrame>
  )
}

function blankServer(): WooiMcpServer {
  return {
    id: crypto.randomUUID(),
    name: '',
    enabled: true,
    transport: 'stdio',
    command: '',
    args: [],
    env: {}
  }
}

/** 한 줄 요약. 목록에서 "이게 무엇에 붙는 서버인지" 를 이름만으로는 알 수 없어 함께 보여 준다. */
function summarize(server: WooiMcpServer): string {
  if (server.transport === 'stdio') return [server.command, ...server.args].join(' ')
  return server.url
}

function TransportBadge({ transport }: { transport: string }): React.JSX.Element {
  return (
    <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
      {transport}
    </span>
  )
}

function WooiServerRow({
  server,
  shadowed,
  onToggle,
  onEdit,
  onDelete
}: {
  server: WooiMcpServer
  shadowed: boolean
  onToggle: (enabled: boolean) => void
  onEdit: () => void
  onDelete: () => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-neutral-200">
            {server.name.trim() || 'Unnamed server'}
          </span>
          <TransportBadge transport={server.transport} />
          <span className="rounded bg-[var(--info-600)]/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--info-400)]">
            Wooi
          </span>
        </div>
        <p className="mt-0.5 truncate font-mono text-xs text-neutral-600">
          {summarize(server) || 'Nothing configured yet'}
        </p>
        {shadowed && (
          <p className="mt-1 flex items-center gap-1.5 text-xs text-[var(--warning-300)]">
            <FileWarning size={12} className="shrink-0" />
            Shadowed by the ~/.claude.json entry with the same name — turn that one off to use this.
          </p>
        )}
      </div>
      <button
        onClick={onEdit}
        aria-label={`Edit ${server.name || 'server'}`}
        className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-neutral-500 hover:bg-[var(--surface-2)] hover:text-neutral-200"
      >
        <Pencil size={14} />
      </button>
      <button
        onClick={onDelete}
        aria-label={`Delete ${server.name || 'server'}`}
        className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-neutral-500 hover:bg-[var(--danger-500)]/15 hover:text-[var(--danger-400)]"
      >
        <Trash2 size={14} />
      </button>
      <Switch
        label={`Enable ${server.name || 'server'}`}
        checked={server.enabled}
        onChange={onToggle}
      />
    </div>
  )
}

function InheritedServerRow({
  server,
  enabled,
  onToggle
}: {
  server: InheritedMcpServer
  enabled: boolean
  onToggle: (enabled: boolean) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-neutral-200">{server.name}</span>
          <TransportBadge transport={server.transport} />
          <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
            {server.origin}
          </span>
        </div>
        <p className="mt-0.5 truncate font-mono text-xs text-neutral-600">
          {server.detail || 'Unrecognized entry — open the file to see it'}
        </p>
        {server.projectPath && (
          <p className="mt-0.5 truncate text-xs text-neutral-600">{server.projectPath}</p>
        )}
      </div>
      <Switch label={`Inject ${server.name}`} checked={enabled} onChange={onToggle} />
    </div>
  )
}

/**
 * Codex 설정 파일의 서버 한 줄.
 *
 * 다른 두 섹션과 달리 이 토글은 **사용자 파일을 고친다** — 그래서 되돌리는 데 앱이 필요 없다는
 * 뜻이기도 하고, 우리가 남의 파일에 쓴다는 뜻이기도 하다. 행마다 반복하면 시끄러우므로 섹션
 * 아래 설명 한 줄로 알린다.
 */
function CodexServerRow({
  server,
  busy,
  onToggle
}: {
  server: CodexMcpServer
  busy: boolean
  onToggle: (enabled: boolean) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-neutral-200">{server.name}</span>
          <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
            codex
          </span>
        </div>
        <p className="mt-0.5 truncate font-mono text-xs text-neutral-600">
          {server.detail || 'Unrecognized entry — open the file to see it'}
        </p>
      </div>
      <Switch
        label={`Enable ${server.name}`}
        checked={server.enabled}
        disabled={busy}
        onChange={onToggle}
      />
    </div>
  )
}

// ── 편집 모달 ─────────────────────────────────────────────────────────────

/** `KEY=VALUE` 줄 목록 ↔ 레코드. env·헤더 편집을 한 개의 textarea 로 끝내려고 쓴다. */
function parsePairs(text: string, separator: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const at = trimmed.indexOf(separator)
    if (at <= 0) continue
    out[trimmed.slice(0, at).trim()] = trimmed.slice(at + separator.length).trim()
  }
  return out
}

function formatPairs(pairs: Record<string, string>, separator: string): string {
  return Object.entries(pairs)
    .map(([key, value]) => `${key}${separator}${value}`)
    .join('\n')
}

function McpServerEditor({
  server,
  takenNames,
  onCancel,
  onSave
}: {
  server: WooiMcpServer
  takenNames: string[]
  onCancel: () => void
  onSave: (server: WooiMcpServer) => void
}): React.JSX.Element {
  const [name, setName] = useState(server.name)
  const [transport, setTransport] = useState<WooiMcpServer['transport']>(server.transport)
  const [command, setCommand] = useState(server.transport === 'stdio' ? server.command : '')
  const [args, setArgs] = useState(server.transport === 'stdio' ? server.args.join('\n') : '')
  const [env, setEnv] = useState(server.transport === 'stdio' ? formatPairs(server.env, '=') : '')
  const [url, setUrl] = useState(server.transport === 'stdio' ? '' : server.url)
  const [headers, setHeaders] = useState(
    server.transport === 'stdio' ? '' : formatPairs(server.headers, ': ')
  )

  const trimmedName = name.trim()
  const nameError = !trimmedName
    ? null
    : !isValidMcpServerName(trimmedName)
      ? 'Use letters, numbers, dashes and underscores only.'
      : takenNames.includes(trimmedName)
        ? 'Another Wooi-managed server already uses this name.'
        : null
  const ready =
    !!trimmedName &&
    !nameError &&
    (transport === 'stdio' ? !!command.trim() : /^https?:\/\//.test(url.trim()))

  const submit = (): void => {
    if (!ready) return
    const base = { id: server.id, name: trimmedName, enabled: server.enabled }
    onSave(
      transport === 'stdio'
        ? {
            ...base,
            transport: 'stdio',
            command: command.trim(),
            args: args
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean),
            env: parsePairs(env, '=')
          }
        : { ...base, transport, url: url.trim(), headers: parsePairs(headers, ':') }
    )
  }

  return (
    <Modal
      title={server.name ? `Edit ${server.name}` : 'Add MCP server'}
      onClose={onCancel}
      width={520}
    >
      <div className="space-y-4">
        <div>
          <label className={labelClass} htmlFor="mcp-name">
            Name
          </label>
          <input
            id="mcp-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="linear"
            className={inputClass}
          />
          <p
            className={`mt-1 text-xs ${nameError ? 'text-[var(--danger-400)]' : 'text-neutral-600'}`}
          >
            {nameError ?? 'Prefixes every tool this server provides.'}
          </p>
        </div>

        <div>
          <label className={labelClass} htmlFor="mcp-transport">
            Transport
          </label>
          <select
            id="mcp-transport"
            value={transport}
            onChange={(event) => setTransport(event.target.value as WooiMcpServer['transport'])}
            className={inputClass + ' text-sm'}
          >
            <option value="stdio">stdio — run a local command</option>
            <option value="http">http — streamable HTTP endpoint</option>
            <option value="sse">sse — server-sent events endpoint</option>
          </select>
        </div>

        {transport === 'stdio' ? (
          <>
            <div>
              <label className={labelClass} htmlFor="mcp-command">
                Command
              </label>
              <input
                id="mcp-command"
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                placeholder="npx"
                className={inputClass + ' font-mono text-sm'}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="mcp-args">
                Arguments — one per line
              </label>
              <textarea
                id="mcp-args"
                value={args}
                onChange={(event) => setArgs(event.target.value)}
                rows={3}
                placeholder={'-y\n@modelcontextprotocol/server-filesystem'}
                className={inputClass + ' font-mono text-sm'}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="mcp-env">
                Environment — KEY=value per line
              </label>
              <textarea
                id="mcp-env"
                value={env}
                onChange={(event) => setEnv(event.target.value)}
                rows={2}
                placeholder="API_TOKEN=…"
                className={inputClass + ' font-mono text-sm'}
              />
            </div>
          </>
        ) : (
          <>
            <div>
              <label className={labelClass} htmlFor="mcp-url">
                URL
              </label>
              <input
                id="mcp-url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com/mcp"
                className={inputClass + ' font-mono text-sm'}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="mcp-headers">
                Headers — Name: value per line
              </label>
              <textarea
                id="mcp-headers"
                value={headers}
                onChange={(event) => setHeaders(event.target.value)}
                rows={2}
                placeholder="Authorization: Bearer …"
                className={inputClass + ' font-mono text-sm'}
              />
            </div>
            <p className="text-xs leading-relaxed text-neutral-600">
              Remote servers reach Claude Code sessions only — Codex takes stdio servers from Wooi.
            </p>
          </>
        )}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onCancel} className={ghostBtn}>
          Cancel
        </button>
        <button onClick={submit} disabled={!ready} className={primaryBtn}>
          Save server
        </button>
      </div>
    </Modal>
  )
}
