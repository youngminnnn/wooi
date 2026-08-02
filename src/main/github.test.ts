import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

/**
 * gh 는 선택 연동이다 — 미연결이면 읽기 계열은 gh 를 아예 실행하지 않고 조용히 빈 값을,
 * 쓰기 계열은 안내 메시지를 돌려줘야 한다. 반대로 연결된 사용자에게는 예전과 100% 동일하게
 * 동작해야 한다(무회귀). 그 경계를 셸 호출 기록으로 확인한다.
 */

/** 실행된 셸 명령(`$SHELL -lc <command>`)의 command 부분만 순서대로 모은다. */
const commands: string[] = []
/** 다음에 실행될 명령이 돌려줄 종료 코드·stdout. 명령 문자열의 접두사로 매칭한다. */
let reply: (command: string) => { code: number; stdout: string }

vi.mock('node:child_process', () => ({
  spawn: (_shell: string, args: string[]) => {
    const command = args[1] ?? ''
    commands.push(command)
    const { code, stdout } = reply(command)
    const proc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter()
    })
    // 실제 spawn 처럼 비동기로 출력·종료를 알린다.
    setImmediate(() => {
      if (stdout) proc.stdout.emit('data', Buffer.from(stdout))
      proc.emit('close', code)
    })
    return proc
  }
}))

const {
  setGithubConnected,
  getPrStatus,
  listOpenPrs,
  invalidateOpenPrs,
  getPrChecks,
  createPrWeb,
  mergePr,
  closePr
} = await import('./github')

/** 연결 확인(probe)은 `command -v gh … && gh auth status` 한 줄이다. */
const isProbe = (c: string): boolean => c.startsWith('command -v gh')
const ghCalls = (): string[] => commands.filter((c) => !isProbe(c))

beforeEach(() => {
  commands.length = 0
})

describe('gh 미연결', () => {
  beforeEach(() => {
    setGithubConnected(false)
  })

  it('PR 조회는 gh 를 실행하지 않고 조용히 null 을 돌려준다', async () => {
    reply = () => ({ code: 0, stdout: '' })
    await expect(getPrStatus('/tmp/wt')).resolves.toBeNull()
    expect(ghCalls()).toEqual([])
  })

  it('열린 PR 목록은 gh 를 실행하지 않고 빈 배열을 돌려준다', async () => {
    reply = () => ({ code: 0, stdout: '' })
    await expect(listOpenPrs('/tmp/wt')).resolves.toEqual([])
    expect(ghCalls()).toEqual([])
  })

  it('체크 조회는 gh 를 실행하지 않고 null 을 돌려준다', async () => {
    reply = () => ({ code: 0, stdout: '' })
    await expect(getPrChecks('/tmp/wt')).resolves.toBeNull()
    expect(ghCalls()).toEqual([])
  })

  it('쓰기 액션은 재확인 후에도 미연결이면 안내 메시지를 돌려준다', async () => {
    reply = () => ({ code: 1, stdout: '' }) // 재확인(probe)도 실패 = 여전히 미연결
    const res = await createPrWeb('/tmp/wt')
    expect(res.error).toMatch(/GitHub is not connected/)
    expect(ghCalls()).toEqual([])
  })

  it('쓰기 액션은 앱 밖에서 방금 로그인했다면(재확인 성공) 그대로 실행된다', async () => {
    // 첫 호출은 probe → 성공. 이어서 실제 gh 명령이 실행돼야 한다.
    reply = () => ({ code: 0, stdout: '' })
    const res = await mergePr('/tmp/wt', 'squash')
    expect(res.error).toBeUndefined()
    expect(ghCalls()).toEqual(['gh pr merge --squash'])
  })
})

describe('gh 연결됨 (무회귀)', () => {
  beforeEach(() => {
    setGithubConnected(true)
  })

  it('PR 조회가 예전과 동일한 gh 명령을 실행하고 결과를 파싱한다', async () => {
    reply = () =>
      ({
        code: 0,
        stdout: JSON.stringify({
          number: 7,
          url: 'https://github.com/o/r/pull/7',
          title: 'Add thing',
          state: 'OPEN',
          isDraft: false,
          reviewDecision: 'APPROVED',
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'CLEAN'
        })
      }) as { code: number; stdout: string }
    const pr = await getPrStatus('/tmp/wt')
    expect(pr).toEqual({
      number: 7,
      url: 'https://github.com/o/r/pull/7',
      title: 'Add thing',
      state: 'approved',
      label: 'Ready to merge'
    })
    // 연결돼 있으면 확인용 셸을 추가로 띄우지 않는다.
    expect(commands).toEqual([
      'gh pr view --json number,url,title,state,isDraft,reviewDecision,mergeable,mergeStateStatus'
    ])
  })

  it('쓰기 액션은 확인 없이 바로 gh 를 실행한다', async () => {
    reply = () => ({ code: 0, stdout: '' })
    await expect(closePr('/tmp/wt')).resolves.toEqual({})
    expect(commands).toEqual(['gh pr close'])
  })
})

