import { useState } from 'react'
import { ChevronRight, Loader2, Wrench } from 'lucide-react'
import type { ChatItem } from '@shared/types'
import { formatToolGroup, type ToolGroup } from '@shared/toolGroups'
import { ToolCard } from './ToolCard'
import type { ToolGroupStyleProps } from './styleProps'
import { SELECTABLE, unlessSelecting } from '../../lib/selection'

export function ToolGroupCard({
  group,
  results,
  style,
  verbose
}: {
  group: ToolGroup
  results: ReadonlyMap<string, Extract<ChatItem, { type: 'tool_result' }>>
  style: 'wooi' | 'terminal'
  verbose: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const expanded = verbose || open
  const props: ToolGroupStyleProps = {
    label: formatToolGroup(group),
    hint: group.latestHint,
    active: group.active,
    open: expanded,
    toggle: () => setOpen((value) => !value),
    children: expanded ? (
      <div className="mt-1 space-y-2 pl-4">
        {group.uses.map((use) => (
          <div key={use.id} data-item-id={use.id}>
            <ToolCard
              use={use}
              result={results.get(use.toolId)}
              pending={group.active && !results.has(use.toolId)}
              style={style}
              verbose={verbose}
            />
          </div>
        ))}
      </div>
    ) : undefined
  }
  return (
    <>
      {/* 다른 검색 화면이 원본 항목 id로 점프해도 접힌 대표 행 안의 실제 DOM에 도착해야 한다. */}
      {!expanded &&
        group.uses.flatMap((use, index) => {
          const result = results.get(use.toolId)
          return [
            ...(index > 0 ? [<span key={use.id} data-item-id={use.id} className="sr-only" />] : []),
            ...(result
              ? [<span key={result.id} data-item-id={result.id} className="sr-only" />]
              : [])
          ]
        })}
      {style === 'terminal' ? <TerminalGroup {...props} /> : <WooiGroup {...props} />}
    </>
  )
}

function WooiGroup({ label, hint, active, open, toggle, children }: ToolGroupStyleProps) {
  return (
    <div className="text-sm">
      <button
        type="button"
        aria-expanded={open}
        onClick={unlessSelecting(toggle)}
        className={`flex w-full items-center gap-1.5 text-left text-neutral-400 hover:text-neutral-200 ${SELECTABLE}`}
      >
        {active ? (
          <Loader2 size={12} className="shrink-0 animate-spin text-[var(--warning-500)]/80" />
        ) : (
          <Wrench size={12} className="shrink-0 text-[var(--warning-500)]/80" />
        )}
        <span className="truncate text-neutral-300">{label}</span>
        <ChevronRight
          size={12}
          className={`${open ? 'rotate-90 ' : ''}ml-auto shrink-0 transition`}
        />
      </button>
      {hint && (
        <div className="ml-4 truncate text-xs text-neutral-500">
          ⎿ {hint}
          {active && ' …'}
        </div>
      )}
      {children}
    </div>
  )
}

function TerminalGroup({ label, hint, active, open, toggle, children }: ToolGroupStyleProps) {
  return (
    <div className="font-mono text-sm text-neutral-300">
      <button
        type="button"
        aria-expanded={open}
        onClick={unlessSelecting(toggle)}
        className={`block w-full text-left hover:text-neutral-100 ${SELECTABLE}`}
      >
        <span className={active ? 'text-[var(--warning-500)]' : 'text-[var(--accent-400)]'}>⏺</span>{' '}
        <span>{label}</span>
      </button>
      {hint && (
        <div className="truncate text-xs text-neutral-500">
          {'  ⎿ '}
          {hint}
          {active && ' …'}
        </div>
      )}
      {children}
    </div>
  )
}
