import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { restackOnto } from './git'
import { detectRemoteDivergence, divergedMessage } from './cascade'

/**
 * 갈라짐의 **원인 구분**을 진짜 git 저장소로 재현한다. cascade.test.ts 는 './git' 을 통째로
 * 모킹해서 정책(어느 상태에 어느 문구)을 빠르게 덮지만, 이 판정의 근거는 리플로그라는 git 의
 * 실제 산출물이라 모킹으로는 확인할 수 없다 — 사유 문구가 우리 기대와 다르면 판정이 통째로
 * 뒤집히는데, 모킹된 테스트는 그걸 영원히 모른다. 그래서 별도 파일이다.
 *
 * 재현하는 사고: 리베이스를 두 번 눌렀는데 2차 push 가 pre-push 훅에 막혔고(워크트리의
 * node_modules 가 낡아 typecheck 실패), UI 는 "rebased" 라고만 말했다. 3차 시도에서 리모트가
 * 로컬의 조상이 아니라는 이유로 "GitHub 이 다시 썼다" 는 문구가 떴고, 그 문구가 권하는
 * `git reset --hard origin/<branch>` 는 새 base 위로 옮긴 결과를 버리는 길이었다.
 */
describe('detectRemoteDivergence — 갈라짐의 원인을 가른다 (실제 저장소)', () => {
  let root: string
  let worktree: string
  let origin: string
  let other: string

  const git = (cwd: string, args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()

  const rejectPush = (): void => {
    const hook = join(worktree, '.git', 'hooks', 'pre-push')
    writeFileSync(
      hook,
      '#!/bin/sh\necho "Cannot find module \'@testing-library/react\'" 1>&2\nexit 1\n'
    )
    chmodSync(hook, 0o755)
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wooi-divergence-'))
    origin = join(root, 'origin.git')
    worktree = join(root, 'worktree')
    other = join(root, 'other')
    git(root, ['init', '-q', '--bare', '-b', 'main', origin])
    execFileSync('git', ['clone', '-q', origin, worktree])
    git(worktree, ['config', 'user.email', 'test@example.com'])
    git(worktree, ['config', 'user.name', 'test'])
    writeFileSync(join(worktree, 'base.txt'), 'one\n')
    git(worktree, ['add', '-A'])
    git(worktree, ['commit', '-qm', 'base'])
    git(worktree, ['push', '-q', '-u', 'origin', 'main'])
    // 브랜치를 내고 한 번 성공적으로 push 한다(= PR 이 열린 상태).
    git(worktree, ['checkout', '-qb', 'fix/x'])
    writeFileSync(join(worktree, 'mine.txt'), 'mine\n')
    git(worktree, ['add', '-A'])
    git(worktree, ['commit', '-qm', 'mine'])
    git(worktree, ['push', '-q', '-u', 'origin', 'fix/x'])
    execFileSync('git', ['clone', '-q', origin, other])
    git(other, ['config', 'user.email', 'other@example.com'])
    git(other, ['config', 'user.name', 'other'])
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  /** main 을 앞으로 밀어 restack 이 실제로 리라이트할 거리를 만든다. */
  const moveMain = (): void => {
    git(other, ['checkout', '-q', 'main'])
    writeFileSync(join(other, 'theirs.txt'), 'theirs\n')
    git(other, ['add', '-A'])
    git(other, ['commit', '-qm', 'theirs'])
    git(other, ['push', '-q', 'origin', 'main'])
  }

  // (a) 리모트를 남이 다시 썼다 — GitHub 이 스택 아래층 병합 뒤 위 브랜치를 서버에서 rebase 한 경우.
  it('still calls a remote rewritten elsewhere diverged', async () => {
    git(other, ['checkout', '-q', 'fix/x'])
    writeFileSync(join(other, 'mine.txt'), 'rewritten by the server\n')
    git(other, ['commit', '-qam', 'mine', '--amend'])
    git(other, ['push', '-q', '--force', 'origin', 'fix/x'])
    // 객체를 받아 둔다 — 받지 못한 히스토리는 리플로그를 보기도 전에 갈라짐으로 끊기므로,
    // 여기서 확인하려는 리플로그 경로를 실제로 지나게 하려면 fetch 가 필요하다.
    git(worktree, ['fetch', '-q', 'origin'])

    expect(await detectRemoteDivergence(worktree, 'fix/x')).toBe('diverged')
  })

  // (b) 내 push 가 거부돼 로컬만 앞섰다 — 사고의 재현.
  it('names the failed push instead of blaming GitHub', async () => {
    moveMain()
    rejectPush()

    const res = await restackOnto(worktree, 'main')
    // 1단계: 실패가 호출자에게 올라온다(예전에는 여기서 조용히 삼켰다).
    expect(res).toMatchObject({ status: 'restacked', pushed: false })
    expect(res.pushError).toContain('@testing-library/react')

    // 2단계: 그다음 restack 이 이 상태를 남의 짓으로 오진하지 않는다.
    const state = await detectRemoteDivergence(worktree, 'fix/x')
    expect(state).toBe('diverged-stale-push')

    // 3단계: 문구가 정반대의 처방으로 이끌지 않는다(사유는 바로 위에서 단언했다).
    const message = divergedMessage('fix/x', 'diverged-stale-push')
    expect(message).toContain('git push --force-with-lease origin fix/x')
    expect(message).not.toContain('git reset --hard')
  })

  // 리플로그를 읽을 수 없으면(만료·core.logAllRefUpdates 끔) 모르는 것이다 → 보수적으로 남는다.
  it('falls back to the rewritten wording when the reflog is gone', async () => {
    moveMain()
    rejectPush()
    await restackOnto(worktree, 'main')
    rmSync(join(worktree, '.git', 'logs', 'refs', 'remotes', 'origin', 'fix'), {
      recursive: true,
      force: true
    })

    expect(await detectRemoteDivergence(worktree, 'fix/x')).toBe('diverged')
  })

  // 통제군. 우리 push 가 마지막이더라도 리모트가 로컬의 조상이면 그냥 "아직 안 밀었다" 다.
  it('does not turn ordinary unpushed commits into a divergence', async () => {
    writeFileSync(join(worktree, 'more.txt'), 'more\n')
    git(worktree, ['add', '-A'])
    git(worktree, ['commit', '-qm', 'more'])

    expect(await detectRemoteDivergence(worktree, 'fix/x')).toBe('local-ahead')
  })

  it('reads a successful push as in sync', async () => {
    expect(await detectRemoteDivergence(worktree, 'fix/x')).toBe('in-sync')
  })
})
