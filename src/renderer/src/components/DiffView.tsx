import { useEffect, useMemo, useState } from 'react'
import {
  Loader2,
  FilePlus2,
  FileMinus2,
  FilePen,
  FileCode,
  Maximize2,
  MessageSquarePlus,
  Undo2
} from 'lucide-react'
import type { FileDiff, WorkspaceDiff } from '@shared/types'
import { branchLineTotal } from '@shared/codePaths'
import { diffRenderLimit } from '@shared/diffRenderLimit'
import { hunkPatch, parsePatch, rowSign, type PatchHunk, type PatchRow } from './files/diffPatch'
import type { DiffComment, DiffCommentAnchor } from '../lib/diffComments'
import { diffWrapClasses, type DiffWrapClasses } from '../lib/diffWordWrap'
import DiffCommentBox from './diff/DiffCommentBox'
import DiffCommentCard from './diff/DiffCommentCard'
import BranchLineTotalChip from './diff/BranchLineTotalChip'
import DiffNavButtons from './diff/DiffNavButtons'
import { DiffChangeAnchor, DiffNavProvider } from './diff/diffNav'
import { LargeDiffNotice, OmittedPatchNotice } from './diff/LargeDiffNotice'

/**
 * base 브랜치 대비 변경을 파일별로 표시한다(통합 diff).
 * 변경 보기 모달([[DiffModal]])과 우측 패널의 Changes 탭이 공유한다.
 *
 * 기본은 읽기 전용이다 — 여기서 스테이징하거나 커밋하지 않는다. 커밋은 계속 에이전트의 몫이다.
 * 다만 두 가지 배선을 선택적으로 받는다:
 *
 * - `commenting` — 줄마다 코멘트를 달 수 있다. 그 코멘트는 파일이 아니라 **에이전트에게 보낼
 *   메시지**가 된다.
 * - `discarding` — hunk 하나를 워킹 트리에서 되돌린다. 코멘트가 "고쳐 달라고 부탁하는 길"이라면
 *   이쪽은 "그냥 내가 지우는 길"이다 — 왕복 한 턴과 토큰을 쓸 필요가 없는 변경을 위한 것이다.
 */
export interface DiffCommenting {
  /** 이 diff 에 달려 있는, 아직 보내지 않은 코멘트 전부. */
  comments: DiffComment[]
  onAdd: (anchor: DiffCommentAnchor, body: string) => void
  onEdit: (id: string, body: string) => void
  onRemove: (id: string) => void
}

/**
 * hunk 버리기 배선. 주지 않으면 버튼 자체가 그려지지 않는다 — 지금은 워크스페이스의 Changes
 * 패널만 준다(모달·PR 리뷰 화면의 diff 는 되돌릴 워킹 트리가 없거나, 남의 코드다).
 */
export interface DiffDiscarding {
  /**
   * 지금은 되돌릴 수 없는 이유. null 이면 되돌릴 수 있다.
   *
   * 이유가 있으면 버튼을 **숨기지 않고 잠근다.** 없어진 버튼은 사용자에게 "이 앱은 이걸 못
   * 한다"로 읽히지만, 잠긴 버튼은 툴팁으로 "지금은 안 된다, 왜냐하면"까지 말할 수 있다.
   */
  blockedReason: string | null
  /** `patch` 는 이 hunk 만 담은 완결된 patch 다([[hunkPatch]]). */
  onDiscard: (file: FileDiff, patch: string) => void
}

const NO_COMMENTS: DiffComment[] = []
const NO_HUNKS: PatchHunk[] = []
const NO_FILES: FileDiff[] = []

