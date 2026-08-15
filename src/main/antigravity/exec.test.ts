import { describe, expect, it, vi } from 'vitest'
import { execAntigravity } from './exec'

function reader() {
  return { push: vi.fn<(chunk: string) => void>(), end: vi.fn<() => void>() }
}

describe('execAntigravity', () => {
  it('stdout 을 읽고 정상 종료의 stderr 도 온전히 반환한다', async () => {
    const stream = reader()
    const outcome = await execAntigravity(
      process.execPath,
      [
        '-e',
        'process.stdout.write(\'{\\"event\\":\\"init\\"}\\n\'); process.stderr.write(\'soft deny notice\')'
      ],
      { cwd: process.cwd(), abort: new AbortController() },
      stream
    )

    expect(stream.push).toHaveBeenCalledWith('{"event":"init"}\n')
    expect(stream.end).toHaveBeenCalledOnce()
    expect(outcome).toEqual({
      error: null,
      aborted: false,
      stderr: 'soft deny notice',
      exitCode: 0
    })
  })

  it('0이 아닌 종료에서는 stderr 를 오류로 사용한다', async () => {
    const outcome = await execAntigravity(
      process.execPath,
      ['-e', "process.stderr.write('failure detail'); process.exitCode = 7"],
      { cwd: process.cwd(), abort: new AbortController() },
      reader()
    )
    expect(outcome).toMatchObject({
      error: 'failure detail',
      aborted: false,
      stderr: 'failure detail',
      exitCode: 7
    })
  })
})
