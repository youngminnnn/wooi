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

  it('멀티바이트 문자가 청크 경계에서 잘려도 UTF-8을 보존한다', async () => {
    const stream = reader()
    const payload = JSON.stringify({ text: '해석될 수 있어' }) + '\n'
    const bytes = Buffer.from(payload, 'utf8')
    const split = bytes.indexOf(Buffer.from('있', 'utf8')) + 1
    const script = `const b=Buffer.from(${JSON.stringify(payload)});process.stdout.write(b.subarray(0,${split}));setTimeout(()=>process.stdout.write(b.subarray(${split})),20)`

    await execAntigravity(
      process.execPath,
      ['-e', script],
      { cwd: process.cwd(), abort: new AbortController() },
      stream
    )

    expect(stream.push.mock.calls.flat().join('')).toBe(payload)
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
