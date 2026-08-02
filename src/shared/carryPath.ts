/**
 * carry 경로(리포 루트 기준 상대 경로)의 정규화·검증.
 *
 * main 과 renderer 가 **같은 규칙**을 봐야 해서 shared 에 둔다.
 * - renderer: 설정 모달에서 입력 즉시 인라인 오류를 띄우고 저장을 막는다.
 * - main: 신뢰 경계이므로 저장 직전에 다시 검증한다(렌더러를 믿지 않는다).
 *
 * 순수 문자열 로직이라 node API 의존이 없다 — 그래서 양쪽에서 그대로 쓸 수 있다.
 */

export type CarryPathResult = { ok: true; path: string } | { ok: false; reason: string }

/**
 * 사용자 입력 경로를 리포 루트 기준 상대 경로로 정규화하고 검증한다.
 *
 * 이 값이 그대로 파일시스템 작업(복사·심링크 생성)에 들어가므로, 리포 밖을 가리키는 입력은
 * 여기서 전부 막는다. 절대 경로·`~`·`..` 는 worktree 바깥에 파일을 쓰게 만들 수 있고,
 * `.git` 은 worktree 의 git 메타데이터를 덮어써 리포를 망가뜨릴 수 있다.
 */
export function validateCarryPath(raw: string): CarryPathResult {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, reason: 'Path is empty.' }
  if (trimmed.startsWith('~')) return { ok: false, reason: 'Home-relative paths are not allowed.' }
  if (trimmed.startsWith('/')) return { ok: false, reason: 'Absolute paths are not allowed.' }

  const segments: string[] = []
  for (const seg of trimmed.split('/')) {
    // 빈 세그먼트(`a//b`)와 `.` 는 의미가 없으므로 접는다.
    if (seg === '' || seg === '.') continue
    if (seg === '..') return { ok: false, reason: '".." would escape the repository.' }
    if (seg === '.git') return { ok: false, reason: '".git" cannot be carried.' }
    segments.push(seg)
  }
  if (segments.length === 0) return { ok: false, reason: 'Path is empty.' }
  return { ok: true, path: segments.join('/') }
}