export default function DiffView({
  diff,
  loading,
  baseBranch,
  onOpenFile,
  commenting,
  discarding,
  wrap = true
}: {
  diff: WorkspaceDiff | null
  loading: boolean
  baseBranch: string
  /**
   * 파일 전문을 큰 뷰어로 여는 콜백. 주지 않으면 버튼이 뜨지 않는다 —
   * 모달 안의 diff 는 뒤에 오버레이를 띄울 수 없어 호출자가 뺀다.
   */
  onOpenFile?: (path: string) => void
  /** 라인 코멘트 배선. 주지 않으면 읽기 전용으로만 그린다. */
  commenting?: DiffCommenting
  /** hunk 버리기 배선. 주지 않으면 버리기 버튼이 뜨지 않는다. */
  discarding?: DiffDiscarding
  /**
   * 긴 줄을 접을지. 끄면 정렬을 지키고 가로로 민다([[diffWordWrap]]).
   * 에디터의 워드랩과는 별개 값이다 — 두 화면이 원하는 게 반대다.
   */
  wrap?: boolean
}): React.JSX.Element {
  // 코멘트를 파일별로 갈라 둔다 — 파일 블록마다 전체 목록을 훑지 않게.
  const byPath = useMemo(() => {
    const map = new Map<string, DiffComment[]>()
    for (const c of commenting?.comments ?? NO_COMMENTS) {
      const list = map.get(c.path)
      if (list) list.push(c)
      else map.set(c.path, [c])
    }
    return map
  }, [commenting?.comments])

  // 이른 반환(로딩·변경 없음)보다 위에 둔다 — 훅은 건너뛸 수 없다.
  const total = useMemo(() => branchLineTotal(diff?.files ?? NO_FILES), [diff?.files])

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

  return (
    <DiffNavProvider>
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-xs text-neutral-500">
          <span>
            {diff.files.length} file{diff.files.length > 1 ? 's' : ''}
          </span>
          <span aria-hidden="true">·</span>
          <BranchLineTotalChip total={total} />
          <span className="flex-1" />
          <DiffNavButtons />
        </div>
        {diff.files.map((f) => (
          <FileBlock
            key={f.path}
            file={f}
            onOpenFile={onOpenFile}
            commenting={commenting}
            discarding={discarding}
            comments={byPath.get(f.path) ?? NO_COMMENTS}
            wrap={wrap}
          />
        ))}
      </div>
    </DiffNavProvider>
  )
}

/** 파일 안에서 고른 구간(hunk 인덱스 + 그 hunk 안의 행 인덱스, 양끝 포함). */
interface RowRange {
  hunk: number
  from: number
  to: number
}

