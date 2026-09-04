import { FileWarning } from 'lucide-react'
import {
  MAX_GIT_READ_BYTES,
  type DiffRenderLimit,
  type DiffSideLines
} from '@shared/diffRenderLimit'

/**
 * "이 diff 는 안 그린다" 를 **숫자로** 설명하는 카드.
 *
 * 그냥 숨기면 사용자는 Wooi 가 고장 났다고 읽는다. 원본/수정 줄 수, 문자 수, 걸린 한계가
 * 무엇이고 그 값이 얼마인지까지 적어야 "내 파일이 이만큼 크구나" 로 읽힌다 — 그게 이 카드가
 * 존재하는 이유고, 여기서 숫자를 빼면 카드도 뺄 이유가 생긴다.
 */

const formatter = new Intl.NumberFormat()

/** 세다 멈춘 값은 `20,001+` 로 적는다. 정확한 척하지 않는다. */
function formatSide(side: DiffSideLines): string {
  return `${formatter.format(side.lines)}${side.atLeast ? '+' : ''}`
}

function Shell({
  title,
  rows,
  footer
}: {
  title: string
  rows: { label: string; value: string }[]
  footer: string
}): React.JSX.Element {
  return (
    <div className="flex gap-3 bg-[var(--code-bg)] px-3 py-4 text-xs text-neutral-400">
      <FileWarning size={14} className="mt-0.5 shrink-0 text-[var(--warning-400)]" />
      <div className="min-w-0 space-y-2">
        <p className="text-neutral-200">{title}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 sm:grid-cols-[auto_1fr_auto_1fr]">
          {rows.map((row) => (
            <div key={row.label} className="contents">
              <dt className="text-neutral-500">{row.label}</dt>
              <dd className="font-mono tabular-nums text-neutral-300">{row.value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-neutral-500">{footer}</p>
      </div>
    </div>
  )
}

/** 렌더 상한에 걸린 경우 — 본문은 있지만 그리지 않기로 한 것. */
export function LargeDiffNotice({
  limit
}: {
  limit: Extract<DiffRenderLimit, { limited: true }>
}): React.JSX.Element {
  const reason =
    limit.reason === 'lines'
      ? 'Line count is over the safe display limit'
      : 'Character count is over the safe display limit'

  return (
    <Shell
      title="This file's diff is too large to display safely."
      rows={[
        { label: 'Original lines', value: formatSide(limit.original) },
        { label: 'Modified lines', value: formatSide(limit.modified) },
        { label: 'Characters', value: formatter.format(limit.characters) },
        { label: 'Reason', value: reason }
      ]}
      footer={`Limits: ${formatter.format(limit.limits.maxLinesPerSide)} lines per side · ${formatter.format(limit.limits.maxCharacters)} characters. Open the whole file in the file viewer to read it.`}
    />
  )
}

/**
 * main 이 본문을 아예 못 실어 온 경우 — 브랜치 전체 diff 가 git 읽기 한도를 넘었다.
 *
 * 줄 수는 numstat 에서 온 값이라 정확하지만 **변경된 줄만** 안다(문맥 줄은 본문에만 있다).
 * 그래서 양쪽 면의 줄 수는 최소값으로 적는다.
 */
export function OmittedPatchNotice({
  additions,
  deletions
}: {
  additions: number
  deletions: number
}): React.JSX.Element {
  const megabytes = Math.round(MAX_GIT_READ_BYTES / (1024 * 1024))
  return (
    <Shell
      title="This file's diff could not be loaded."
      rows={[
        { label: 'Original lines', value: `${formatter.format(deletions)}+` },
        { label: 'Modified lines', value: `${formatter.format(additions)}+` },
        { label: 'Changed lines', value: `+${additions} −${deletions}` },
        { label: 'Reason', value: `Branch diff is over the ${megabytes} MB read limit` }
      ]}
      footer={`Limit: ${megabytes} MB per git read. Line counts came from git's summary, so they count changed lines only. Open the whole file in the file viewer to read it.`}
    />
  )
}
