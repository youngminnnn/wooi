import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 비교 기준(`Workspace.compareBase`)이 **표시 밖으로 새지 않는지** 기계로 붙잡는다.
 *
 * Wooi 는 스택 PR 이 중심 기능이라 이 경계가 특히 위험하다 — 이 값이 PR 대상이나 rebase 대상
 * 계산에 한 번이라도 흘러들면, 사용자가 "그냥 main 과 견줘 보려던" 행동이 스택 전체의 base 를
 * 바꾼 것처럼 보인다. 되돌리기도 어렵다(리모트에 force-push 가 나간 뒤다).
 *
 * 주석으로만 적어 두면 언젠가 깨지므로, "읽는 곳은 gitDiff 하나뿐"을 여기서 강제한다.
 * 판단의 근거는 [[compareBase]] 에 있다.
 */
const MAIN = import.meta.dirname

/** 실제 base 를 계산하거나 쓰는 모듈. 여기에 이 값이 등장하면 그 자체가 사고다. */
const BASE_OWNING_MODULES = [
  'ghStack.ts',
  'mergeTrain.ts',
  'cascade.ts',
  'workspaces.ts',
  'stack.ts',
  'git.ts',
  'commitMove.ts'
]

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return sources(path)
    if (!/\.ts$/.test(e.name) || /\.test\.ts$/.test(e.name)) return []
    return [path]
  })
}

describe('compareBase 는 표시 전용이다', () => {
  it('main 에서 이 값을 읽는 파일은 ipc.ts 하나뿐이다', () => {
    const readers = sources(MAIN)
      .filter((path) => /\bcompareBase\b/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(MAIN, path))
      .sort()
    expect(readers).toEqual(['ipc.ts'])
  })

  it('실제 base 를 계산하는 모듈은 이 값을 모른다', () => {
    for (const file of BASE_OWNING_MODULES) {
      const source = readFileSync(join(MAIN, file), 'utf8')
      expect({ file, mentions: /\bcompareBase\b/.test(source) }).toEqual({ file, mentions: false })
    }
  })

  it('ipc.ts 에서도 diff 를 뜨는 자리에서만 쓴다', () => {
    const source = readFileSync(join(MAIN, 'ipc.ts'), 'utf8')
    // 주석은 세지 않는다 — 경계를 설명하는 글이 늘었다고 경계가 넓어진 것은 아니다.
    const lines = source
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => !line.startsWith('//') && !line.startsWith('*'))
      .filter((line) => /\bcompareBase\b/i.test(line))
    // 코드에서의 등장은 딱 넷 — import, gitDiff 안에서의 사용, setter 의 인자와 저장.
    expect(lines).toEqual([
      "import { compareBaseBranch, normalizeCompareBase } from '@shared/compareBase'",
      'compareBase: ws.compareBase',
      'handle(IPC.workspaceSetCompareBase, (_e, workspaceId: string, compareBase: unknown) => {',
      'if (w) w.compareBase = normalizeCompareBase(compareBase)'
    ])
  })

  it('PR 생성과 rebase 는 여전히 저장된 base 만 본다', () => {
    const ipc = readFileSync(join(MAIN, 'ipc.ts'), 'utf8')
    // PR 대상은 스택 항목의 baseBranch 아니면 워크스페이스의 baseBranch 다.
    expect(ipc).toContain('entry ? entry.baseBranch : ws.baseBranch')
    const cascade = readFileSync(join(MAIN, 'cascade.ts'), 'utf8')
    expect(cascade).toContain('const base = directChild ? newBase : e.baseBranch')
  })
})
