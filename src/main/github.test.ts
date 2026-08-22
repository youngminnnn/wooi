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

/** 명령별로 stdin 에 흘려보낸 본문. 코멘트 게시가 셸 인용 대신 stdin 을 쓰는지 확인용. */
let stdinWrites: string[] = []

vi.mock('node:child_process', () => ({
  spawn: (_shell: string, args: string[]) => {
    const command = args[1] ?? ''
    commands.push(command)
    const { code, stdout } = reply(command)
    const proc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      // 실제 child process 는 항상 쓰기 가능한 stdin 을 갖는다. 목이 이를 빠뜨리면
      // stdin 을 쓰는 코드 경로가 테스트에서만 터진다.
      stdin: Object.assign(new EventEmitter(), {
        end: (chunk?: string) => {
          if (chunk) stdinWrites.push(chunk)
        }
      })
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
  findOpenPrStatus,
  invalidateOpenPrs,
  getPrChecks,
  createPrWeb,
  mergePr,
  closePr,
  getPrEditable,
  editPr,
  postInlineComment,
  postIssueComment,
  submitPrReview,
  listOpenIssues,
  listOpenPrCandidates,
  canPushToPrHead,
  annotatePrCandidates,
  getIssueBody,
  getPrBody,
  retargetPr,
  remoteRefExists,
  restoreRemoteRef,
  deleteRemoteRef
} = await import('./github')

/** 연결 확인(probe)은 `command -v gh … && gh auth status` 한 줄이다. */
const isProbe = (c: string): boolean => c.startsWith('command -v gh')
const ghCalls = (): string[] => commands.filter((c) => !isProbe(c))

beforeEach(() => {
  commands.length = 0
  stdinWrites = []
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

  it('열린 이슈 목록도 gh 를 실행하지 않고 빈 배열을 돌려준다', async () => {
    reply = () => ({ code: 0, stdout: '' })
    await expect(listOpenIssues('/tmp/wt')).resolves.toEqual([])
    expect(ghCalls()).toEqual([])
  })

  it('PR 후보 목록도 gh 를 실행하지 않고 빈 배열을 돌려준다', async () => {
    reply = () => ({ code: 0, stdout: '' })
    await expect(listOpenPrCandidates('/tmp/wt')).resolves.toEqual([])
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

  it('PR 조회가 체크 롤업까지 함께 조회하고 결과를 파싱한다', async () => {
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
      label: 'Ready to merge',
      needsBaseUpdate: false
    })
    // 연결돼 있으면 확인용 셸을 추가로 띄우지 않는다.
    expect(commands).toEqual([
      'gh pr view --json number,url,title,state,isDraft,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup'
    ])
  })

  it('PR 번호가 있으면 branch 대신 번호 selector 를 쓴다', async () => {
    reply = () => ({ code: 1, stdout: '' })
    await getPrStatus('/tmp/wt', 14196)
    expect(commands).toEqual([
      'gh pr view 14196 --json number,url,title,state,isDraft,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup'
    ])
  })

  it('PR 번호가 없으면 기존 branch selector 를 쓴다', async () => {
    reply = () => ({ code: 1, stdout: '' })
    await getPrStatus('/tmp/wt', 'patch-1')
    expect(commands).toEqual([
      "gh pr view 'patch-1' --json number,url,title,state,isDraft,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup"
    ])
  })

  it.each([
    {
      name: '실행 중인 CI',
      check: { __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS' },
      state: 'ci_pending',
      label: 'Checks pending'
    },
    {
      name: '실패한 CI',
      check: { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
      state: 'ci_failed',
      label: 'Checks failed'
    }
  ])('승인 후 $name 상태를 review required 와 구분한다', async ({ check, state, label }) => {
    reply = () => ({
      code: 0,
      stdout: JSON.stringify({
        number: 8,
        url: 'https://github.com/o/r/pull/8',
        title: 'Approved but blocked by CI',
        state: 'OPEN',
        isDraft: false,
        reviewDecision: 'APPROVED',
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BLOCKED',
        statusCheckRollup: [check]
      })
    })

    await expect(getPrStatus('/tmp/wt')).resolves.toMatchObject({ state, label })
  })

  it('GitHub 가 Update branch 를 요구하면 base 업데이트 필요 상태를 보존한다', async () => {
    reply = () => ({
      code: 0,
      stdout: JSON.stringify({
        number: 9,
        url: 'https://github.com/o/r/pull/9',
        title: 'Behind base',
        state: 'OPEN',
        isDraft: false,
        reviewDecision: 'APPROVED',
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BEHIND'
      })
    })

    await expect(getPrStatus('/tmp/wt')).resolves.toMatchObject({
      state: 'open',
      needsBaseUpdate: true
    })
  })

  it('이미 병합된 PR 에 남은 BEHIND 값은 base 업데이트 필요로 보지 않는다', async () => {
    reply = () => ({
      code: 0,
      stdout: JSON.stringify({
        number: 10,
        url: 'https://github.com/o/r/pull/10',
        title: 'Already merged',
        state: 'MERGED',
        isDraft: false,
        reviewDecision: 'APPROVED',
        mergeable: 'UNKNOWN',
        mergeStateStatus: 'BEHIND'
      })
    })

    await expect(getPrStatus('/tmp/wt')).resolves.toMatchObject({
      state: 'merged',
      needsBaseUpdate: false
    })
  })

  it('쓰기 액션은 확인 없이 바로 gh 를 실행한다', async () => {
    reply = () => ({ code: 0, stdout: '' })
    await expect(closePr('/tmp/wt')).resolves.toEqual({})
    expect(commands).toEqual(['gh pr close'])
  })

  it('열린 이슈 목록을 파싱하고 라벨 이름만 반환한다', async () => {
    reply = () => ({
      code: 0,
      stdout: JSON.stringify([
        {
          number: 12,
          title: 'Fix UI',
          author: { login: 'octo' },
          labels: [{ name: 'frontend' }],
          url: 'https://github.com/o/r/issues/12'
        }
      ])
    })
    await expect(listOpenIssues('/tmp/wt')).resolves.toEqual([
      {
        number: 12,
        title: 'Fix UI',
        author: 'octo',
        labels: ['frontend'],
        url: 'https://github.com/o/r/issues/12'
      }
    ])
    expect(commands).toEqual([
      'gh issue list --state open --json number,title,author,labels,url --limit 100'
    ])
  })

  it('공유 PR 후보 목록은 workspace 생성에 필요한 권한 필드를 한 번에 요청한다', async () => {
    reply = () => ({
      code: 0,
      stdout: JSON.stringify([
        {
          number: 7,
          title: 'PR',
          headRefName: 'feat/pr',
          baseRefName: 'main',
          author: { login: 'octo' },
          isCrossRepository: true,
          headRepositoryOwner: { login: 'fork-owner' },
          maintainerCanModify: true,
          url: 'https://github.com/o/r/pull/7',
          isDraft: false
        }
      ])
    })
    await expect(listOpenPrCandidates('/tmp/wt')).resolves.toEqual([
      {
        number: 7,
        title: 'PR',
        head: 'feat/pr',
        base: 'main',
        author: 'octo',
        isCrossRepository: true,
        headRepositoryOwner: 'fork-owner',
        maintainerCanModify: true,
        url: 'https://github.com/o/r/pull/7',
        isDraft: false
      }
    ])
    expect(commands).toEqual([
      'gh pr list --state open --json number,title,headRefName,baseRefName,author,isCrossRepository,headRepositoryOwner,maintainerCanModify,url,isDraft --limit 100'
    ])
  })

  it('이슈 목록 JSON 이 깨지면 빈 배열을 반환한다', async () => {
    reply = () => ({ code: 0, stdout: '{bad' })
    await expect(listOpenIssues('/tmp/wt')).resolves.toEqual([])
  })

  it('이슈 목록 명령이 실패하면 빈 배열을 반환한다', async () => {
    reply = () => ({ code: 1, stdout: 'nope' })
    await expect(listOpenIssues('/tmp/wt')).resolves.toEqual([])
  })

  it('선택한 이슈 본문만 별도 조회한다', async () => {
    reply = () => ({ code: 0, stdout: JSON.stringify({ body: 'Details' }) })
    await expect(getIssueBody('/tmp/wt', 12)).resolves.toBe('Details')
    expect(commands).toEqual(['gh issue view 12 --json body'])
  })

  it('선택한 PR 본문만 별도 조회한다', async () => {
    reply = () => ({ code: 0, stdout: JSON.stringify({ body: 'PR details' }) })
    await expect(getPrBody('/tmp/wt', 13)).resolves.toBe('PR details')
    expect(commands).toEqual(['gh pr view 13 --json body'])
  })
})

describe('PR head push 권한', () => {
  it.each([
    ['same-repo PR', { isCrossRepository: false }, 'me', false, true],
    [
      'my own fork',
      { isCrossRepository: true, headRepositoryOwner: 'me', maintainerCanModify: false },
      'me',
      false,
      true
    ],
    [
      "someone else's writable fork",
      { isCrossRepository: true, headRepositoryOwner: 'other', maintainerCanModify: true },
      'me',
      true,
      true
    ],
    [
      "someone else's locked fork",
      { isCrossRepository: true, headRepositoryOwner: 'other', maintainerCanModify: false },
      'me',
      true,
      false
    ],
    ['unknown metadata', {}, 'me', true, false]
  ] as const)('%s', (_name, pr, viewer, writable, expected) => {
    expect(canPushToPrHead(pr, viewer, writable)).toBe(expected)
  })

  it('후보마다 생성 가능 여부와 작성자 여부를 main 에서 함께 표시한다', () => {
    const candidates = [
      {
        number: 1,
        title: 'Same repo',
        head: 'same',
        base: 'main',
        author: 'me',
        isCrossRepository: false
      },
      {
        number: 2,
        title: 'My fork',
        head: 'mine',
        base: 'main',
        author: 'me',
        isCrossRepository: true,
        headRepositoryOwner: 'me'
      },
      {
        number: 3,
        title: 'Writable fork',
        head: 'writable',
        base: 'main',
        author: 'other',
        isCrossRepository: true,
        headRepositoryOwner: 'other',
        maintainerCanModify: true
      },
      {
        number: 4,
        title: 'Locked fork',
        head: 'locked',
        base: 'main',
        author: 'other',
        isCrossRepository: true,
        headRepositoryOwner: 'other',
        maintainerCanModify: false
      }
    ]

    const annotated = annotatePrCandidates(candidates, 'me', true)

    expect(
      annotated.map((candidate) => ({
        number: candidate.number,
        canCreateWorkspace: candidate.canCreateWorkspace,
        reason: candidate.createWorkspaceDisabledReason,
        isViewerAuthor: candidate.isViewerAuthor
      }))
    ).toEqual([
      { number: 1, canCreateWorkspace: true, reason: undefined, isViewerAuthor: true },
      { number: 2, canCreateWorkspace: true, reason: undefined, isViewerAuthor: true },
      { number: 3, canCreateWorkspace: true, reason: undefined, isViewerAuthor: false },
      {
        number: 4,
        canCreateWorkspace: false,
        reason: "You don't have permission to push to this PR's head branch.",
        isViewerAuthor: false
      }
    ])
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
    const list = ghCalls().filter((c) => c.startsWith('gh pr list'))
    expect(list).toHaveLength(2)
    expect(ghCalls()[1]).toBe('gh pr close')
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

/**
 * 사이드바 PR 칩은 예전에 워크스페이스마다 `gh pr view` 를 띄워 채웠다 — 워크스페이스가 10개를
 * 넘어가면 앱을 켤 때마다 그만큼의 로그인 셸이 동시에 떴다. 열린 PR 이라면 리포 목록에 이미 다
 * 들어 있으므로, 그 목록 하나로 전부 답해야 한다.
 */
describe('브랜치별 PR 상태를 리포 목록에서 찾기', () => {
  const rows = JSON.stringify([
    {
      number: 7,
      url: 'https://gh/pr/7',
      title: '제목',
      state: 'OPEN',
      isDraft: false,
      reviewDecision: 'APPROVED',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      headRefName: 'feat/a',
      baseRefName: 'main'
    }
  ])

  beforeEach(() => {
    setGithubConnected(true)
    invalidateOpenPrs()
    reply = () => ({ code: 0, stdout: rows })
  })

  it('워크스페이스가 여럿이어도 gh 는 리포당 한 번만 실행된다', async () => {
    const results = await Promise.all([
      findOpenPrStatus('/tmp/a', 'repo-1', 'feat/a'),
      findOpenPrStatus('/tmp/b', 'repo-1', 'feat/a'),
      findOpenPrStatus('/tmp/c', 'repo-1', 'feat/a')
    ])
    expect(results[0]).toEqual({
      number: 7,
      url: 'https://gh/pr/7',
      title: '제목',
      state: 'approved',
      label: 'Ready to merge',
      needsBaseUpdate: false
    })
    expect(results[1]).toEqual(results[0])
    expect(results[2]).toEqual(results[0])
    expect(ghCalls()).toHaveLength(1)
  })

  it('스택 감지와 상태 칩이 같은 조회를 나눠 쓴다', async () => {
    await listOpenPrs('/tmp/a', 'repo-1')
    await findOpenPrStatus('/tmp/a', 'repo-1', 'feat/a')
    expect(ghCalls()).toHaveLength(1)
  })

  it('번호를 알면 같은 이름을 쓴 다른 fork PR 대신 그 번호로 찾는다', async () => {
    reply = () => ({
      code: 0,
      stdout: JSON.stringify([
        ...JSON.parse(rows),
        {
          ...JSON.parse(rows)[0],
          number: 8,
          url: 'https://gh/pr/8',
          title: '다른 fork',
          headRefName: 'feat/a'
        }
      ])
    })

    await expect(findOpenPrStatus('/tmp/a', 'repo-number', 'feat/a', 8)).resolves.toMatchObject({
      number: 8,
      url: 'https://gh/pr/8'
    })
  })

  it('열린 PR 이 아닌 브랜치는 null 을 돌려준다(호출부가 개별 조회로 메운다)', async () => {
    await expect(findOpenPrStatus('/tmp/a', 'repo-1', 'feat/없음')).resolves.toBeNull()
  })
})

describe('리뷰 코멘트 게시', () => {
  beforeEach(() => {
    setGithubConnected(true)
  })

  /**
   * 코멘트 본문은 사용자가 직접 편집한 임의의 마크다운이다. 명령 문자열에 끼워 넣으면
   * 작은따옴표 하나로 셸 인용이 깨지고 `$(...)`·백틱이 실행된다. 본문은 반드시 stdin 으로만
   * 나가야 하며, 명령줄에는 흔적조차 없어야 한다.
   */
  it('본문을 명령줄이 아니라 stdin 으로 넘긴다', async () => {
    reply = () => ({ code: 0, stdout: JSON.stringify({ html_url: 'https://gh/c/1' }) })
    const body = `'; rm -rf /; echo '` + '`whoami`' + ' $(id)\n둘째 줄 "따옴표"'

    const res = await postInlineComment('/tmp/repo', 42, {
      body,
      commitId: 'abc1234def5678',
      path: 'src/a.ts',
      line: 10,
      side: 'RIGHT'
    })

    expect(res).toEqual({ url: 'https://gh/c/1' })
    expect(ghCalls()).toEqual([
      'gh api --method POST repos/{owner}/{repo}/pulls/42/comments --input -'
    ])
    // 본문의 어떤 조각도 명령줄에 새어 나가면 안 된다.
    expect(ghCalls()[0]).not.toContain('rm -rf')
    expect(ghCalls()[0]).not.toContain('whoami')
    expect(JSON.parse(stdinWrites[0])).toEqual({
      body,
      commit_id: 'abc1234def5678',
      path: 'src/a.ts',
      line: 10,
      side: 'RIGHT'
    })
  })

  it('멀티라인 지적은 start_line 과 start_side 를 함께 보낸다', async () => {
    reply = () => ({ code: 0, stdout: '{}' })
    await postInlineComment('/tmp/repo', 42, {
      body: 'b',
      commitId: 'abc1234',
      path: 'src/a.ts',
      line: 10,
      side: 'RIGHT',
      startLine: 7
    })
    expect(JSON.parse(stdinWrites[0])).toMatchObject({ start_line: 7, start_side: 'RIGHT' })
  })

  it('startLine 이 line 보다 뒤면 한 줄 코멘트로 보낸다', async () => {
    reply = () => ({ code: 0, stdout: '{}' })
    await postInlineComment('/tmp/repo', 42, {
      body: 'b',
      commitId: 'abc1234',
      path: 'src/a.ts',
      line: 10,
      side: 'RIGHT',
      startLine: 12
    })
    expect(JSON.parse(stdinWrites[0])).not.toHaveProperty('start_line')
  })

  it('전반 코멘트는 issues 엔드포인트로 간다', async () => {
    reply = () => ({ code: 0, stdout: '{}' })
    await postIssueComment('/tmp/repo', 42, '총평입니다')
    expect(ghCalls()).toEqual([
      'gh api --method POST repos/{owner}/{repo}/issues/42/comments --input -'
    ])
    expect(JSON.parse(stdinWrites[0])).toEqual({ body: '총평입니다' })
  })

  /** gh 는 GitHub 이 돌려준 오류 본문을 stdout 에 찍는다 — 사용자에게 필요한 문장이 거기 있다. */
  it('GitHub 오류 메시지를 그대로 사용자에게 전달한다', async () => {
    reply = () => ({
      code: 1,
      stdout: JSON.stringify({
        message: 'Validation Failed',
        errors: [{ message: 'line must be part of the diff' }]
      })
    })
    const res = await postInlineComment('/tmp/repo', 42, {
      body: 'b',
      commitId: 'abc1234',
      path: 'src/a.ts',
      line: 999,
      side: 'RIGHT'
    })
    expect(res.error).toContain('Validation Failed')
    expect(res.error).toContain('line must be part of the diff')
  })

  it('잘못된 PR 번호·커밋 sha 는 gh 를 실행하지 않고 거른다', async () => {
    reply = () => ({ code: 0, stdout: '{}' })
    const badPr = await postInlineComment('/tmp/repo', 0, {
      body: 'b',
      commitId: 'abc1234',
      path: 'a.ts',
      line: 1,
      side: 'RIGHT'
    })
    expect(badPr.error).toBeTruthy()

    const badSha = await postInlineComment('/tmp/repo', 42, {
      body: 'b',
      commitId: 'not a sha',
      path: 'a.ts',
      line: 1,
      side: 'RIGHT'
    })
    expect(badSha.error).toBeTruthy()
    expect(ghCalls()).toEqual([])
  })
})

/**
 * 제목·본문은 사용자가 무엇이든 쓰는 문자열이다. `gh pr edit --title/--body` 로 가면 따옴표
 * 하나로 셸 인용이 뚫리고 백틱·`$(...)` 이 실행된다. 값은 반드시 stdin(JSON)으로만 나가야 한다.
 */
describe('PR 제목·본문 편집', () => {
  beforeEach(() => {
    setGithubConnected(true)
    invalidateOpenPrs()
  })

  it('편집 모달용 원문은 제목·본문만 따로 읽는다', async () => {
    reply = () => ({ code: 0, stdout: JSON.stringify({ title: '제목', body: '본문\n둘째 줄' }) })
    await expect(getPrEditable('/tmp/wt')).resolves.toEqual({
      title: '제목',
      body: '본문\n둘째 줄'
    })
    expect(commands).toEqual(['gh pr view --json title,body'])
  })

  it('본문이 없는 PR 은 빈 문자열로 읽힌다', async () => {
    reply = () => ({ code: 0, stdout: JSON.stringify({ title: '제목', body: null }) })
    await expect(getPrEditable('/tmp/wt')).resolves.toEqual({ title: '제목', body: '' })
  })

  it('조회가 실패하거나 JSON 이 깨지면 null 을 돌려준다', async () => {
    reply = () => ({ code: 1, stdout: '' })
    await expect(getPrEditable('/tmp/wt')).resolves.toBeNull()
    reply = () => ({ code: 0, stdout: '{bad' })
    await expect(getPrEditable('/tmp/wt')).resolves.toBeNull()
  })

  it('제목·본문을 명령줄이 아니라 stdin 으로 넘긴다', async () => {
    reply = () => ({ code: 0, stdout: '{}' })
    const title = `'; rm -rf /; echo '` + '`whoami`'
    const body = '백틱 `$(id)` 와 $HOME\n둘째 줄 "따옴표" \\ 역슬래시'

    await expect(editPr('/tmp/wt', { title, body }, 42)).resolves.toEqual({})

    expect(ghCalls()).toEqual(['gh api --method PATCH repos/{owner}/{repo}/pulls/42 --input -'])
    // 값의 어떤 조각도 명령줄에 새어 나가면 안 된다.
    expect(ghCalls()[0]).not.toContain('rm -rf')
    expect(ghCalls()[0]).not.toContain('whoami')
    expect(ghCalls()[0]).not.toContain('$HOME')
    expect(JSON.parse(stdinWrites[0])).toEqual({ title, body })
  })

  it('준 필드만 보낸다 — 손대지 않은 쪽은 GitHub 에 있는 값 그대로 남는다', async () => {
    reply = () => ({ code: 0, stdout: '{}' })
    await editPr('/tmp/wt', { title: '새 제목' }, 42)
    expect(JSON.parse(stdinWrites[0])).toEqual({ title: '새 제목' })
  })

  /** 본문을 통째로 지우는 것도 정당한 편집이다 — 빈 문자열과 미지정을 구분해야 한다. */
  it('빈 본문은 미지정이 아니라 "비우기" 로 전달된다', async () => {
    reply = () => ({ code: 0, stdout: '{}' })
    await editPr('/tmp/wt', { body: '' }, 42)
    expect(JSON.parse(stdinWrites[0])).toEqual({ body: '' })
  })

  it('바꿀 필드가 없으면 gh 를 실행하지 않는다', async () => {
    reply = () => ({ code: 0, stdout: '{}' })
    await expect(editPr('/tmp/wt', {})).resolves.toEqual({})
    expect(commands).toEqual([])
  })

  it('PR 번호를 모르면 현재 브랜치에서 찾아 쓴다', async () => {
    reply = (c) =>
      c.startsWith('gh pr view')
        ? { code: 0, stdout: JSON.stringify({ number: 7 }) }
        : { code: 0, stdout: '{}' }
    await editPr('/tmp/wt', { title: 't' })
    expect(ghCalls()).toEqual([
      'gh pr view --json number',
      'gh api --method PATCH repos/{owner}/{repo}/pulls/7 --input -'
    ])
  })

  it('브랜치에 PR 이 없으면 gh api 를 부르지 않고 사유를 돌려준다', async () => {
    reply = () => ({ code: 1, stdout: '' })
    const res = await editPr('/tmp/wt', { title: 't' })
    expect(res.error).toMatch(/could not find a pull request/i)
    expect(ghCalls().some((c) => c.startsWith('gh api'))).toBe(false)
  })

  /** GitHub 이 거절하면(빈 제목 등) 그 문장이 사용자에게 필요한 정보다. */
  it('GitHub 오류 메시지를 그대로 전달한다', async () => {
    reply = () => ({
      code: 1,
      stdout: JSON.stringify({
        message: 'Validation Failed',
        errors: [{ message: 'title cannot be blank' }]
      })
    })
    const res = await editPr('/tmp/wt', { title: '' }, 42)
    expect(res.error).toContain('Validation Failed')
    expect(res.error).toContain('title cannot be blank')
  })

  /** 제목은 리포 단위 열린 PR 목록에도 실려 있다 — 안 버리면 사이드바가 옛 제목을 계속 보여 준다. */
  it('편집 뒤에는 열린 PR 목록 캐시를 버린다', async () => {
    reply = (c) =>
      c.startsWith('gh pr list')
        ? {
            code: 0,
            stdout: JSON.stringify([{ number: 1, headRefName: 'f', baseRefName: 'main' }])
          }
        : { code: 0, stdout: '{}' }
    await listOpenPrs('/tmp/wt', 'repo-1')
    await editPr('/tmp/wt', { title: '새 제목' }, 42)
    await listOpenPrs('/tmp/wt', 'repo-1')
    expect(ghCalls().filter((c) => c.startsWith('gh pr list'))).toHaveLength(2)
  })

  it('미연결이면 gh 를 실행하지 않고 안내 메시지를 돌려준다', async () => {
    setGithubConnected(false)
    reply = () => ({ code: 1, stdout: '' }) // 재확인(probe)도 실패 = 여전히 미연결
    const res = await editPr('/tmp/wt', { title: 't' }, 42)
    expect(res.error).toMatch(/GitHub is not connected/)
    expect(ghCalls()).toEqual([])
  })
})

describe('PR 리뷰 제출', () => {
  beforeEach(() => {
    setGithubConnected(true)
  })

  it('승인은 본문 없이도 보낼 수 있고 --body-file 을 붙이지 않는다', async () => {
    reply = () => ({ code: 0, stdout: '' })
    await expect(submitPrReview('/tmp/repo', 42, 'approve', '  ')).resolves.toEqual({})
    expect(ghCalls()).toEqual(['gh pr review 42 --approve'])
    expect(stdinWrites).toEqual([])
  })

  it('본문이 있으면 stdin 으로 넘긴다', async () => {
    reply = () => ({ code: 0, stdout: '' })
    const body = `'; rm -rf /; echo '` + '`whoami`' + '\n둘째 줄'
    await submitPrReview('/tmp/repo', 42, 'approve', body)
    expect(ghCalls()).toEqual(['gh pr review 42 --approve --body-file -'])
    // 본문이 명령줄로 새면 셸이 실행해 버린다.
    expect(ghCalls()[0]).not.toContain('rm -rf')
    expect(stdinWrites[0]).toBe(body)
  })

  /** GitHub 이 422 를 주기 전에 우리가 먼저 막는다 — 눌러 보고 실패하는 UX 를 피한다. */
  it('변경 요청·코멘트는 본문이 없으면 gh 를 실행하지 않는다', async () => {
    reply = () => ({ code: 0, stdout: '' })
    for (const verdict of ['request-changes', 'comment'] as const) {
      const res = await submitPrReview('/tmp/repo', 42, verdict, '   ')
      expect(res.error).toMatch(/required/i)
    }
    expect(ghCalls()).toEqual([])
  })

  it('변경 요청은 --request-changes 로 나간다', async () => {
    reply = () => ({ code: 0, stdout: '' })
    await submitPrReview('/tmp/repo', 42, 'request-changes', 'needs work')
    expect(ghCalls()).toEqual(['gh pr review 42 --request-changes --body-file -'])
    expect(stdinWrites[0]).toBe('needs work')
  })

  it('코멘트는 --comment 로 나간다', async () => {
    reply = () => ({ code: 0, stdout: '' })
    await submitPrReview('/tmp/repo', 42, 'comment', 'looks fine')
    expect(ghCalls()).toEqual(['gh pr review 42 --comment --body-file -'])
  })

  /** 자기 PR 승인 같은 거절은 gh 가 stdout 으로 알려 준다 — 그 문장이 사용자에게 필요한 정보다. */
  it('GitHub 거절 사유를 그대로 전달한다', async () => {
    reply = () => ({ code: 1, stdout: 'Can not approve your own pull request' })
    const res = await submitPrReview('/tmp/repo', 42, 'approve', '')
    expect(res.error).toContain('Can not approve your own pull request')
  })

  it('잘못된 PR 번호는 gh 를 실행하지 않는다', async () => {
    reply = () => ({ code: 0, stdout: '' })
    const res = await submitPrReview('/tmp/repo', 0, 'approve', '')
    expect(res.error).toBeTruthy()
    expect(ghCalls()).toEqual([])
  })
})

/**
 * 브랜치 이름은 우리가 정하는 값이 아니다 — 워크트리의 실제 HEAD 와 GitHub 의 ref 이름이
 * 그대로 들어오고, git 은 거기에 `'` 와 `;` 를 허용한다. 이 명령들은 **메인 프로세스의
 * 로그인 셸**에서 도는 데다 PR 상태 폴링만으로 발동하므로, 인용이 뚫리면 에이전트의 권한
 * 카드와 샌드박스를 통째로 우회한다. 그래서 "감쌌다"가 아니라 "탈출까지 했다"를 확인한다.
 */
describe('셸 인용', () => {
  // 정당한 브랜치 이름이면서 그냥 감싸기만 하면 `id` 가 별도 명령으로 실행되는 모양.
  const evil = "x';id;'y"
  /** 감싸기가 실제로 닫혔는지 — 인용 밖에 명령 구분자가 남으면 안 된다. */
  const injected = (command: string): boolean => /';\s*id\s*;'/.test(command.replace(/'\\''/g, ''))

  beforeEach(() => {
    setGithubConnected(true)
    reply = () => ({ code: 0, stdout: '' })
  })

  it('PR 조회의 브랜치 이름을 탈출시킨다', async () => {
    await getPrStatus('/tmp/wt', evil)
    const [command] = ghCalls()
    expect(command).toContain(`'x'\\''`)
    expect(injected(command)).toBe(false)
  })

  it('retarget 의 selector·base 를 탈출시킨다', async () => {
    await retargetPr('/tmp/wt', evil, evil)
    const [command] = ghCalls()
    expect(injected(command)).toBe(false)
  })

  it('원격 ref 조작의 브랜치 이름을 탈출시킨다', async () => {
    await remoteRefExists('/tmp/wt', evil)
    await restoreRemoteRef('/tmp/wt', evil, 'deadbeef')
    await deleteRemoteRef('/tmp/wt', evil)
    for (const command of ghCalls()) expect(injected(command)).toBe(false)
  })

  it('PR 생성 화면의 base·head 를 탈출시킨다', async () => {
    await createPrWeb('/tmp/wt', { base: evil, head: evil })
    const [command] = ghCalls()
    expect(injected(command)).toBe(false)
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
