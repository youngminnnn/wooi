import { useState } from 'react'
import { Loader2, FilePlus2, FileMinus2, FilePen, FileCode } from 'lucide-react'
import type { FileDiff, WorkspaceDiff } from '@shared/types'

/**
 * base 브랜치 대비 변경을 파일별로 표시한다(통합 diff).
 * 변경 보기 모달([[DiffModal]])과 우측 패널의 Changes 탭이 공유한다.
 */
export default function DiffView({
  diff,
  loading,
  baseBranch
}: {
  diff: WorkspaceDiff | null
  loading: boolean
  baseBranch: string
}): React.JSX.Element {
  if (loading) {
    return (
      <div className="grid place-items-center py-16 text-neutral-500">
        <Loader2 size={20} className="animate-spin" />
      </div>
    )
  }
  if (!diff || diff.files.length === 0) {
    return (
      <p className="py-16 text-center text-base text-neutral-500">
        No changes relative to {baseBranch}.
      </p>
    )
  }

  const totalAdd = diff.files.reduce((n, f) => n + f.additions, 0)
  const totalDel = diff.files.reduce((n, f) => n + f.deletions, 0)

  return (
    <div className="space-y-3">
      <div className="text-xs text-neutral-500">
        {diff.files.length} file{diff.files.length > 1 ? 's' : ''} ·{' '}
        <span className="text-[var(--success-400)]">+{totalAdd}</span>{' '}
        <span className="text-[var(--danger-400)]">−{totalDel}</span>
      </div>
      {diff.files.map((f) => (
        <FileBlock key={f.path} file={f} />
      ))}
    </div>
  )
}

function FileBlock({ file }: { file: FileDiff }): React.JSX.Element {
  const [open, setOpen] = useState(file.additions + file.deletions <= 400)

  return (
    <div className="rounded-lg border border-[var(--border)] overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-[var(--bg-3)] hover:bg-[var(--surface)] text-left"
      >
        <StatusIcon status={file.status} />
        <span className="flex-1 truncate text-sm font-mono text-neutral-200">{file.path}</span>
        {file.binary ? (
          <span className="text-xs text-neutral-500">binary</span>
        ) : (
          <span className="text-xs font-mono shrink-0">
            <span className="text-[var(--success-400)]">+{file.additions}</span>{' '}
            <span className="text-[var(--danger-400)]">−{file.deletions}</span>
          </span>
        )}
      </button>
      {open && !file.binary && file.patch && (
        <pre className="overflow-x-auto text-xs font-mono leading-[1.45] bg-[var(--code-bg)] m-0">
          {file.patch.split('\n').map((line, i) => (
            <DiffLine key={i} line={line} />
          ))}
        </pre>
      )}
    </div>
  )
}

function DiffLine({ line }: { line: string }): React.JSX.Element {
  let cls = 'text-neutral-500'
  let bg = ''
  if (line.startsWith('+') && !line.startsWith('+++')) {
    cls = 'text-[var(--success-300)]'
    bg = 'bg-[var(--success-500)]/10'
  } else if (line.startsWith('-') && !line.startsWith('---')) {
    cls = 'text-[var(--danger-300)]'
    bg = 'bg-[var(--danger-500)]/10'
  } else if (line.startsWith('@@')) {
    cls = 'text-cyan-400'
  } else if (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('+++') ||
    line.startsWith('---')
  ) {
    cls = 'text-neutral-600'
  }
  return <div className={`px-3 ${cls} ${bg}`}>{line || ' '}</div>
}

function StatusIcon({ status }: { status: FileDiff['status'] }): React.JSX.Element {
  const common = 'shrink-0'
  if (status === 'added')
    return <FilePlus2 size={13} className={`${common} text-[var(--success-400)]`} />
  if (status === 'deleted')
    return <FileMinus2 size={13} className={`${common} text-[var(--danger-400)]`} />
  if (status === 'renamed')
    return <FileCode size={13} className={`${common} text-[var(--accent-400)]`} />
  return <FilePen size={13} className={`${common} text-[var(--warning-400)]`} />
}