/**
 * `gh pr list` 는 리포 단위 질의라, 같은 리포의 워크스페이스마다 돌리면 같은 응답을 N 번 받는다.
 * PR 상태 전체 훑기가 이 경로를 타므로, 중복이 살아나면 폴링 주기만큼 로그인 셸이 배로 뜬다.
 */
describe('열린 PR 목록 캐시', () => {
  const PR_LIST = JSON.stringify([{ number: 1, headRefName: 'feat', baseRefName: 'main' }])
  const listed = [{ number: 1, head: 'feat', base: 'main' }]

  beforeEach(() => {
    setGithubConnected(true)
    invalidateOpenPrs()
    reply = () => ({ code: 0, stdout: PR_LIST })
  })

  it('같은 리포의 동시 조회는 gh 를 한 번만 실행한다', async () => {
    const results = await Promise.all([
      listOpenPrs('/tmp/a', 'repo-1'),
      listOpenPrs('/tmp/b', 'repo-1'),
      listOpenPrs('/tmp/c', 'repo-1')
    ])
    expect(results).toEqual([listed, listed, listed])
    expect(ghCalls()).toHaveLength(1)
  })

  it('TTL 안의 이어지는 조회는 캐시로 답한다', async () => {
    await listOpenPrs('/tmp/a', 'repo-1')
    await expect(listOpenPrs('/tmp/b', 'repo-1')).resolves.toEqual(listed)
    expect(ghCalls()).toHaveLength(1)
  })

  it('리포가 다르면 각각 조회한다', async () => {
    await Promise.all([listOpenPrs('/tmp/a', 'repo-1'), listOpenPrs('/tmp/b', 'repo-2')])
    expect(ghCalls()).toHaveLength(2)
  })

  it('PR 을 바꾸는 액션 뒤에는 캐시를 버린다', async () => {
    await listOpenPrs('/tmp/a', 'repo-1')
    await closePr('/tmp/a')
    await listOpenPrs('/tmp/a', 'repo-1')
    expect(ghCalls()).toEqual([
      'gh pr list --state open --json number,headRefName,baseRefName --limit 200',
      'gh pr close',
      'gh pr list --state open --json number,headRefName,baseRefName --limit 200'
    ])
  })

  it('조회 도중 무효화되면 그 응답을 캐시에 남기지 않는다', async () => {
    // gh 가 도는 동안 PR 이 바뀐 상황 — 받아 든 목록은 이미 낡았으므로 캐시에 눌러앉으면 안 된다.
    reply = (c) => {
      if (c.startsWith('gh pr list')) invalidateOpenPrs()
      return { code: 0, stdout: PR_LIST }
    }
    await listOpenPrs('/tmp/a', 'repo-1')
    reply = () => ({ code: 0, stdout: PR_LIST })
    await listOpenPrs('/tmp/a', 'repo-1')
    expect(ghCalls()).toHaveLength(2)
  })

  it('캐시 키가 없으면 매번 새로 조회한다(기존 호출부 무회귀)', async () => {
    await listOpenPrs('/tmp/a')
    await listOpenPrs('/tmp/a')
    expect(ghCalls()).toHaveLength(2)
  })
})

describe('연결 확인 캐시', () => {
  it('동시에 몰린 조회는 확인 셸을 한 번만 띄운다', async () => {
    // setGithubConnected 를 거치지 않은 "아직 모름" 상태를 만든다.
    // (미연결로 만들어 두고 읽기 계열을 동시에 호출하면 캐시가 이미 false 라 probe 가 없으므로,
    //  probe 가 필요한 미확정 상태는 모듈을 새로 불러와 재현한다.)
    vi.resetModules()
    commands.length = 0
    reply = () => ({ code: 1, stdout: '' })
    const fresh = await import('./github')
    const results = await Promise.all([
      fresh.getPrStatus('/tmp/a'),
      fresh.getPrStatus('/tmp/b'),
      fresh.listOpenPrs('/tmp/c')
    ])
    expect(results).toEqual([null, null, []])
    expect(commands.filter(isProbe)).toHaveLength(1)
    expect(ghCalls()).toEqual([])
  })
})
