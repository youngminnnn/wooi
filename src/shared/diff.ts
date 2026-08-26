/**
 * 통합 diff 에서 눈에 보이는 요약을 뽑는다 — 몇 줄이 늘고 줄었는지, 어느 파일인지.
 *
 * 세 곳에 흩어져 있던 것을 여기로 모은다. 렌더러의 ToolCard 는 자기 사본을 갖고 있었고,
 * main 은 `diff --git` 경로 정규식을 git.ts 와 review/diff.ts 에 각각 적어 두었다. 폰이
 * 네 번째 사본을 만들 이유가 없다 — 같은 diff 를 두 화면이 다르게 세면 그것부터 버그다.
 */

/** 통합 diff 의 추가/삭제 줄 수(파일 헤더 ---/+++ 는 제외). */
export function diffStat(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++
    else if (line.startsWith('-') && !line.startsWith('---')) removed++
  }
  return { added, removed }
}

/**
 * diff 가 말하는 파일 경로. 없으면 null.
 *
 * `diff --git` 헤더를 먼저 본다(git 이 붙이는 것이라 가장 믿을 만하다). 에이전트가 만든
 * 패치에는 그 줄이 없는 일이 잦아서 `+++`/`---` 도 받아 준다 — 새 파일이면 `---` 쪽이,
 * 지운 파일이면 `+++` 쪽이 `/dev/null` 이므로 둘 다 보고 실재하는 쪽을 고른다.
 */
export function diffFilePath(diff: string): string | null {
  const git = /^diff --git a\/(.+?) b\//m.exec(diff)
  if (git) return git[1]
  for (const pattern of [/^\+\+\+ (.+)$/m, /^--- (.+)$/m]) {
    const match = pattern.exec(diff)
    if (!match) continue
    // git 은 경로 뒤에 탭 + 타임스탬프를 붙이기도 한다.
    const path = match[1].split('\t')[0].trim()
    if (path === '' || path === '/dev/null') continue
    return path.replace(/^[ab]\//, '')
  }
  return null
}
