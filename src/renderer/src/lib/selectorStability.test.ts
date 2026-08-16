import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * zustand 는 useSyncExternalStore 위에 올라가 있다 — 셀렉터가 같은 상태에서도 매번 **새 참조**를
 * 돌려주면 React 가 커밋마다 스냅샷이 바뀌었다고 보고 다시 렌더해 무한 루프에 빠진다
 * (Minified React error #185 "Maximum update depth exceeded"). 실제로 v1.17.0 에서
 * `agentSettingsFor` 가 기본값을 펼쳐 합치도록 바뀌면서, 그 함수를 셀렉터 안에서 부르던
 * `useAgentSettings` 때문에 워크스페이스를 열자마자 입력창 상태줄이 죽었다.
 *
 * 그래서 셀렉터 본문은 "저장된 값을 그대로 집어 오는" 일만 해야 한다. 새 객체·배열을 만드는 일은
 * 셀렉터 밖(useMemo, 모듈 상수)에서 한다.
 */
const RENDERER = join(import.meta.dirname, '..')

/** 셀렉터 본문에 있으면 새 참조를 만든다고 보는 표현. */
const UNSTABLE = [
  '...', // 객체/배열 스프레드
  '.filter(',
  '.map(',
  '.slice(',
  '.sort(',
  '.concat(',
  'Object.keys',
  'Object.values',
  'Object.entries',
  // 스토어에 저장된 값이 아니라 매번 합쳐 만든 객체를 돌려주는 shared 헬퍼.
  'agentSettingsFor('
]

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return sources(path)
    if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) return []
    return [path]
  })
}

/** `useStore(` 뒤 괄호가 닫힐 때까지를 셀렉터 본문으로 잘라 낸다. */
function selectorBodies(src: string): string[] {
  const bodies: string[] = []
  for (const match of src.matchAll(/useStore\(/g)) {
    let i = match.index + match[0].length
    let depth = 1
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth++
      else if (src[i] === ')') depth--
      i++
    }
    bodies.push(src.slice(match.index + match[0].length, i - 1))
  }
  return bodies
}

describe('store 셀렉터는 참조가 안정적이어야 한다', () => {
  it('셀렉터 안에서 새 객체·배열을 만들지 않는다', () => {
    const offenders = sources(RENDERER).flatMap((file) =>
      selectorBodies(readFileSync(file, 'utf8'))
        .filter((body) => UNSTABLE.some((token) => body.includes(token)))
        .map((body) => `${file}: ${body.replace(/\s+/g, ' ').trim()}`)
    )
    expect(offenders).toEqual([])
  })
})
