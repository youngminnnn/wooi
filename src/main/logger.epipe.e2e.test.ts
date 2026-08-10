import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 되먹임 고리 회귀 테스트.
 *
 * 실제 사고: `npm run dev` 를 띄운 터미널이 죽어 stdout/stderr 파이프의 읽는 쪽이 사라지면
 * 콘솔 미러링이 EPIPE 로 실패하고 → uncaughtException 이 되고 → 그 핸들러가 log.error 로
 * 다시 콘솔에 쓰고 → 다시 EPIPE 가 났다. 이 고리가 5시간 반 동안 main.log 를 40GB 로 채웠다.
 *
 * 진짜 파이프가 필요하므로(EPIPE 는 흉내 낼 수 없다) 자식 프로세스를 띄우고 부모가 읽는 쪽을
 * 닫는다. 자식은 번들이 아니라 소스 logger.ts 를 그대로 불러 쓴다(node 24 의 타입 스트리핑).
 */

const LOGGER = fileURLToPath(new URL('./logger.ts', import.meta.url))

let dir: string
let child: ChildProcess | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wooi-epipe-'))
  mkdirSync(join(dir, 'logs'), { recursive: true })
})

afterEach(() => {
  child?.kill('SIGKILL')
  child = null
  rmSync(dir, { recursive: true, force: true })
})

/** 파이프가 끊긴 채 로그를 계속 흘리는 자식을 띄우고, 지정한 시간 뒤 로그 파일을 돌려준다. */
async function runWithBrokenPipes(ms: number): Promise<{ main: string; rotated: string }> {
  const script = join(dir, 'child.mjs')
  writeFileSync(
    script,
    `import { log } from ${JSON.stringify(LOGGER)}
process.on('uncaughtException', (err) => log.error('uncaughtException', err))
process.on('unhandledRejection', (reason) => log.error('unhandledRejection', reason))
setInterval(() => log.info('tick ' + Date.now()), 5)
`
  )

  child = spawn(process.execPath, [script], {
    cwd: dir,
    env: { ...process.env, WOOI_USER_DATA: dir, WOOI_LOG_NAME: 'main.log' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  // 터미널이 죽은 상황과 같다: 읽는 쪽을 닫으면 자식의 다음 write 는 EPIPE 로 실패한다.
  child.stdout?.destroy()
  child.stderr?.destroy()

  await new Promise((r) => setTimeout(r, ms))
  return { main: join(dir, 'logs', 'main.log'), rotated: join(dir, 'logs', 'main.log.1') }
}

const size = (path: string): number => {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

describe('stdout/stderr 파이프가 끊긴 채 로깅', () => {
  it('EPIPE 가 로그 폭주로 번지지 않는다', { timeout: 30_000 }, async () => {
    const { main, rotated } = await runWithBrokenPipes(3000)

    const written = readFileSync(main, 'utf-8')
    const lines = written.split('\n').filter(Boolean).length

    // 5ms 간격 tick 3초 = 600 줄 안팎이면 정상이다. 되먹임이 살아 있으면 만 단위로 튄다.
    expect(lines).toBeLessThan(3000)
    expect(written).not.toContain('write EPIPE')
    // 회전 상한(1MB) 을 넘지 않는다.
    expect(size(main)).toBeLessThanOrEqual(1_000_000)
    expect(size(rotated)).toBeLessThanOrEqual(1_000_000)
  })
})
