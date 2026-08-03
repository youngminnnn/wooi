import { readFileSync, statSync } from 'node:fs'
import { relative, isAbsolute } from 'node:path'

/**
 * 파일을 바꾸는 도구 호출(Edit·Write·MultiEdit·NotebookEdit)의 **제안된 변경**을 통합 diff 로 만든다.
 *
 * 왜 필요한가: 승인 프롬프트가 `file_path` 한 줄만 보여 주면 사용자는 무엇을 승인하는지 모르는 채
 * Allow 를 누르게 된다. 터미널 `claude` 는 같은 자리에서 색칠된 diff 를 보여 주므로, 같은 판단
 * 근거를 주려면 도구 입력만으로 diff 를 재구성해야 한다(도구는 아직 실행 전이라 파일은 변경 전 상태다).
 *
 * 디스크의 현재 내용을 "before" 로 읽어 실제 줄 번호·주변 맥락이 있는 diff 를 만들고, 파일을 읽을 수
 * 없거나(새 파일·권한) old_string 을 찾지 못하면 도구 입력만으로 만든 맥락 없는 diff 로 폴백한다.
 * 어느 경로든 실패하면 null 을 돌려주고 호출부는 기존 요약 표시로 돌아간다 — diff 를 못 만드는 것이
 * 승인 자체를 막아서는 안 된다.
 */

/** 이 도구들의 승인 프롬프트/트랜스크립트에 diff 를 붙인다. */
const FILE_CHANGE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

/** before 로 읽어 들일 파일 크기 상한. 이보다 크면 맥락 없는 폴백 diff 를 쓴다. */
const MAX_FILE_BYTES = 2 * 1024 * 1024

/** diff 한 장의 줄 수 상한(IPC 페이로드·프롬프트 높이 보호). */
const MAX_DIFF_LINES = 600

/** LCS DP 를 돌릴 최대 셀 수. 넘으면 그 구간을 통째로 삭제+추가로 표시한다. */
const LCS_CELL_CAP = 250_000

/** 통합 diff 의 앞뒤 맥락 줄 수(git 기본값과 동일). */
const CONTEXT_LINES = 3

/** 이 도구 호출이 파일 변경인지(= diff 를 붙일 대상인지). */
export function isFileChangeTool(toolName: string): boolean {
  return FILE_CHANGE_TOOLS.has(toolName)
}

/**
 * 도구 입력에서 통합 diff 를 만든다. 만들 수 없으면 null.
 * @param cwd 표시용 경로를 상대 경로로 줄이는 기준(worktree 루트).
 */
export function buildFileChangeDiff(toolName: string, input: unknown, cwd: string): string | null {
  if (!isFileChangeTool(toolName) || !input || typeof input !== 'object') return null
  const obj = input as Record<string, unknown>
  const path = str(obj.file_path) ?? str(obj.notebook_path)
  if (!path) return null

  try {
    switch (toolName) {
      case 'Edit':
        return editDiff(path, cwd, [singleEdit(obj)])
      case 'MultiEdit':
        return editDiff(path, cwd, multiEdits(obj))
      case 'Write': {
        const content = str(obj.content)
        if (content === null) return null
        return diffAgainstDisk(path, cwd, () => content)
      }
      case 'NotebookEdit': {
        // 노트북은 JSON 컨테이너라 셀 하나를 파일 diff 로 정확히 그리기 어렵다.
        // 바뀌는 셀의 새 소스만 추가 블록으로 보여 준다(무엇이 들어가는지는 알 수 있다).
        const source = str(obj.new_source)
        if (source === null) return null
        const cell = str(obj.cell_id)
        const mode = str(obj.edit_mode) ?? 'replace'
        const label = cell ? `${display(path, cwd)} (cell ${cell}, ${mode})` : display(path, cwd)
        return clampDiff(
          synthetic(label, mode === 'delete' ? source : '', mode === 'delete' ? '' : source)
        )
      }
      default:
        return null
    }
  } catch {
    // 파일 접근·파싱 실패는 조용히 포기한다(프롬프트는 요약으로 폴백).
    return null
  }
}

// ── 도구별 before/after 구성 ────────────────────────────────────────────────

interface EditOp {
  oldString: string
  newString: string
  replaceAll: boolean
}

