import type { ReviewFileDiff } from './types'

/**
 * 리뷰 화면의 "이 파일은 봤다" 표시.
 *
 * 표시를 파일 **내용의 지문과 함께** 저장한다 — 새 커밋이 올라와 그 파일이 바뀌면 지문이
 * 달라져 자동으로 안 본 것이 된다(GitHub 의 Viewed 와 같은 동작). 따로 리셋하는 코드가 없다.
 * 리뷰의 diff 레코드는 고정 id 로 통째로 덮어써지므로 "어느 파일이 바뀌었나" 를 diff 끼리
 * 비교해 알아낼 방법이 없는데, 이 방식은 그 제약을 비켜 간다.
 *
 * **지문은 여기서만 만든다.** main(저장할 때)과 렌더러(표시할 때)가 각자 계산하므로, 두 곳이
 * 다른 값을 보면 파일이 항상 안 본 것으로 보인다. 그래서 Node 전용 crypto 가 아니라 양쪽에서
 * 같이 도는 순수 함수로 둔다.
 */

/** 파일 내용의 지문. 같은 내용이면 같은 값, 한 글자만 달라도 다른 값. */
export function fileDiffHash(file: ReviewFileDiff): string {
  return cyrb53(fingerprint(file))
}

/**
 * diff 한 벌 전체의 지문.
 *
 * 스택에서 아래 레이어에 커밋이 올라가면 위쪽은 전부 rebase 돼 head sha 가 바뀌지만, 내용은
 * 그대로인 경우가 대부분이다. sha 로는 그 둘을 구분할 수 없어 **내용으로** 구분한다 — 같으면
 * 지적을 그대로 두고 타임라인에 "restack" 한 줄만 남긴다([[review/manager]]).
 */
export function reviewDiffHash(diff: { files: ReviewFileDiff[] }): string {
  return cyrb53(diff.files.map((f) => `${f.path}:${fileDiffHash(f)}`).join('\n'))
}

/**
 * "봤음" 표시의 키.
 *
 * **레이어마다 따로 센다** — 스택에서는 같은 경로가 여러 레이어에 있고, 그 둘은 서로 다른
 * 변경이다. 경로만으로 키를 잡으면 아래 레이어에서 체크한 파일이 위 레이어에서도 본 것으로
 * 표시돼, 아직 안 읽은 변경을 읽었다고 착각하게 된다.
 * PR 번호가 없으면(옛 단일 PR 리뷰) 경로만 쓴다 — 그래야 예전 표시가 그대로 살아난다.
 */
export function viewedKey(path: string, prNumber?: number): string {
  return prNumber === undefined ? path : `#${prNumber} ${path}`
}

/** 이 파일은 지금 "봤음" 인가 — 표시가 있고, 그때의 내용과 지금 내용이 같아야 한다. */
export function isFileViewed(
  viewed: Record<string, string>,
  file: ReviewFileDiff,
  prNumber?: number
): boolean {
  const hash = fileDiffHash(file)
  if (viewed[viewedKey(file.path, prNumber)] === hash) return true
  // 옛 레코드는 경로만으로 저장돼 있다. 레이어가 하나인 리뷰라면 그 표시가 이 파일의 것이 맞다.
  return prNumber !== undefined && viewed[file.path] === hash && !hasLayeredKeys(viewed)
}

function hasLayeredKeys(viewed: Record<string, string>): boolean {
  for (const k in viewed) if (k.startsWith('#')) return true
  return false
}

/**
 * 지금 diff 기준으로 실제 "봤음" 인 경로들. 바뀐 파일은 표시가 남아 있어도 빠진다.
 *
 * 파일마다 isFileViewed 를 부르면 렌더링할 때마다 diff 전체를 다시 해시한다 — 큰 PR 에서
 * 그 비용이 눈에 띄므로, 화면은 이걸로 한 번만 계산해 두고 쓴다.
 * 돌려주는 집합의 원소는 `viewedKey` 의 결과다(레이어를 구분해야 하므로 경로만으로는 부족하다).
 */
export function viewedFilePaths(
  viewed: Record<string, string>,
  layers: Array<{ prNumber?: number; files: ReviewFileDiff[] }>
): Set<string> {
  const keys = new Set<string>()
  for (const layer of layers) {
    for (const f of layer.files) {
      if (isFileViewed(viewed, f, layer.prNumber)) keys.add(viewedKey(f.path, layer.prNumber))
    }
  }
  return keys
}

/**
 * 지문의 입력. 키 순서에 흔들리지 않게 배열로 펴서 직렬화한다 — 같은 diff 인데 객체 키 순서만
 * 달라 지문이 갈리면, 표시해 둔 파일이 이유 없이 안 본 것으로 돌아온다.
 *
 * hunks 뿐 아니라 status·증감량도 넣는다. 바이너리 파일은 hunks 가 비어 있어서 hunks 만
 * 보면 내용이 바뀌어도 지문이 그대로다.
 */
function fingerprint(file: ReviewFileDiff): string {
  return JSON.stringify([
    file.status,
    file.oldPath,
    file.additions,
    file.deletions,
    file.binary,
    file.hunks.map((h) => [h.header, h.rows.map((r) => [r.kind, r.text, r.oldLine, r.newLine])])
  ])
}

/**
 * cyrb53 — 53비트 비암호화 해시. 여기서 필요한 것은 "같은 파일의 두 버전을 구분" 뿐이라
 * 충돌 확률이 이 정도면 충분하고, 의존성 없이 main·렌더러 양쪽에서 똑같이 돈다.
 */
function cyrb53(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}
