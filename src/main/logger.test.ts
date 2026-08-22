import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * logger 는 모듈 최상위에 경로·미러링 상태를 캐시하므로, 테스트마다 새 임시 userData 를 주고
 * 모듈을 다시 불러온다.
 */
async function freshLogger(dir: string): Promise<typeof import('./logger')> {
  process.env.WOOI_USER_DATA = dir
  delete process.env.WOOI_LOG_NAME
  vi.resetModules()
  return import('./logger')
}

const MAX_BYTES = 1_000_000

let dir: string
let logs: string
let main: string
let rotated: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wooi-logger-'))
  logs = join(dir, 'logs')
  mkdirSync(logs, { recursive: true })
  main = join(logs, 'main.log')
  rotated = join(logs, 'main.log.1')
  // 콘솔 미러링이 테스트 출력을 더럽히지 않게 막는다.
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.WOOI_USER_DATA
  rmSync(dir, { recursive: true, force: true })
})

describe('회전', () => {
  it('상한을 넘으면 main.log 를 main.log.1 로 옮기고 새 파일에 이어 쓴다', async () => {
    writeFileSync(main, 'x'.repeat(MAX_BYTES))
    const { log } = await freshLogger(dir)

    log.info('회전 뒤 첫 줄')

    expect(statSync(rotated).size).toBe(MAX_BYTES)
    expect(readFileSync(main, 'utf-8')).toContain('회전 뒤 첫 줄')
    expect(statSync(main).size).toBeLessThan(MAX_BYTES)
  })

  it('main.log 와 main.log.1 이 같은 파일이면 잘라내서 상한을 지킨다', async () => {
    // 40GB 사고의 정체: 두 이름이 한 inode 를 가리키면 rename 은 성공만 하고 아무 것도 하지
    // 않는다(POSIX). 크기 검사는 계속 통과하고 append 는 계속 쌓여 파일이 무한히 자란다.
    writeFileSync(main, 'x'.repeat(MAX_BYTES))
    linkSync(main, rotated)
    expect(statSync(main).ino).toBe(statSync(rotated).ino)

    const { log } = await freshLogger(dir)
    for (let i = 0; i < 50; i++) log.info(`줄 ${i}`)

    expect(statSync(main).size).toBeLessThanOrEqual(MAX_BYTES)
    expect(readFileSync(main, 'utf-8')).toContain('줄 49')
  })

  it('rename 이 실패해도 상한을 넘기지 않는다', async () => {
    // 대상 이름을 비어 있지 않은 디렉터리로 만들어 rename 을 실패시킨다(ENOTEMPTY).
    mkdirSync(rotated)
    writeFileSync(join(rotated, 'occupied'), 'x')
    writeFileSync(main, 'x'.repeat(MAX_BYTES))

    const { log } = await freshLogger(dir)
    for (let i = 0; i < 50; i++) log.info(`줄 ${i}`)

    expect(statSync(main).size).toBeLessThanOrEqual(MAX_BYTES)
  })

  it('폭주해도 파일은 상한 안에 머무른다', async () => {
    const { log } = await freshLogger(dir)
    // 같은 줄 접기를 우회하려고 매번 다른 줄을 쓴다.
    for (let i = 0; i < 20_000; i++) log.error(`폭주 ${i} ${'y'.repeat(200)}`)

    expect(statSync(main).size).toBeLessThanOrEqual(MAX_BYTES)
    expect(statSync(rotated).size).toBeLessThanOrEqual(MAX_BYTES)
    // 20,000줄을 동기로 쓰는 CPU 바운드 테스트다. 혼자 돌면 1초지만 다른 파일이 코어를 물고
    // 있으면 8초를 넘어, 기본 타임아웃 5초에 걸려 크기 단언에 닿지도 못한 채 떨어진다.
    // 검증하려는 것은 회전 상한이지 이 머신의 속도가 아니므로 넉넉히 준다.
  }, 30_000)
})

describe('되먹임 차단', () => {
  it('같은 줄이 반복되면 접고 요약만 남긴다', async () => {
    const { log } = await freshLogger(dir)

    for (let i = 0; i < 2500; i++) log.error('uncaughtException Error: write EPIPE')
    log.info('다른 줄')

    const written = readFileSync(main, 'utf-8')
    const storm = written.split('\n').filter((l) => l.includes('write EPIPE')).length
    expect(storm).toBe(1)
    expect(written).toContain('last message repeated 1000 times')
    expect(written).toContain('다른 줄')
  })

  it('콘솔 미러링이 던져도 예외를 밖으로 내지 않고 파일에는 남긴다', async () => {
    const { log } = await freshLogger(dir)
    vi.mocked(console.error).mockImplementation(() => {
      throw new Error('EPIPE')
    })

    expect(() => log.error('터진 뒤에도 살아남는 줄')).not.toThrow()
    expect(readFileSync(main, 'utf-8')).toContain('터진 뒤에도 살아남는 줄')
  })

  it('한 번 깨진 콘솔에는 다시 쓰지 않는다', async () => {
    const { log } = await freshLogger(dir)
    const sink = vi.mocked(console.error)
    sink.mockImplementationOnce(() => {
      throw new Error('EPIPE')
    })

    log.error('첫 줄')
    log.error('둘째 줄')
    log.error('셋째 줄')

    expect(sink).toHaveBeenCalledTimes(1)
    expect(readFileSync(main, 'utf-8')).toContain('셋째 줄')
  })
})