function singleEdit(obj: Record<string, unknown>): EditOp {
  return {
    oldString: str(obj.old_string) ?? '',
    newString: str(obj.new_string) ?? '',
    replaceAll: obj.replace_all === true
  }
}

function multiEdits(obj: Record<string, unknown>): EditOp[] {
  const edits = Array.isArray(obj.edits) ? obj.edits : []
  return edits
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .map(singleEdit)
}

/**
 * Edit/MultiEdit — 디스크의 현재 내용에 치환을 적용해 after 를 만든다.
 * 치환 대상을 찾지 못하면(파일이 이미 바뀌었거나 읽을 수 없음) 입력만으로 만든 폴백 diff 를 쓴다.
 */
function editDiff(path: string, cwd: string, edits: EditOp[]): string | null {
  if (edits.length === 0) return null

  const before = readIfReasonable(path)
  if (before !== null) {
    let after = before
    let applied = true
    for (const edit of edits) {
      if (edit.oldString === '') {
        applied = false
        break
      }
      if (!after.includes(edit.oldString)) {
        applied = false
        break
      }
      after = edit.replaceAll
        ? after.split(edit.oldString).join(edit.newString)
        : after.replace(edit.oldString, edit.newString)
    }
    if (applied && after !== before) {
      return clampDiff(unifiedDiff(display(path, cwd), before, after))
    }
  }

  // 폴백 — 줄 번호·주변 맥락 없이 "이 블록이 이 블록으로 바뀐다" 만 보여 준다.
  const oldText = edits.map((e) => e.oldString).join('\n')
  const newText = edits.map((e) => e.newString).join('\n')
  if (!oldText && !newText) return null
  return clampDiff(synthetic(display(path, cwd), oldText, newText))
}

/** Write — 디스크 내용(없으면 빈 파일)과 새 내용을 비교한다. */
function diffAgainstDisk(path: string, cwd: string, after: () => string): string | null {
  const before = readIfReasonable(path) ?? ''
  const next = after()
  if (before === next) return null
  return clampDiff(unifiedDiff(display(path, cwd), before, next))
}

// ── 통합 diff 생성 ──────────────────────────────────────────────────────────

type Tag = ' ' | '-' | '+'
interface Op {
  tag: Tag
  text: string
}

/** before/after 전체를 줄 단위로 비교해 통합 diff 문자열을 만든다. */
export function unifiedDiff(path: string, before: string, after: string): string {
  const a = splitLines(before)
  const b = splitLines(after)
  const ops = diffOps(a, b)
  const body = toHunks(ops)
  if (!body) return ''
  return [`--- a/${path}`, `+++ b/${path}`, body].join('\n')
}

/** 줄 번호·맥락 없이 삭제 블록 + 추가 블록만 나열한 diff(폴백용). */
function synthetic(path: string, before: string, after: string): string {
  const lines = [`--- a/${path}`, `+++ b/${path}`, '@@ proposed change @@']
  for (const line of before ? splitLines(before) : []) lines.push(`-${line}`)
  for (const line of after ? splitLines(after) : []) lines.push(`+${line}`)
  return lines.join('\n')
}

/**
 * 줄 배열 두 개의 차이를 연산 목록으로 만든다.
 *
 * 공통 접두/접미를 먼저 떼어 내(대개 파일의 대부분이 여기서 사라진다) 남은 구간만 LCS 로 맞춘다.
 * 남은 구간이 너무 크면 LCS 를 포기하고 통째로 삭제+추가로 표시한다 — 정확도보다 응답성이 중요한
 * 자리이고, 어차피 사용자는 "이 영역이 이렇게 바뀐다" 를 보면 된다.
 */
function diffOps(a: string[], b: string[]): Op[] {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }

  const ops: Op[] = []
  for (let i = 0; i < start; i++) ops.push({ tag: ' ', text: a[i] })
  ops.push(...diffMiddle(a.slice(start, endA), b.slice(start, endB)))
  for (let i = endA; i < a.length; i++) ops.push({ tag: ' ', text: a[i] })
  return ops
}

