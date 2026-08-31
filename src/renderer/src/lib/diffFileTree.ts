/**
 * 변경 파일 경로 목록을 사이드바가 그대로 그릴 수 있는 **납작한 트리 행**으로 바꾼다.
 *
 * 트리를 중첩 컴포넌트로 그리지 않고 행 배열로 펴는 이유: 접힘·검색·활성 표시가 모두 "어떤 행이
 * 보이는가" 한 가지 질문으로 정리되고, 그 계산이 DOM 없이 검증 가능해진다. 여기에는 React 도
 * 브라우저 API 도 들어오지 않는다 — 순수 함수만 둔다.
 */

export type DiffTreeRowKind = 'dir' | 'file'

export interface DiffTreeRow {
  kind: DiffTreeRowKind
  /** 루트부터의 전체 경로(끝에 '/' 없음). 행의 key 이자 접힘 상태의 식별자다. */
  path: string
  /** 화면에 그릴 이름. 외자식 디렉터리는 `src/main` 처럼 합쳐져 한 행이 된다. */
  name: string
  /** 들여쓰기 단계(루트가 0). */
  depth: number
}

interface Node {
  name: string
  /** 삽입한 순서가 아니라 정렬해서 꺼내므로 Map 으로 둬도 된다. */
  children: Map<string, Node>
  isFile: boolean
}

function emptyNode(name: string): Node {
  return { name, children: new Map(), isFile: false }
}

/**
 * 경로들을 중첩 노드로 쌓는다. 같은 이름이 파일이자 디렉터리로 오는 일은 git 이 만들지 않으므로
 * 뒤에 온 쪽으로 덮어쓰지 않고 파일 표시만 켠다.
 */
function insert(root: Node, path: string): void {
  const parts = path.split('/').filter(Boolean)
  let node = root
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i]
    let child = node.children.get(name)
    if (!child) {
      child = emptyNode(name)
      node.children.set(name, child)
    }
    if (i === parts.length - 1) child.isFile = true
    node = child
  }
}

/** 디렉터리 먼저, 그다음 파일. 같은 종류끼리는 이름순. */
function sorted(node: Node): Node[] {
  return [...node.children.values()].sort((a, b) => {
    const aDir = a.children.size > 0
    const bDir = b.children.size > 0
    if (aDir !== bDir) return aDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

/**
 * 자식이 디렉터리 하나뿐인 디렉터리는 그 자식과 이름을 합친다 —
 * `src` → `renderer` → `src` 를 세 줄로 쌓으면 정작 파일이 보일 자리가 없다.
 */
function compact(node: Node, prefix: string): { name: string; path: string; node: Node } {
  let name = node.name
  let path = prefix ? `${prefix}/${node.name}` : node.name
  let current = node
  while (!current.isFile && current.children.size === 1) {
    const only = [...current.children.values()][0]
    if (only.children.size === 0) break // 파일 하나는 제 행을 가진다
    name = `${name}/${only.name}`
    path = `${path}/${only.name}`
    current = only
  }
  return { name, path, node: current }
}

/**
 * 변경 파일 경로들을 트리 행으로 편다.
 *
 * @param paths 변경 파일 경로(`WorkspaceDiff.files[].path` 그대로).
 * @param collapsed 접어 둔 디렉터리 경로. 그 아래 행은 결과에서 빠진다.
 */
export function buildDiffFileTree(
  paths: readonly string[],
  collapsed: ReadonlySet<string> = new Set()
): DiffTreeRow[] {
  const root = emptyNode('')
  for (const path of paths) insert(root, path)

  const rows: DiffTreeRow[] = []
  const walk = (node: Node, prefix: string, depth: number): void => {
    for (const child of sorted(node)) {
      if (child.children.size === 0) {
        const path = prefix ? `${prefix}/${child.name}` : child.name
        rows.push({ kind: 'file', path, name: child.name, depth })
        continue
      }
      const folded = compact(child, prefix)
      rows.push({ kind: 'dir', path: folded.path, name: folded.name, depth })
      if (!collapsed.has(folded.path)) walk(folded.node, folded.path, depth + 1)
    }
  }
  walk(root, '', 0)
  return rows
}

/**
 * 이름 검색. 공백으로 나눈 토큰이 **모두** 경로에 들어 있으면 통과한다(대소문자 무시).
 *
 * 퍼지 매칭을 쓰지 않는 이유: 결과가 왜 나왔는지 사용자가 설명할 수 있어야 하고, 여기 후보는
 * 많아야 수백 개라 부분 문자열로 충분하다. 토큰을 AND 로 묶으면 `main git` 처럼 디렉터리와
 * 파일명을 섞어 좁힐 수 있다.
 */
export function matchesFileQuery(path: string, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return true
  const haystack = path.toLowerCase()
  return tokens.every((t) => haystack.includes(t))
}

/** 경로를 가진 아무 목록이나 검색어로 거른다(빈 검색어는 원본을 그대로 돌려준다). */
export function filterByFileQuery<T extends { path: string }>(
  items: readonly T[],
  query: string
): T[] {
  if (!query.trim()) return items as T[]
  return items.filter((item) => matchesFileQuery(item.path, query))
}

/**
 * diff 안에서 이 파일 블록의 DOM 을 찾는다.
 *
 * `querySelector` 에 경로를 끼워 넣지 않는 이유: 경로에는 선택자에서 이스케이프가 필요한 문자가
 * 들어올 수 있고(`CSS.escape` 는 jsdom 에서 없을 수 있다), 후보가 파일 수만큼뿐이라 훑어도 싸다.
 */
export function findDiffFileSection(
  container: HTMLElement | null | undefined,
  path: string
): HTMLElement | null {
  if (!container) return null
  for (const el of container.querySelectorAll<HTMLElement>('[data-diff-file]')) {
    if (el.getAttribute('data-diff-file') === path) return el
  }
  return null
}
