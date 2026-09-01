import {
  AlertTriangle,
  CircleStop,
  Clock,
  Hourglass,
  Loader2,
  ShieldQuestion,
  Terminal
} from 'lucide-react'
import type { ComponentType } from 'react'
import { describeWorkspaceStatus, type WorkspaceStatusInput } from '../lib/workspaceStatus'
import type { WorkspaceStatusDescriptor } from '../lib/workspaceStatus'

type IconKey = Exclude<WorkspaceStatusDescriptor['icon'], 'dot'>

const ICONS: Record<
  IconKey,
  ComponentType<{ size?: number; className?: string; 'aria-label'?: string }>
> = {
  'shield-question': ShieldQuestion,
  loader: Loader2,
  hourglass: Hourglass,
  clock: Clock,
  'alert-triangle': AlertTriangle,
  terminal: Terminal,
  'circle-stop': CircleStop
}

/** 상태 표시 점/아이콘. 사이드바 행과 ⌘K 퀵 스위처, 현황판이 같은 시각 언어를 쓰도록 공유한다. */
export function StatusDot(input: WorkspaceStatusInput): React.JSX.Element {
  const descriptor = describeWorkspaceStatus(input)

  if (descriptor.icon === 'dot') {
    return (
      <span
        title={descriptor.title}
        className={`h-2 w-2 rounded-full shrink-0 ${descriptor.toneClass}`}
      />
    )
  }

  const Icon = ICONS[descriptor.icon]
  return (
    <span title={descriptor.title} className="shrink-0 grid place-items-center">
      <Icon
        size={descriptor.size}
        className={descriptor.toneClass + (descriptor.spin ? ' animate-spin' : '')}
        aria-label={descriptor.aria}
      />
    </span>
  )
}
