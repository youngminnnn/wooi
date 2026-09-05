import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 벤더 재노출 엔트리가 실제 모듈의 이름을 하나도 빠뜨리지 않는지 본다.
 *
 * **이 테스트는 실측으로 두 번 물린 뒤에 생겼다.** react·react/jsx-runtime 은 CJS 라
 * `export * from '…'` 로는 롤업이 named export 를 정적으로 못 읽고, 결과물에 `default` 만
 * 남는다. 그러면 게스트가 `does not provide an export named 'createElement'` 로 죽는데,
 * 그 실패는 **빌드가 아니라 런타임에**, 그것도 샌드박스 안에서 난다 — 타입체크도 유닛
 * 테스트도 절대 못 본다.
 *
 * 그래서 이름을 손으로 적고, 그 목록이 낡는 것을 여기서 잡는다. React 를 올려 훅이 하나
 * 늘면 이 테스트가 먼저 빨개진다.
 */

const require_ = createRequire(import.meta.url)
const VENDOR_DIR = join(import.meta.dirname, '..', 'artifact', 'vendor')

/** 재노출할 이유가 없는 내부 이름들. */
const INTERNAL = new Set([
  'default',
  '__esModule',
  '__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE',
  '__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE',
  '__COMPILER_RUNTIME'
])

/** `export const { a, b } = X` 에서 이름을 뽑는다. */
function declaredNames(file: string): Set<string> {
  const source = readFileSync(join(VENDOR_DIR, file), 'utf-8')
  const block = source.match(/export const \{([\s\S]*?)\} =/)
  if (!block) return new Set()
  return new Set(
    block[1]
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
  )
}

const CJS_ENTRIES: Array<{ file: string; module: string }> = [
  { file: 'react.js', module: 'react' },
  { file: 'react-jsx-runtime.js', module: 'react/jsx-runtime' },
  { file: 'react-dom-client.js', module: 'react-dom/client' }
]

describe('artifact vendor entries', () => {
  for (const { file, module } of CJS_ENTRIES) {
    it(`${file} re-exports everything ${module} actually has`, () => {
      const real = Object.keys(require_(module) as object).filter((k) => !INTERNAL.has(k))
      const declared = declaredNames(file)
      expect(real.length).toBeGreaterThan(0)
      const missing = real.filter((name) => !declared.has(name))
      expect(
        missing,
        `${file} is missing ${missing.join(', ')} — a react artifact importing one of these ` +
          'would die inside the sandbox with "does not provide an export named …".'
      ).toEqual([])
    })

    it(`${file} does not promise names ${module} does not have`, () => {
      const real = new Set(Object.keys(require_(module) as object))
      const extra = [...declaredNames(file)].filter((name) => !real.has(name))
      // 없는 이름을 구조분해하면 undefined 가 조용히 export 된다 — 게스트에서야 터진다.
      expect(extra).toEqual([])
    })
  }

  // ESM 패키지는 `export *` 로 충분하다. 그 사실 자체를 고정해 둔다 — 누가 CJS 방식으로
  // 바꾸려 하면 이 테스트가 "그럴 필요 없다" 고 말해 준다.
  for (const file of ['lucide-react.js', 'recharts.js']) {
    it(`${file} stays a plain star re-export`, () => {
      const source = readFileSync(join(VENDOR_DIR, file), 'utf-8')
      expect(source).toMatch(/export \* from/)
    })
  }
})
