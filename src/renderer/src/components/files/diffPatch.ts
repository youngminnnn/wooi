/**
 * 파일 1개의 통합 diff(`FileDiff.patch`)를 **줄마다 번호가 붙은** 행으로 쪼갠다.
 *
 * Changes 탭은 지금까지 patch 를 통짜 문자열로 색만 입혀 그렸다. 라인 코멘트를 달려면 화면의
 * 한 줄이 "새 파일 몇 번째 줄"인지 알아야 하므로(그래야 `@path#L40-45` 멘션을 만든다) 여기서
 * 번호를 계산한다.
 *
 * `main/review/diff.ts` 와 목적이 겹치지만 입력이 다르다 — 저쪽은 `gh pr diff` 의 **여러 파일**
 * 원문을 받아 GitHub 인라인 코멘트용 주소를 만들고, 이쪽은 이미 파일별로 쪼개진 patch 를 받아
 * 화면에 그린다. 렌더러는 main 모듈을 import 할 수 없기도 해서(tsconfig 가 갈라져 있다) 억지로
 * 합치지 않고, hunk 를 "헤더가 말한 줄 수만큼 읽는다"는 핵심 규칙만 같은 방식으로 지킨다.
 */

export type PatchRowKind = 'context' | 'add' | 'del'

export interface PatchRow {
  kind: PatchRowKind
  /** 앞의 +/-/공백 표식을 뗀 코드 본문. */
  text: string
  /** 옛 파일에서의 줄 번호. add 행은 null. */
  oldLine: number | null
  /** 새 파일에서의 줄 번호. del 행은 null. */
  newLine: number | null
  /**
   * 새 파일 기준 앵커 줄. del 행은 새 파일에 자리가 없으므로 **삭제된 내용이 있던 자리**
   * (= 그 다음 새 줄 번호)를 가리킨다. 삭제만 고른 코멘트도 파일 안의 위치를 잃지 않게 하는 값이다.
   */
  anchor: number
}

export interface PatchHunk {
  /** "@@ -1,7 +1,9 @@ fn foo()" 원문 헤더(뒤쪽 섹션 힌트 포함). */
  header: string
  rows: PatchRow[]
}

interface HunkRange {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
}

/** patch 본문에서 hunk 들을 뽑는다. hunk 가 없으면(모드 변경 등) 빈 배열. */
export function parsePatch(patch: string): PatchHunk[] {
  if (!patch.trim()) return []
  const lines = trimTrailingEmpty(patch.split('\n'))
  const hunks: PatchHunk[] = []

  for (let i = 0; i < lines.length; i++) {
    const header = lines[i]
    if (!header.startsWith('@@')) continue
    const range = parseHunkHeader(header)
    if (!range) continue
    const { rows, next } = readRows(lines, i + 1, range)
    hunks.push({ header, rows })
    i = next - 1
  }
  return hunks
}

function trimTrailingEmpty(lines: string[]): string[] {
  let end = lines.length
  while (end > 0 && lines[end - 1] === '') end--
  return lines.slice(0, end)
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
 * hunk 본문을 읽는다. 접두사만 보고 끊지 않고 **헤더가 말한 줄 수를 다 채울 때까지** 읽는다 —
 * 원본이 빈 줄인 문맥 행은 " "(공백 한 칸)이어야 하지만 뒤쪽 공백이 잘려 ""로 오는 경우가 흔하고,
 * 접두사만 믿으면 거기서 hunk 가 끝난 줄 알고 이후 줄 번호가 통째로 밀린다.
 */
function readRows(
  lines: string[],
  start: number,
  range: HunkRange
): { rows: PatchRow[]; next: number } {
  const rows: PatchRow[] = []
  let oldLine = range.oldStart
  let newLine = range.newStart
  let oldLeft = range.oldCount
  let newLeft = range.newCount
  let i = start

  while (i < lines.length && (oldLeft > 0 || newLeft > 0)) {
    const line = lines[i]
    if (line.startsWith('@@') || line.startsWith('diff --git ')) break

    // "\ No newline at end of file" 은 줄 수에 포함되지 않는다.
    if (line.startsWith('\\')) {
      i++
      continue
    }

    const marker = line[0]
    const text = line.slice(1)

    if (marker === '+') {
      rows.push({ kind: 'add', text, oldLine: null, newLine, anchor: newLine })
      newLine++
      newLeft--
    } else if (marker === '-') {
      // 삭제된 줄이 있던 자리 = 지금의 새 줄 번호. 새 파일이 그 앞에서 끝났다면 1 미만이 될 수
      // 없도록 잡아 준다(파일 전체 삭제 hunk 는 newStart 가 0 으로 온다).
      rows.push({ kind: 'del', text, oldLine, newLine: null, anchor: Math.max(1, newLine) })
      oldLine++
      oldLeft--
    } else {
      // 공백 접두사, 또는 접두사가 잘려나간 빈 줄 → 문맥 행.
      rows.push({
        kind: 'context',
        text: marker === ' ' ? text : line,
        oldLine,
        newLine,
        anchor: newLine
      })
      oldLine++
      newLine++
      oldLeft--
      newLeft--
    }
    i++
  }

  return { rows, next: i }
}

/** diff 한 줄 앞에 붙는 표식. */
export function rowSign(row: PatchRow): string {
  return row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '
}