function FileBlock({
  file,
  onOpenFile,
  commenting,
  discarding,
  comments,
  wrap
}: {
  file: FileDiff
  onOpenFile?: (path: string) => void
  commenting?: DiffCommenting
  discarding?: DiffDiscarding
  comments: DiffComment[]
  wrap: boolean
}): React.JSX.Element {
  // 상한 판정이 먼저다. parsePatch 는 행마다 객체를 만들므로, 그리지 않기로 한 patch 를
  // 파싱하는 것만으로도 이미 늦는다.
  const limit = useMemo(() => diffRenderLimit(file.patch), [file.patch])
  const hunks = useMemo(
    () => (limit.limited ? NO_HUNKS : parsePatch(file.patch)),
    [file.patch, limit.limited]
  )
  const cls = diffWrapClasses(wrap)
  // 사용자가 직접 접거나 편 상태. 손대지 않았으면 크기와 코멘트 유무로 정한다 — 방금 단 코멘트가
  // 접힌 파일 안에 숨어 버리면 어디에 썼는지 확인할 길이 없다.
  const [openOverride, setOpenOverride] = useState<boolean | null>(null)
  const open = openOverride ?? (comments.length > 0 || file.additions + file.deletions <= 400)
  // 삭제된 파일은 worktree 에 없어 전문을 열 수 없다.
  const canOpen = !!onOpenFile && file.status !== 'deleted'

  // 드래그로 고르는 중인 구간과, 입력 상자가 열려 있는 구간.
  const [drag, setDrag] = useState<RowRange | null>(null)
  const [draft, setDraft] = useState<RowRange | null>(null)

  // 버튼을 놓는 순간 고른 구간이 확정된다. 마우스가 diff 밖에서 올라와도 받아야 해서 window 에 건다.
  useEffect(() => {
    if (!drag) return
    const finish = (): void => {
      setDraft({
        hunk: drag.hunk,
        from: Math.min(drag.from, drag.to),
        to: Math.max(drag.from, drag.to)
      })
      setDrag(null)
    }
    window.addEventListener('mouseup', finish)
    return () => window.removeEventListener('mouseup', finish)
  }, [drag])

  const toggle = (): void => {
    const next = !open
    setOpenOverride(next)
    if (!next) {
      setDrag(null)
      setDraft(null)
    }
  }

  const placed = useMemo(
    () => placeComments(hunks, comments, file.status === 'deleted'),
    [hunks, comments, file.status]
  )

  /** 고른 구간을 코멘트로 굳힌다 — 지금 diff 기준의 줄 범위를 뽑아 둔다. */
  const addComment = (range: RowRange, body: string): void => {
    const hunk = hunks[range.hunk]
    if (!commenting || !hunk) return
    const rows = hunk.rows.slice(range.from, range.to + 1)
    if (!rows.length) return
    const deleted = file.status === 'deleted'
    const numbers = rows
      .map((r) => (deleted ? r.oldLine : r.newLine))
      .filter((n): n is number => n !== null)
    // 삭제 줄만 고른 경우엔 새 파일에 자리가 없다 — 삭제된 내용이 있던 자리로 앵커를 잡는다.
    const from = numbers.length ? Math.min(...numbers) : rows[0].anchor
    const to = numbers.length ? Math.max(...numbers) : rows[rows.length - 1].anchor
    commenting.onAdd({ path: file.path, deleted, from, to }, body)
    setDraft(null)
  }

  const selection = drag ?? draft

  return (
    <div
      data-diff-file={file.path}
      className="rounded-lg border border-[var(--border)] overflow-hidden"
    >
      <div className="flex items-center gap-2 px-3 py-2 bg-[var(--bg-3)] hover:bg-[var(--surface)]">
        <button
          onClick={toggle}
          className="flex-1 min-w-0 flex items-center gap-2 text-left"
          title={open ? 'Collapse this file' : 'Expand this file'}
        >
          <StatusIcon status={file.status} />
          <span className="flex-1 truncate text-sm font-mono text-neutral-200">{file.path}</span>
        </button>
        {comments.length > 0 && (
          <span
            title={`${comments.length} unsent comment${comments.length > 1 ? 's' : ''} on this file`}
            className="shrink-0 rounded-full bg-[var(--info-500)]/20 px-2 py-0.5 text-2xs font-medium text-[var(--info-300)]"
          >
            {comments.length}
          </span>
        )}
        {file.binary ? (
          <span className="text-xs text-neutral-500">binary</span>
        ) : (
          <span className="text-xs font-mono shrink-0">
            <span className="text-[var(--success-400)]">+{file.additions}</span>{' '}
            <span className="text-[var(--danger-400)]">−{file.deletions}</span>
          </span>
        )}
        {canOpen && (
          <button
            onClick={() => onOpenFile?.(file.path)}
            aria-label={`Open ${file.path} in the file viewer`}
            title="Open the whole file in the file viewer"
            className="shrink-0 grid h-6 w-6 place-items-center rounded text-neutral-500 hover:bg-[var(--surface-2)] hover:text-neutral-100"
          >
            <Maximize2 size={12} />
          </button>
        )}
      </div>

      {open && !file.binary && file.patch && hunks.length > 0 && (
        <div className={cls.body}>
          {hunks.map((hunk, hi) => (
            // hunk 하나가 곧 변경 덩어리다 — F7 이 뛰어다니는 단위.
            <DiffChangeAnchor key={hi}>
              <div className={`${cls.hunkHeader} group/hunk flex items-center gap-2`}>
                <span className="min-w-0 flex-1 truncate">{hunk.header}</span>
                {discarding && (
                  <DiscardHunkButton
                    path={file.path}
                    blockedReason={discarding.blockedReason}
                    onDiscard={() => discarding.onDiscard(file, hunkPatch(file, hunk))}
                  />
                )}
              </div>
              {hunk.rows.map((row, ri) => (
                <Row
                  key={ri}
                  row={row}
                  selected={
                    !!selection &&
                    selection.hunk === hi &&
                    ri >= Math.min(selection.from, selection.to) &&
                    ri <= Math.max(selection.from, selection.to)
                  }
                  canComment={!!commenting}
                  cls={cls}
                  onStart={() => {
                    setDraft(null)
                    setDrag({ hunk: hi, from: ri, to: ri })
                  }}
                  onExtend={() => {
                    if (drag && drag.hunk === hi) setDrag({ ...drag, to: ri })
                  }}
                >
                  {draft && draft.hunk === hi && draft.to === ri && (
                    <DiffCommentBox
                      submitLabel="Add comment"
                      onSubmit={(body) => addComment(draft, body)}
                      onCancel={() => setDraft(null)}
                    />
                  )}
                  {(placed.at.get(`${hi}:${ri}`) ?? NO_COMMENTS).map((c) => (
                    <DiffCommentCard
                      key={c.id}
                      comment={c}
                      onEdit={(body) => commenting?.onEdit(c.id, body)}
                      onRemove={() => commenting?.onRemove(c.id)}
                    />
                  ))}
                </Row>
              ))}
            </DiffChangeAnchor>
          ))}
          <OrphanComments comments={placed.orphans} commenting={commenting} />
        </div>
      )}

      {/* main 이 본문을 못 실어 왔다(브랜치 diff 가 git 읽기 한도를 넘음). */}
      {open && !file.binary && file.patchOmitted && (
        <OmittedPatchNotice additions={file.additions} deletions={file.deletions} />
      )}

      {/* 본문은 있지만 그리면 렌더러가 멎는 크기 — 숫자로 이유를 대신한다. */}
      {open && !file.binary && file.patch && limit.limited && (
        <div className="bg-[var(--code-bg)]">
          <LargeDiffNotice limit={limit} />
          {/* hunk 가 없으니 이 파일의 코멘트는 전부 orphan 이다. 안 보인다고 버리지는 않는다. */}
          <OrphanComments comments={placed.orphans} commenting={commenting} />
        </div>
      )}

      {/* hunk 를 못 뽑은 patch(모드 변경 등)는 예전처럼 통짜로 색만 입혀 보여 준다. */}
      {open && !file.binary && file.patch && !limit.limited && hunks.length === 0 && (
        <pre className="overflow-x-auto text-xs font-mono leading-[1.45] bg-[var(--code-bg)] m-0">
          {file.patch.split('\n').map((line, i) => (
            <DiffLine key={i} line={line} />
          ))}
        </pre>
      )}
    </div>
  )
}