function diffMiddle(a: string[], b: string[]): Op[] {
  if (a.length === 0) return b.map((text) => ({ tag: '+' as const, text }))
  if (b.length === 0) return a.map((text) => ({ tag: '-' as const, text }))
  if (a.length * b.length > LCS_CELL_CAP) {
    return [
      ...a.map((text) => ({ tag: '-' as const, text })),
      ...b.map((text) => ({ tag: '+' as const, text }))
    ]
  }

  // LCS 길이 표 — 뒤에서부터 채워 앞에서 되짚는다.
  const n = a.length
  const m = b.length
  const width = m + 1
  const lcs = new Int32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1])
    }
  }

  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ tag: ' ', text: a[i] })
      i++
      j++
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      ops.push({ tag: '-', text: a[i] })
      i++
    } else {
      ops.push({ tag: '+', text: b[j] })
      j++
    }
  }
  while (i < n) ops.push({ tag: '-', text: a[i++] })
  while (j < m) ops.push({ tag: '+', text: b[j++] })
  return ops
}

/** 연산 목록을 맥락 줄이 붙은 통합 diff 헝크들로 묶는다. 변경이 없으면 빈 문자열. */
function toHunks(ops: Op[]): string {
  if (!ops.some((op) => op.tag !== ' ')) return ''

  // 각 연산의 원본/대상 줄 번호를 미리 매긴다.
  const aLines: number[] = []
  const bLines: number[] = []
  let a = 1
  let b = 1
  for (const op of ops) {
    aLines.push(a)
    bLines.push(b)
    if (op.tag !== '+') a++
    if (op.tag !== '-') b++
  }

  // 변경 줄 주변 CONTEXT_LINES 를 살린다. 범위가 겹치면 자연히 하나의 헝크로 합쳐진다.
  const keep = new Array<boolean>(ops.length).fill(false)
  ops.forEach((op, i) => {
    if (op.tag === ' ') return
    for (
      let k = Math.max(0, i - CONTEXT_LINES);
      k <= Math.min(ops.length - 1, i + CONTEXT_LINES);
      k++
    ) {
      keep[k] = true
    }
  })

  const out: string[] = []
  let i = 0
  while (i < ops.length) {
    if (!keep[i]) {
      i++
      continue
    }
    let end = i
    while (end + 1 < ops.length && keep[end + 1]) end++

    let aLen = 0
    let bLen = 0
    for (let k = i; k <= end; k++) {
      if (ops[k].tag !== '+') aLen++
      if (ops[k].tag !== '-') bLen++
    }
    // 한쪽이 0 줄이면 통합 diff 규약상 시작 번호를 하나 내린다(순수 추가/삭제 헝크).
    const aStart = aLen === 0 ? Math.max(0, aLines[i] - 1) : aLines[i]
    const bStart = bLen === 0 ? Math.max(0, bLines[i] - 1) : bLines[i]
    out.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`)
    for (let k = i; k <= end; k++) out.push(`${ops[k].tag}${ops[k].text}`)
    i = end + 1
  }
  return out.join('\n')
}

// ── 유틸 ────────────────────────────────────────────────────────────────────

function splitLines(text: string): string[] {
  // 빈 문자열은 "빈 줄 하나"가 아니라 "줄이 없음"이다 — 새 파일 diff 에 유령 삭제 줄이 생기지 않게.
  if (text === '') return []
  const lines = text.split('\n')
  // 끝 개행은 마지막 빈 줄을 만든다 — diff 에 유령 줄로 나오지 않게 뗀다.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** 파일이 작고 텍스트로 읽히면 내용을, 아니면 null(폴백 경로로 보낸다). */
function readIfReasonable(path: string): string | null {
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null // 새로 만드는 파일이거나 읽을 수 없다.
  }
}

/** worktree 안의 파일이면 상대 경로로 줄여 보여 준다(프롬프트 폭이 좁다). */
function display(path: string, cwd: string): string {
  if (!isAbsolute(path)) return path
  const rel = relative(cwd, path)
  return rel && !rel.startsWith('..') ? rel : path
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** 아주 큰 변경은 앞부분만 남긴다 — 프롬프트가 화면을 넘겨 버튼을 밀어내면 승인 자체를 못 한다. */
function clampDiff(diff: string): string | null {
  if (!diff) return null
  const lines = diff.split('\n')
  if (lines.length <= MAX_DIFF_LINES) return diff
  const omitted = lines.length - MAX_DIFF_LINES
  return [...lines.slice(0, MAX_DIFF_LINES), `… ${omitted.toLocaleString()} more diff lines`].join(
    '\n'
  )
}
