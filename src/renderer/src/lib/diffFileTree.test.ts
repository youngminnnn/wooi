import { describe, expect, it } from 'vitest'
import {
  buildDiffFileTree,
  filterByFileQuery,
  findDiffFileSection,
  matchesFileQuery
} from './diffFileTree'

/** 행을 `depth:kind:name` 으로 줄여 눈으로 트리 모양을 확인한다. */
const shape = (rows: ReturnType<typeof buildDiffFileTree>): string[] =>
  rows.map((r) => `${r.depth}:${r.kind}:${r.name}`)

describe('buildDiffFileTree', () => {
  it('빈 목록은 빈 트리다', () => {
    expect(buildDiffFileTree([])).toEqual([])
  })

  it('루트 파일만 있으면 이름순으로 편다', () => {
    expect(shape(buildDiffFileTree(['b.ts', 'a.ts']))).toEqual(['0:file:a.ts', '0:file:b.ts'])
  })

  it('디렉터리를 파일보다 먼저 둔다', () => {
    expect(shape(buildDiffFileTree(['z.ts', 'src/a.ts']))).toEqual([
      '0:dir:src',
      '1:file:a.ts',
      '0:file:z.ts'
    ])
  })

  it('자식이 디렉터리 하나뿐인 디렉터리는 이름을 합친다', () => {
    const rows = buildDiffFileTree(['src/main/git.ts', 'src/main/ipc.ts'])
    expect(shape(rows)).toEqual(['0:dir:src/main', '1:file:git.ts', '1:file:ipc.ts'])
    // 합쳐도 경로는 온전해야 접힘 상태와 짝이 맞는다.
    expect(rows[0].path).toBe('src/main')
  })

  it('갈래가 생기는 지점에서는 합치기를 멈춘다', () => {
    expect(shape(buildDiffFileTree(['src/main/git.ts', 'src/shared/types.ts']))).toEqual([
      '0:dir:src',
      '1:dir:main',
      '2:file:git.ts',
      '1:dir:shared',
      '2:file:types.ts'
    ])
  })

  it('마지막 파일 하나는 디렉터리에 합치지 않는다', () => {
    expect(shape(buildDiffFileTree(['docs/readme.md']))).toEqual(['0:dir:docs', '1:file:readme.md'])
  })

  it('접은 디렉터리의 자손은 빠지되 그 디렉터리 자신은 남는다', () => {
    const rows = buildDiffFileTree(
      ['src/main/git.ts', 'src/shared/types.ts', 'z.ts'],
      new Set(['src/main'])
    )
    expect(shape(rows)).toEqual([
      '0:dir:src',
      '1:dir:main',
      '1:dir:shared',
      '2:file:types.ts',
      '0:file:z.ts'
    ])
  })

  it('접힘의 열쇠는 합쳐진 뒤의 경로다 — 중간 마디로는 접히지 않는다', () => {
    const paths = ['src/main/git.ts', 'z.ts']
    // `src` 는 화면에 행으로 존재하지 않으므로(합쳐져 `src/main` 이 된다) 접힘에 쓰이지 않는다.
    expect(shape(buildDiffFileTree(paths, new Set(['src'])))).toEqual([
      '0:dir:src/main',
      '1:file:git.ts',
      '0:file:z.ts'
    ])
    expect(shape(buildDiffFileTree(paths, new Set(['src/main'])))).toEqual([
      '0:dir:src/main',
      '0:file:z.ts'
    ])
  })

  it('합치기는 접힘 상태와 무관하다 — 접었다 펴도 같은 행이 나온다', () => {
    const paths = ['src/main/git.ts', 'src/main/ipc.ts']
    const openRows = buildDiffFileTree(paths)
    const reopened = buildDiffFileTree(paths, new Set())
    expect(shape(buildDiffFileTree(paths, new Set(['src/main'])))).toEqual(['0:dir:src/main'])
    expect(shape(reopened)).toEqual(shape(openRows))
  })

  it('모든 파일 경로는 원본 그대로 복원된다', () => {
    const paths = ['src/main/git.ts', 'src/renderer/src/App.tsx', 'README.md']
    const files = buildDiffFileTree(paths)
      .filter((r) => r.kind === 'file')
      .map((r) => r.path)
    expect(files.sort()).toEqual([...paths].sort())
  })
})

describe('matchesFileQuery', () => {
  it('빈 검색어는 전부 통과시킨다', () => {
    expect(matchesFileQuery('src/main/git.ts', '   ')).toBe(true)
  })

  it('대소문자를 가리지 않는다', () => {
    expect(matchesFileQuery('src/main/Git.ts', 'GIT')).toBe(true)
  })

  it('토큰을 모두 포함해야 통과한다', () => {
    expect(matchesFileQuery('src/main/git.ts', 'main git')).toBe(true)
    expect(matchesFileQuery('src/main/git.ts', 'main store')).toBe(false)
  })

  it('토큰 순서는 상관없다', () => {
    expect(matchesFileQuery('src/main/git.ts', 'git main')).toBe(true)
  })
})

describe('filterByFileQuery', () => {
  const files = [{ path: 'src/main/git.ts' }, { path: 'src/renderer/src/App.tsx' }]

  it('빈 검색어면 같은 배열을 그대로 돌려준다', () => {
    expect(filterByFileQuery(files, '')).toBe(files)
  })

  it('맞는 항목만 남긴다', () => {
    expect(filterByFileQuery(files, 'app')).toEqual([{ path: 'src/renderer/src/App.tsx' }])
  })
})

describe('findDiffFileSection', () => {
  it('컨테이너가 없으면 null', () => {
    expect(findDiffFileSection(null, 'a.ts')).toBeNull()
  })

  it('경로에 선택자 특수문자가 있어도 찾는다', () => {
    const container = document.createElement('div')
    container.innerHTML = `
      <div data-diff-file="src/a.ts"></div>
      <div data-diff-file="src/[id]/page.tsx"></div>
    `
    expect(findDiffFileSection(container, 'src/[id]/page.tsx')).not.toBeNull()
    expect(findDiffFileSection(container, 'src/b.ts')).toBeNull()
  })
})