/**
 * hunk 머리글에 붙는 "이 hunk 버리기".
 *
 * 잠겼을 때 툴팁을 **감싼 span 에** 단다. 브라우저는 `disabled` 버튼에 마우스 이벤트를 주지
 * 않아서 버튼 자신의 title 은 절대 뜨지 않는다 — 이유를 말하려고 잠근 버튼인데 그러면 아무
 * 말도 못 하게 된다.
 */
function DiscardHunkButton({
  path,
  blockedReason,
  onDiscard
}: {
  path: string
  blockedReason: string | null
  onDiscard: () => void
}): React.JSX.Element {
  return (
    <span
      className="shrink-0"
      title={blockedReason ?? 'Discard this hunk — these lines go back to what they were'}
    >
      <button
        onClick={onDiscard}
        disabled={!!blockedReason}
        aria-label={`Discard this hunk in ${path}`}
        className="grid h-5 w-5 place-items-center rounded text-neutral-500 opacity-0 transition-opacity hover:bg-[var(--danger-500)]/20 hover:text-[var(--danger-400)] focus-visible:opacity-100 disabled:cursor-not-allowed disabled:text-neutral-700 disabled:hover:bg-transparent disabled:hover:text-neutral-700 group-hover/hunk:opacity-100"
      >
        <Undo2 size={11} />
      </button>
    </span>
  )
}

/** diff 가 바뀌어 원래 줄이 사라진 코멘트. 버리지 않고 파일 끝에 모아 둔다. */
function OrphanComments({
  comments,
  commenting
}: {
  comments: DiffComment[]
  commenting?: DiffCommenting
}): React.JSX.Element | null {
  if (comments.length === 0) return null
  return (
    <div className="border-t border-[var(--border)]">
      <p className="px-3 py-1 text-2xs text-neutral-500 font-sans">
        No longer matches the current diff:
      </p>
      {comments.map((c) => (
        <DiffCommentCard
          key={c.id}
          comment={c}
          onEdit={(body) => commenting?.onEdit(c.id, body)}
          onRemove={() => commenting?.onRemove(c.id)}
        />
      ))}
    </div>
  )
}

