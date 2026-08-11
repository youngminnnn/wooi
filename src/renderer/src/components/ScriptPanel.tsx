import { useEffect, useMemo, useState } from 'react'
import { Check, MonitorPlay, Play, Settings2, Square, SquareArrowOutUpRight, X } from 'lucide-react'
import { SETUP_SCRIPT_ID } from '@shared/types'
import { detectDevUrl } from '@shared/devUrl'
import { openRepoSettings } from '../lib/repoSettings'
import { scriptKey, useStore } from '../store'

export default function ScriptPanel({
  workspaceId,
  onClose,
  fill
}: {
  workspaceId: string
  onClose?: () => void
  fill?: boolean
}): React.JSX.Element {
  const app = useStore((s) => s.app)!
  const ws = app.workspaces.find((w) => w.id === workspaceId)!
  const repo = app.repos.find((r) => r.id === ws.repoId)!
  const statuses = useStore((s) => s.scriptStatus[workspaceId]) ?? []
  const output = useStore((s) => s.scriptOutput)
  const refresh = useStore((s) => s.refreshScriptStatus)
  const seed = useStore((s) => s.seedScriptOutput)
  const detach = useStore((s) => s.detachPane)
  const entries = [
    ...repo.runScripts.map((script) => ({ ...script, setup: false })),
    { id: SETUP_SCRIPT_ID, name: 'Setup', command: repo.setupScript, autoStart: false, setup: true }
  ]
  const [selected, setSelected] = useState(repo.runScripts[0]?.id ?? SETUP_SCRIPT_ID)
  const current = entries.find((item) => item.id === selected) ?? entries[0]
  const status = statuses.find((item) => item.scriptId === current.id)
  const running = status?.state === 'running'
  const setupDone = current.setup && ws.setupState === 'success'
  const out = output[scriptKey(workspaceId, current.id)] ?? ''

  // dev 서버가 스스로 찍은 주소. 포트를 스캔하지 않고 출력만 읽는다([[shared/devUrl]]).
  // 돌고 있는 스크립트에만 붙인다 — 죽은 서버 주소로 Preview 를 여는 건 도움이 안 된다.
  const devUrl = useMemo(() => (running ? detectDevUrl(out) : null), [running, out])

  useEffect(() => {
    void seed(workspaceId, current.id)
  }, [seed, workspaceId, current.id])

  const toggle = (id: string): void => {
    const active = statuses.find((item) => item.scriptId === id)?.state === 'running'
    const action = active
      ? window.api.script.stop(workspaceId, id)
      : window.api.script.run(workspaceId, id)
    void action.then(() => refresh(workspaceId))
  }

  return (
    <div
      className={
        fill
          ? 'h-full bg-[var(--bg-2)] flex flex-col min-h-0'
          : 'shrink-0 h-64 border-t border-[var(--border)] bg-[var(--bg-2)] flex flex-col'
      }
    >
      <div className="h-9 shrink-0 flex items-center border-b border-[var(--border)] px-2">
        <span className="text-xs text-neutral-400">Scripts</span>
        <div className="flex-1" />
        {onClose && (
          <>
            <button
              onClick={() => detach('scripts')}
              className="h-6 w-6 grid place-items-center text-neutral-500"
            >
              <SquareArrowOutUpRight size={13} />
            </button>
            <button onClick={onClose} className="h-6 w-6 grid place-items-center text-neutral-500">
              <X size={14} />
            </button>
          </>
        )}
      </div>
      <div className="flex flex-1 min-h-0">
        <div className="w-36 shrink-0 border-r border-[var(--border)] overflow-auto py-1">
          {repo.runScripts.length === 0 && (
            <button
              onClick={() => openRepoSettings(repo.id)}
              className="m-2 text-left text-xs text-neutral-500 hover:text-neutral-300"
            >
              <Settings2 size={12} className="inline mr-1" />
              Add run scripts in repository settings
            </button>
          )}
          {entries.map((item, index) => (
            <div
              key={item.id}
              className={
                (item.setup && index > 0 ? 'mt-1 border-t border-[var(--border)] pt-1 ' : '') +
                'group flex items-center px-2 hover:bg-[var(--surface-2)] ' +
                (selected === item.id ? 'bg-[var(--surface-2)]' : '')
              }
            >
              <button
                onClick={() => setSelected(item.id)}
                className="flex min-w-0 flex-1 items-center gap-1.5 py-2 text-left text-xs text-neutral-300"
              >
                <span
                  className={
                    'h-2 w-2 shrink-0 rounded-full ' +
                    (statuses.find((s) => s.scriptId === item.id)?.state === 'running'
                      ? 'bg-[var(--success-400)]'
                      : statuses.find((s) => s.scriptId === item.id)?.state === 'exited' &&
                          statuses.find((s) => s.scriptId === item.id)?.exitCode
                        ? 'bg-[var(--danger-400)]'
                        : 'bg-neutral-600')
                  }
                />
                <span className="truncate">{item.name}</span>
              </button>
              {item.command.trim() && !(item.setup && ws.setupState === 'success') && (
                <button
                  onClick={() => toggle(item.id)}
                  className="opacity-0 group-hover:opacity-100 text-neutral-400 hover:text-neutral-100"
                >
                  {statuses.find((s) => s.scriptId === item.id)?.state === 'running' ? (
                    <Square size={11} fill="currentColor" />
                  ) : (
                    <Play size={11} fill="currentColor" />
                  )}
                </button>
              )}
              {item.setup && ws.setupState === 'success' && (
                <Check size={11} className="text-[var(--success-400)]" />
              )}
            </div>
          ))}
        </div>
        <div className="flex flex-1 min-w-0 flex-col">
          <div className="px-3 py-1.5 flex items-center gap-2 text-xs text-neutral-600 font-mono border-b border-[var(--border)]">
            <span className="truncate">$ {current.command || 'No command configured'}</span>
            {ws.ports[current.id] != null && (
              <span className="ml-auto">PORT={ws.ports[current.id]}</span>
            )}
            {running && <Square size={10} />}
            {setupDone && <Check size={10} />}
          </div>
          {devUrl && (
            <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-[var(--border)] bg-[var(--info-500)]/5">
              <MonitorPlay size={12} className="shrink-0 text-[var(--info-400)]" />
              <span className="min-w-0 flex-1 truncate text-xs text-neutral-400">
                Dev server at <span className="font-mono text-neutral-300">{devUrl}</span>
              </span>
              <button
                onClick={() => void window.api.preview.open(workspaceId, devUrl)}
                className="shrink-0 text-xs px-2 py-0.5 rounded-md bg-[var(--info-600)] text-white hover:bg-[var(--info-500)]"
              >
                Open in Preview
              </button>
            </div>
          )}
          <pre className="flex-1 overflow-auto px-3 py-2 text-xs font-mono text-neutral-400 whitespace-pre-wrap">
            {current.command.trim()
              ? out || 'No output yet.'
              : 'Configure this script in repository settings.'}
          </pre>
        </div>
      </div>
    </div>
  )
}
