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
  ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean }>
> = {
  'shield-question': ShieldQuestion,
  loader: Loader2,
  hourglass: Hourglass,
  clock: Clock,
  'alert-triangle': AlertTriangle,
  terminal: Terminal,
  'circle-stop': CircleStop
}

/**
 * 상태 표시 점/아이콘. 사이드바 행과 ⌘K 퀵 스위처, 현황판이 같은 시각 언어를 쓰도록 공유한다.
 *
 * **색 말고도 이름이 있어야 한다.** 이 표시는 상태를 오직 색으로만 구분했다 — 점 분기는
 * `role` 없는 빈 `<span>` 이라 보조 기술이 아예 건너뛰었고(`title` 만으로는 노출되지 않는다),
 * 아이콘 분기의 `aria-label` 은 `descriptor.aria` 가 있는 몇 칸에만 붙어 나머지는 이름이 없었다.
 * 그래서 두 분기 모두 `role="img"` 로 이름 붙일 수 있는 요소가 되게 하고, 이름은
 * `aria`(그 칸을 위해 따로 쓴 문장) → `label`(짧은 사람 라벨) 순으로 고른다.
 *
 * `title` 은 그대로 둔다 — 눈으로 보는 사람의 툴팁은 더 길어도 되고(실행 시간·PR 번호 등),
 * 목록을 소리로 훑는 사람에게는 짧은 라벨이 맞다.
 */
export function StatusDot(input: WorkspaceStatusInput): React.JSX.Element {
  const descriptor = describeWorkspaceStatus(input)
  const name = descriptor.aria ?? descriptor.label

  if (descriptor.icon === 'dot') {
    return (
      <span
        role="img"
        aria-label={name}
        title={descriptor.title}
        className={`h-2 w-2 rounded-full shrink-0 ${descriptor.toneClass}`}
      />
    )
  }

  const Icon = ICONS[descriptor.icon]
  return (
    <span
      role="img"
      aria-label={name}
      title={descriptor.title}
      className="shrink-0 grid place-items-center"
    >
      {/* 이름은 바깥 span 이 가진다 — svg 에도 aria-label 을 두면 같은 문장이 두 번 읽힌다. */}
      <Icon
        size={descriptor.size}
        className={descriptor.toneClass + (descriptor.spin ? ' animate-spin' : '')}
        aria-hidden
      />
    </span>
  )
}