function Row({
  row,
  selected,
  canComment,
  cls,
  onStart,
  onExtend,
  children
}: {
  row: PatchRow
  selected: boolean
  canComment: boolean
  /** 워드랩이 만드는 클래스 차이([[diffWordWrap]]). */
  cls: DiffWrapClasses
  onStart: () => void
  onExtend: () => void
  /** 이 줄 아래에 끼워 넣을 것(입력 상자·코멘트 카드). */
  children?: React.ReactNode
}): React.JSX.Element {
  const tone =
    row.kind === 'add'
      ? 'bg-[var(--success-500)]/10 text-[var(--diff-add)]'
      : row.kind === 'del'
        ? 'bg-[var(--danger-500)]/10 text-[var(--diff-del)]'
        : 'text-[var(--diff-context)]'

  return (
    <>
      <div
        className={`${cls.row} ${selected ? 'bg-[var(--info-500)]/25' : tone}`}
        onMouseEnter={onExtend}
      >
        <span className="w-10 shrink-0 select-none px-1.5 text-right text-neutral-600 tabular-nums">
          {row.oldLine ?? ''}
        </span>
        <span className="w-10 shrink-0 select-none px-1.5 text-right text-neutral-600 tabular-nums">
          {row.newLine ?? ''}
        </span>
        {canComment && (
          <span className="w-5 shrink-0 select-none">
            <button
              // mousedown 에서 시작해야 아래로 끌어 여러 줄을 고를 수 있다. 기본 동작을 막아
              // 드래그가 텍스트 선택으로 새지 않게 한다.
              onMouseDown={(e) => {
                e.preventDefault()
                onStart()
              }}
              title="Comment on this line (drag to select a range)"
              aria-label="Comment on this line"
              className="grid h-full w-full place-items-center rounded bg-[var(--info-600)] text-white opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
            >
              <MessageSquarePlus size={11} />
            </button>
          </span>
        )}
        <span className="w-3 shrink-0 select-none text-neutral-600">{rowSign(row)}</span>
        <span className={cls.code}>{row.text || ' '}</span>
      </div>
      {children && <div className={cls.aside}>{children}</div>}
    </>
  )
}

/**
 * 코멘트를 지금 diff 의 어느 행 아래에 그릴지 정한다.
 *
 * 줄 번호가 그대로 남아 있으면 그 행에, 없으면 같은 자리를 가리키는 행(anchor)에 붙인다.
 * 둘 다 실패하면 orphan 이다 — 코멘트를 쓴 뒤 에이전트가 그 파일을 또 고친 경우로, 위치를 잃었다고
 * 내용까지 버리지는 않는다(파일 끝에 모아 보여 주고, 전송 메시지에는 그대로 실린다).
 */
function placeComments(
  hunks: PatchHunk[],
  comments: DiffComment[],
  deleted: boolean
): { at: Map<string, DiffComment[]>; orphans: DiffComment[] } {
  const at = new Map<string, DiffComment[]>()
  const orphans: DiffComment[] = []

  for (const c of comments) {
    let exact: string | null = null
    let nearby: string | null = null
    for (let hi = 0; hi < hunks.length && exact === null; hi++) {
      const rows = hunks[hi].rows
      for (let ri = 0; ri < rows.length; ri++) {
        const line = deleted ? rows[ri].oldLine : rows[ri].newLine
        if (line === c.to) {
          exact = `${hi}:${ri}`
          break
        }
        if (nearby === null && !deleted && rows[ri].anchor === c.to) nearby = `${hi}:${ri}`
      }
    }
    const key = exact ?? nearby
    if (!key) {
      orphans.push(c)
      continue
    }
    const list = at.get(key)
    if (list) list.push(c)
    else at.set(key, [c])
  }

  return { at, orphans }
}

/**
 * 통합 diff 한 줄의 색칠. 승인 프롬프트처럼 구조화된 WorkspaceDiff 없이 **원시 diff 문자열만**
 * 가진 곳에서도 같은 시각 언어를 쓰도록 내보낸다(색 규칙이 두 벌로 갈라지지 않게).
 */
export function DiffLine({ line }: { line: string }): React.JSX.Element {
  // 색은 --diff-* 토큰으로 — diff 는 코드 표면(--code-bg) 위에 그려지고, 그 표면은
  // 테마마다 밝기가 달라서 고정 색으로는 한쪽 테마에서 대비가 무너진다.
  let cls = 'text-[var(--diff-context)]'
  let bg = ''
  if (line.startsWith('+') && !line.startsWith('+++')) {
    cls = 'text-[var(--diff-add)]'
    bg = 'bg-[var(--success-500)]/10'
  } else if (line.startsWith('-') && !line.startsWith('---')) {
    cls = 'text-[var(--diff-del)]'
    bg = 'bg-[var(--danger-500)]/10'
  } else if (line.startsWith('@@')) {
    cls = 'text-[var(--diff-hunk)]'
  } else if (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('+++') ||
    line.startsWith('---')
  ) {
    cls = 'text-[var(--diff-meta)]'
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
