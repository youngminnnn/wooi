import type {
  DiffRow,
  DiffSide,
  FileDiffStatus,
  ReviewAnchor,
  ReviewDiff,
  ReviewFileDiff,
  ReviewFindingInput,
  ReviewHunk,
  ReviewLayerDiff
} from '@shared/types'

/**
 * PR diff 를 "줄마다 주소가 있는" 형태로 파싱한다.
 *
 * git.ts 의 parseUnifiedDiff 와 목적이 다르다 — 저쪽은 patch 를 통짜 문자열로 두고 화면에
 * 색만 입히면 되지만, 리뷰 모드는 각 줄의 old/new 번호를 알아야 GitHub 인라인 코멘트를 걸 수
 * 있다. diff 에 없는 줄에 코멘트를 걸면 422 로 거절되므로, 파싱 정확도가 곧 기능의 정확도다.
 *
 * 입력은 `gh pr diff <n>` 의 출력을 그대로 쓴다. GitHub 이 계산한 PR diff 와 동일하므로
 * "코멘트를 걸 수 있는 줄"의 집합이 서버와 정확히 일치한다.
 */

/** 에이전트가 준 줄이 diff 에 없을 때, 이 거리 안의 유효한 줄로 끌어당긴다. */
const SNAP_DISTANCE = 3

// ── 파싱 ────────────────────────────────────────────────────────────────

export function parseReviewDiff(raw: string): ReviewDiff {
  if (!raw.trim()) return { files: [] }
  const files = raw
    .split(/^diff --git /m)
    .filter((chunk) => chunk.trim())
    .map((chunk) => parseFileChunk(chunk))
    .filter((f): f is ReviewFileDiff => f !== null)
  return { files }
}

function parseFileChunk(chunk: string): ReviewFileDiff | null {
  // 뒤쪽 빈 줄을 먼저 턴다. hunk 본문은 헤더가 알려준 줄 수만큼 읽는데(readHunkRows 참고),
  // 헤더의 개수가 실제 내용보다 크면(손상된 diff) 남은 자리를 채우려고 파일 끝의 빈 줄까지
  // 문맥 행으로 삼켜 유령 줄 번호가 생긴다. 실제 git 출력에서 내용이 빈 문맥 행은 " "(공백)
  // 으로 오므로, 여기서 잘려나가는 것은 구분자뿐이다.
  const lines = trimTrailingEmpty(`diff --git ${chunk}`.split('\n'))

  const binary = lines.some((l) => l.startsWith('Binary files') || l.startsWith('GIT binary patch'))

  let status: FileDiffStatus = 'modified'
  if (lines.some((l) => l.startsWith('new file'))) status = 'added'
  else if (lines.some((l) => l.startsWith('deleted file'))) status = 'deleted'
  else if (lines.some((l) => l.startsWith('rename '))) status = 'renamed'

  const { path, oldPath } = resolvePaths(lines, status)
  if (!path) return null

  const hunks: ReviewHunk[] = []
  let additions = 0
  let deletions = 0

  for (let i = 0; i < lines.length; i++) {
    const header = lines[i]
    if (!header.startsWith('@@')) continue
    const range = parseHunkHeader(header)
    if (!range) continue

    const { rows, next } = readHunkRows(lines, i + 1, range.oldCount, range.newCount, range)
    for (const r of rows) {
      if (r.kind === 'add') additions++
      else if (r.kind === 'del') deletions++
    }
    hunks.push({ header, rows })
    i = next - 1
  }

  return { path, oldPath, status, additions, deletions, binary, hunks }
}

function trimTrailingEmpty(lines: string[]): string[] {
  let end = lines.length
  while (end > 0 && lines[end - 1] === '') end--
  return lines.slice(0, end)
}

interface HunkRange {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
}

