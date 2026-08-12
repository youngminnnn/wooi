import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 유틸리티 프로세스가 `electron` 에 닿지 않는지 지키는 게이트.
 *
 * 두 가지를 함께 확인한다: (1) 지금 소스가 규칙을 지키는지, (2) **검출 자체가 동작하는지**.
 * (2) 가 없으면 검사기가 조용히 아무것도 안 하게 되는 날 — 리졸버가 깨지거나 파서가 바뀌는 날 —
 * 아무도 모르고, 게이트가 있다는 믿음만 남는다. 그 믿음이 실제 회귀 하나를 릴리즈에 실었다(#280).
 */

const SCRIPT = fileURLToPath(new URL('./check-host-imports.mjs', import.meta.url))

/** CI·husky 가 부르는 방식 그대로 실행한다. 검증 대상이 exit code 계약이므로 import 하지 않는다. */
function run(...args: string[]): { code: number; output: string } {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
    return { code: 0, output: stdout }
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string }
    return { code: e.status, output: `${e.stdout}${e.stderr}` }
  }
}

/** 진입점 하나짜리 임시 모듈 그래프를 만들고 그 진입점 경로를 돌려준다. */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'wooi-host-imports-'))
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(dir, name), source)
  }
  return join(dir, 'entry.ts')
}

describe('check-host-imports', () => {
  it('현재 소스의 유틸리티 프로세스 진입점은 electron 에 닿지 않는다', () => {
    const { code, output } = run()
    expect(output).toContain('stay clear')
    expect(code).toBe(0)
  })

  it('전이적으로 딸려 온 electron import 를 사슬과 함께 잡아낸다', () => {
    const entry = fixture({
      'entry.ts': `import { work } from './middle'\nwork()\n`,
      'middle.ts': `import { store } from './store'\nexport const work = () => store\n`,
      'store.ts': `import { app } from 'electron'\nexport const store = app\n`
    })
    const { code, output } = run(entry)
    expect(code).toBe(1)
    // 사슬이 보여야 원인을 찾을 수 있다 — 위반 사실만으로는 어느 import 를 끊을지 모른다.
    expect(output).toContain('middle.ts')
    expect(output).toContain('store.ts')
  })

  it('타입 전용 import 는 번들에서 지워지므로 위반이 아니다', () => {
    const entry = fixture({
      'entry.ts': `import type { App } from 'electron'\nimport { type Bar } from './types'\nexport type X = App | Bar\n`,
      'types.ts': `import { app } from 'electron'\nexport type Bar = typeof app\n`
    })
    expect(run(entry).code).toBe(0)
  })

  it('부작용만 취하는 import 도 모듈을 평가시키므로 위반이다', () => {
    const entry = fixture({ 'entry.ts': `import 'electron'\n` })
    expect(run(entry).code).toBe(1)
  })

  it('진입점이 없으면 통과가 아니라 오류다', () => {
    expect(run('src/main/does-not-exist.ts').code).toBe(2)
  })
})
