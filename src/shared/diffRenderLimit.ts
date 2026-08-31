/**
 * 이 patch 를 그려도 안전한지 판정한다 — 그리기 **전에**.
 *
 * Changes 탭은 diff 를 가상 스크롤 없이 통째로 DOM 에 편다(행 하나가 div 1 + span 4). 지금까지
 * 유일한 방어선은 400 줄이 넘으면 기본으로 접어 두는 것뿐이었고, 사용자가 펼치면 몇 줄이든
 * 그대로 렌더했다. 에이전트가 만든 생성 파일 하나(lock 파일 재생성, 스냅샷 갱신)면 렌더러가
 * 그 자리에서 언다 — 편의가 아니라 취약점이다.
 *
 * 판정은 여기서만 한다(순수 함수). 컴포넌트는 결과만 받아 그린다.
 */

/**
 * 한쪽(원본/수정) 면에 그려질 줄 수의 상한.
 *
 * 근거: 행 하나가 DOM 노드 5개 안팎이므로 20,000 줄이면 한 파일에 10만 노드다. 이 언저리가
 * 렌더러가 한 프레임에 레이아웃을 끝내지 못하고 눈에 띄게 멎기 시작하는 지점이고, 그 위는
 * "느리다" 가 아니라 "응답이 없다" 로 넘어간다. 기존 자동 접힘 기준(400 줄)보다 두 자릿수
 * 위로 잡아, 평범하게 큰 파일은 예전처럼 펼쳐 볼 수 있게 남긴다.
 */
export const MAX_DIFF_LINES_PER_SIDE = 20_000

/**
 * 양쪽 합계 문자 수의 상한.
 *
 * 줄 수만으로는 못 막는 경우가 있다 — 번들·최소화된 JS 는 한 줄이 수 MB 다. 줄 수는 한 자리인데
 * 텍스트 양이 브라우저의 줄바꿈 계산을 통째로 잡아먹는다. 20,000 줄 × 줄당 60자 ≈ 1.2M 이므로
 * 같은 크기대의 값으로 잡아, 두 상한이 같은 무게를 서로 다른 방향에서 막게 한다.
 */
export const MAX_DIFF_CHARACTERS = 2_000_000

export interface DiffRenderLimits {
  maxLinesPerSide: number
  maxCharacters: number
}

/** 한쪽 면의 줄 수. `atLeast` 면 세다 멈춘 값이라 실제는 이보다 크다(화면에 `+` 로 붙는다). */
export interface DiffSideLines {
  lines: number
  atLeast: boolean
}

/** 무엇에 걸렸는지 — 카드가 "왜 안 보이는지" 를 말할 수 있어야 하므로 이유를 남긴다. */
export type DiffRenderLimitReason = 'lines' | 'characters'

export type DiffRenderLimit =
  | { limited: false }
  | {
      limited: true
      reason: DiffRenderLimitReason
      original: DiffSideLines
      modified: DiffSideLines
      characters: number
      limits: DiffRenderLimits
    }

const LIMITS: DiffRenderLimits = {
  maxLinesPerSide: MAX_DIFF_LINES_PER_SIDE,
  maxCharacters: MAX_DIFF_CHARACTERS
}

/**
 * 통합 patch 한 개가 상한에 걸리는지 본다.
 *
 * 줄 수는 면마다 따로 센다 — 통합 diff 에서 원본 면은 문맥 + 삭제, 수정 면은 문맥 + 추가다.
 * 한쪽이 상한을 넘는 순간 스캔을 멈춘다. 이미 결론이 났는데 32MB 를 끝까지 훑을 이유가 없고,
 * 대신 그 시점의 두 값은 모두 "최소한 이만큼" 이므로 `atLeast` 로 표시해 카드가 `20,001+`
 * 처럼 정직하게 적게 한다.
 *
 * 문자 수는 `patch.length` 라 공짜다. 줄 수 판정을 먼저 두는 것은 그쪽이 사용자에게 더
 * 구체적인 이유이기 때문이다("줄이 너무 많다" > "글자가 너무 많다").
 */
export function diffRenderLimit(patch: string): DiffRenderLimit {
  const characters = patch.length
  const { original, modified } = countSides(patch)

  if (original.atLeast || modified.atLeast) {
    return { limited: true, reason: 'lines', original, modified, characters, limits: LIMITS }
  }
  if (characters > MAX_DIFF_CHARACTERS) {
    return { limited: true, reason: 'characters', original, modified, characters, limits: LIMITS }
  }
  return { limited: false }
}

/**
 * 양쪽 면의 줄 수를 한 번의 훑기로 센다.
 *
 * hunk **본문만** 센다 — 세는 것은 "화면에 행으로 그려질 줄" 이지 patch 의 줄 수가 아니다.
 * 파일 머리말(`diff --git`, `index`, `--- / +++`, 모드 변경)은 어느 면의 내용도 아니고,
 * `\ No newline at end of file` 도 행이 아니다. 머리말을 세면 파일이 많을수록 상한이
 * 앞당겨져, 잘게 쪼개진 브랜치가 이유 없이 막힌다.
 */
function countSides(patch: string): { original: DiffSideLines; modified: DiffSideLines } {
  const max = MAX_DIFF_LINES_PER_SIDE
  let original = 0
  let modified = 0
  let cursor = 0
  // `@@` 를 만나기 전은 전부 머리말이고, 다음 `diff --git` 에서 다시 머리말로 돌아간다.
  let inHunk = false

  while (cursor <= patch.length) {
    const newline = patch.indexOf('\n', cursor)
    const end = newline === -1 ? patch.length : newline
    // 마지막 줄이 개행으로 끝나면 그 뒤의 빈 조각은 줄이 아니다.
    if (end === cursor && newline === -1) break

    if (patch.startsWith('@@', cursor)) {
      inHunk = true
    } else if (patch.startsWith('diff --git ', cursor)) {
      inHunk = false
    } else if (inHunk && patch[cursor] !== '\\') {
      const marker = patch[cursor]
      if (marker === '+') modified++
      else if (marker === '-') original++
      else {
        // 문맥 행. 접두사 공백이 잘려 빈 줄로 온 경우도 여기로 온다
        // (diffPatch 의 readRows 와 같은 취급).
        original++
        modified++
      }

      if (original > max || modified > max) {
        return {
          original: { lines: original, atLeast: true },
          modified: { lines: modified, atLeast: true }
        }
      }
    }

    if (newline === -1) break
    cursor = newline + 1
  }

  return {
    original: { lines: original, atLeast: false },
    modified: { lines: modified, atLeast: false }
  }
}

/**
 * main 이 git 한 번의 stdout 으로 받아 줄 수 있는 최대 바이트(`execFile` 의 `maxBuffer`).
 *
 * 렌더 상한과 함께 여기 두는 이유: 사용자에게는 둘 다 "이 diff 를 못 보여 주는 한계값" 이고,
 * 카드가 그 값을 그대로 적어 줘야 하기 때문이다. 넘으면 본문 없이 numstat 만 읽는다.
 */
export const MAX_GIT_READ_BYTES = 32 * 1024 * 1024