/** "@@ -12,7 +12,9 @@ 섹션힌트" 에서 범위를 뽑는다. count 생략은 1을 뜻한다. */
function parseHunkHeader(header: string): HunkRange | null {
  const m = header.match(/^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
  if (!m) return null
  return {
    oldStart: Number(m[1]),
    oldCount: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newCount: m[4] === undefined ? 1 : Number(m[4])
  }
}

/**
 * hunk 본문을 읽는다.
 *
 * 접두사만 보고 자르지 않고 **헤더의 줄 수를 다 채울 때까지** 읽는 것이 핵심이다. 원본이 빈
 * 줄인 문맥 행은 " "(공백 한 칸)으로 와야 정상이지만, 도구·전송 과정에서 뒤쪽 공백이 잘려
 * ""(빈 문자열)로 오는 경우가 흔하다. 접두사 기준으로만 판단하면 그 줄에서 hunk 가 끝난 것으로
 * 오인해 이후 모든 줄 번호가 밀린다 — 코멘트가 엉뚱한 줄에 달리는 가장 흔한 원인이다.
 */
function readHunkRows(
  lines: string[],
  start: number,
  oldCount: number,
  newCount: number,
  range: HunkRange
): { rows: DiffRow[]; next: number } {
  const rows: DiffRow[] = []
  let oldLine = range.oldStart
  let newLine = range.newStart
  let oldLeft = oldCount
  let newLeft = newCount
  let i = start

  while (i < lines.length && (oldLeft > 0 || newLeft > 0)) {
    const line = lines[i]

    // 다음 파일/hunk 헤더를 만나면 hunk 가 조기 종료된 것이다(깨진 diff 방어).
    if (line.startsWith('@@') || line.startsWith('diff --git ')) break

    // "\ No newline at end of file" 은 줄 수에 포함되지 않는다.
    if (line.startsWith('\\')) {
      i++
      continue
    }

    const marker = line[0]
    const text = line.slice(1)

    if (marker === '+') {
      rows.push({ kind: 'add', text, oldLine: null, newLine })
      newLine++
      newLeft--
    } else if (marker === '-') {
      rows.push({ kind: 'del', text, oldLine, newLine: null })
      oldLine++
      oldLeft--
    } else {
      // 공백 접두사, 또는 접두사가 잘려나간 빈 줄 → 문맥 행.
      rows.push({ kind: 'context', text: marker === ' ' ? text : line, oldLine, newLine })
      oldLine++
      newLine++
      oldLeft--
      newLeft--
    }
    i++
  }

  return { rows, next: i }
}

function resolvePaths(
  lines: string[],
  status: FileDiffStatus
): { path: string | null; oldPath: string | null } {
  const renameFrom = prefixed(lines, 'rename from ')
  const renameTo = prefixed(lines, 'rename to ')
  if (status === 'renamed' && renameTo) {
    return { path: unquote(renameTo), oldPath: renameFrom ? unquote(renameFrom) : null }
  }

  const plus = stripGitPrefix(prefixed(lines, '+++ '))
  const minus = stripGitPrefix(prefixed(lines, '--- '))

  // 삭제된 파일은 +++ 가 /dev/null 이므로 옛 경로를 쓴다(GitHub 도 이 경로로 코멘트를 받는다).
  const path = plus ?? minus ?? headerPath(lines[0])
  return { path: path ?? null, oldPath: status === 'renamed' ? (minus ?? null) : null }
}

function prefixed(lines: string[], prefix: string): string | undefined {
  return lines.find((l) => l.startsWith(prefix))?.slice(prefix.length)
}

function stripGitPrefix(p: string | undefined): string | undefined {
  if (!p || p === '/dev/null') return undefined
  // "+++ b/foo\t2024-01-01" 처럼 탭 뒤에 타임스탬프가 붙는 경우가 있다.
  const cleaned = unquote(p.split('\t')[0])
  if (cleaned === '/dev/null') return undefined
  return cleaned.replace(/^[ab]\//, '')
}

/** "diff --git a/foo b/foo" 헤더에서 best-effort 로 경로를 뽑는다. */
function headerPath(header: string | undefined): string | undefined {
  if (!header) return undefined
  const m = header.match(/^diff --git a\/(.+?) b\//)
  return m?.[1]
}

/** git 은 특수문자가 든 경로를 큰따옴표로 감싸 이스케이프한다. */
function unquote(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p
  const inner = p.slice(1, -1)
  return inner.replace(/\\(.)/g, '$1')
}

// ── 에이전트에게 줄 번호를 명시해서 넘기기 ──────────────────────────────────

/**
 * 각 줄 앞에 `RIGHT:123` / `LEFT:45` 라벨을 박아 렌더한다.
 *
 * 에이전트가 hunk 헤더를 보고 줄 번호를 직접 세게 두면 반드시 틀린다. 셀 필요 자체를 없애는
 * 것이 인라인 코멘트 오배치를 줄이는 가장 효과적인 수단이다.
 */
export function renderNumberedDiff(diff: ReviewDiff, prNumber?: number): string {
  const out: string[] = []
  for (const file of diff.files) {
    out.push(renderFileHeader(file, prNumber))
    out.push(...renderFileBody(file))
  }
  return out.join('\n')
}

/**
 * 파일 헤더. 스택 리뷰에서는 **경로 앞에 PR 번호를 박는다** — 에이전트가 앵커를 정할 때 보는
 * 바로 그 줄에 번호가 있어야, 어느 레이어의 파일인지 따로 기억하지 않아도 된다.
 */
export function renderFileHeader(file: ReviewFileDiff, prNumber?: number): string {
  const tag = prNumber === undefined ? '' : `[#${prNumber}] `
  return `=== ${tag}${file.path} (${file.status})`
}

/** 헤더를 뺀 파일 본문(번호가 박힌 행들). 예산 배분이 파일 단위로 붙였다 뗐다 할 수 있어야 한다. */
export function renderFileBody(file: ReviewFileDiff): string[] {
  const out: string[] = []
  if (file.binary) {
    out.push('  (binary — 코멘트 불가)')
    out.push('')
    return out
  }
  if (file.oldPath) out.push(`  (renamed from ${file.oldPath})`)
  for (const hunk of file.hunks) {
    out.push(`  ${hunk.header}`)
    for (const row of hunk.rows) {
      out.push(`  ${label(row)} ${sign(row)}${row.text}`)
    }
  }
  out.push('')
  return out
}

function label(row: DiffRow): string {
  // 문맥 행은 양쪽 다 걸 수 있지만, 기본은 RIGHT 를 권한다(새 코드 기준 리뷰).
  if (row.kind === 'del') return `LEFT:${row.oldLine}`.padEnd(12)
  return `RIGHT:${row.newLine}`.padEnd(12)
}

function sign(row: DiffRow): string {
  return row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '
}

// ── 앵커 검증 / 스냅 ─────────────────────────────────────────────────────

export interface AnchorResult {
  anchor: ReviewAnchor | null
  /** 앵커링에 실패한 이유. general 로 강등할 때 본문에 덧붙인다. */
  reason: string | null
}

/**
 * 에이전트가 준 (파일, 줄, side) 가 diff 안에 실제로 존재하는지 검증한다.
 *
 * 존재하지 않으면 같은 파일에서 SNAP_DISTANCE 안의 유효한 줄로 끌어당기고, 그래도 없으면
 * anchor=null 을 돌려준다. 호출부는 그 지적을 **버리지 않고** general 로 강등한다 — 위치가
 * 틀렸다고 리뷰 내용까지 사라지면 안 된다.
 */
export function resolveAnchor(
  diff: ReviewDiff,
  input: ReviewFindingInput,
  prNumber?: number
): AnchorResult {
  if (!input.file || typeof input.line !== 'number' || !Number.isFinite(input.line)) {
    return { anchor: null, reason: null }
  }

  const file = findFile(diff, input.file)
  if (!file) return { anchor: null, reason: `diff 에 없는 파일: ${input.file}` }
  if (file.binary) return { anchor: null, reason: `바이너리 파일: ${file.path}` }

  const side: DiffSide = input.side === 'LEFT' ? 'LEFT' : 'RIGHT'
  const available = commentableLines(file, side)
  if (available.size === 0) {
    return { anchor: null, reason: `${file.path} 의 ${side} 면에는 코멘트를 걸 수 있는 줄이 없음` }
  }

  const line = snap(available, input.line)
  if (line === null) {
    return { anchor: null, reason: `diff 에 없는 줄: ${file.path}:${input.line} (${side})` }
  }

  // 멀티라인은 시작 줄도 같은 면에서 유효해야 하고 끝 줄보다 앞서야 한다.
  // 조건을 못 맞추면 멀티라인을 포기하고 한 줄 코멘트로 떨어뜨린다(지적 자체는 살린다).
  let startLine: number | null = null
  if (typeof input.startLine === 'number' && Number.isFinite(input.startLine)) {
    const snapped = snap(available, input.startLine)
    if (snapped !== null && snapped < line) startLine = snapped
  }

  return {
    anchor: {
      ...(prNumber === undefined ? {} : { prNumber }),
      file: file.path,
      side,
      line,
      startLine,
      snappedFrom: line === input.line ? null : input.line
    },
    reason: null
  }
}

/**
 * 스택 전체(레이어 N 개의 diff)에서 앵커를 확정한다.
 *
 * **레이어 사이로 흘러 내려가지 않는 것**이 이 함수의 핵심 규칙이다. 스택에서는 같은 경로가
 * 여러 레이어에 있고 줄 번호도 겹치기 쉬운데, 한 레이어에서 못 찾았다고 다음 레이어를 뒤지면
 * 422 가 아니라 **엉뚱한 PR 에 그럴듯하게 달린 코멘트**가 나온다. 422 는 실패로 보이지만
 * 이쪽은 성공으로 보여서, 리뷰어도 작성자도 알아채지 못한다.
 *
 * 규칙:
 * 1. 에이전트가 PR 번호를 줬고 그 레이어가 있으면 **그 레이어 안에서만** 푼다. 실패하면 강등.
 * 2. 번호가 없으면 그 경로를 가진 레이어를 찾는다. 하나면 그것.
 * 3. 여러 레이어가 그 경로를 가졌으면, 그중 **해당 줄이 실제로 존재하는** 레이어가 정확히
 *    하나일 때만 채택한다. 아니면 강등한다 — 둘 중 하나를 찍는 것이 바로 위의 실패 모드다.
 */
export function resolveStackAnchor(
  layers: ReviewLayerDiff[],
  input: ReviewFindingInput
): AnchorResult {
  if (layers.length === 0) return { anchor: null, reason: 'diff 가 없음' }
  // 레이어가 하나뿐이면 PR 번호는 물어볼 것도 없다(단일 PR 리뷰가 그대로 이 경로를 탄다).
  if (layers.length === 1) return resolveAnchor(layers[0].diff, input, layers[0].prNumber)

  if (typeof input.prNumber === 'number') {
    const layer = layers.find((l) => l.prNumber === input.prNumber)
    if (!layer) {
      return { anchor: null, reason: `스택에 없는 PR: #${input.prNumber}` }
    }
    return resolveAnchor(layer.diff, input, layer.prNumber)
  }

  if (!input.file) return { anchor: null, reason: null }

  // 번호를 안 줬다 — 경로로 좁힌다.
  const candidates = layers.filter((l) => findFile(l.diff, input.file!) !== null)
  if (candidates.length === 0) {
    return { anchor: null, reason: `어느 레이어의 diff 에도 없는 파일: ${input.file}` }
  }
  if (candidates.length === 1) {
    return resolveAnchor(candidates[0].diff, input, candidates[0].prNumber)
  }

  // 여러 레이어가 같은 파일을 건드렸다 — 그 줄이 실제로 있는 레이어로만 좁힌다.
  const resolved = candidates
    .map((l) => ({ layer: l, result: resolveAnchor(l.diff, input, l.prNumber) }))
    .filter((r) => r.result.anchor !== null)
  if (resolved.length === 1) return resolved[0].result
  const where = candidates.map((l) => `#${l.prNumber}`).join(', ')
  return {
    anchor: null,
    reason:
      resolved.length === 0
        ? `${input.file}:${input.line} 이(가) ${where} 어디에도 없음`
        : `${input.file}:${input.line} 이(가) ${where} 여러 곳에 있어 PR 을 특정할 수 없음`
  }
}

/**
 * 경로를 찾는다. 정확히 일치가 원칙이지만, 에이전트가 워크트리 절대경로나 `./` 접두사를 붙여
 * 주는 일이 잦아 접미사 일치까지 허용한다(모호하면 포기 — 엉뚱한 파일에 다는 것보다 낫다).
 */
function findFile(diff: ReviewDiff, wanted: string): ReviewFileDiff | null {
  const norm = wanted.replace(/^\.\//, '').replace(/^\/+/, '')
  const exact = diff.files.find((f) => f.path === norm)
  if (exact) return exact

  const suffix = diff.files.filter((f) => norm.endsWith(f.path) || f.path.endsWith(norm))
  return suffix.length === 1 ? suffix[0] : null
}

function commentableLines(file: ReviewFileDiff, side: DiffSide): Set<number> {
  const set = new Set<number>()
  for (const hunk of file.hunks) {
    for (const row of hunk.rows) {
      const n = side === 'LEFT' ? row.oldLine : row.newLine
      if (n !== null) set.add(n)
    }
  }
  return set
}

/** 정확히 있으면 그대로, 없으면 가장 가까운 유효 줄(동률이면 위쪽). 범위 밖이면 null. */
function snap(available: Set<number>, line: number): number | null {
  if (available.has(line)) return line
  for (let d = 1; d <= SNAP_DISTANCE; d++) {
    if (available.has(line - d)) return line - d
    if (available.has(line + d)) return line + d
  }
  return null
}
