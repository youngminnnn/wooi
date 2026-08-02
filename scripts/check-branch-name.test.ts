import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SCRIPT = fileURLToPath(new URL('./check-branch-name.mjs', import.meta.url))

/** 스크립트를 실제로 실행해 exit code 를 돌려준다. 검증 대상이 exit code 계약이므로
 *  내부 함수를 import 하지 않고 CI·husky 가 부르는 방식 그대로 부른다. */
function run(...args: string[]): number {
  try {
    execFileSync(process.execPath, [SCRIPT, ...args], { stdio: 'pipe' })
    return 0
  } catch (err) {
    return (err as { status: number }).status
  }
}

const ZERO = '0'.repeat(40)
const SHA = 'a'.repeat(40)

/** git 이 pre-push 훅에 넘기는 stdin 한 줄. */
function refLine(localRef: string, remoteRef: string, localSha = SHA): string {
  return `${localRef} ${localSha} ${remoteRef} ${SHA}`
}

/** 훅 모드를 stdin 과 함께 실행한다. */
function runPrePush(...lines: string[]): number {
  try {
    execFileSync(process.execPath, [SCRIPT, '--pre-push'], {
      input: lines.join('\n') + '\n',
      stdio: 'pipe'
    })
    return 0
  } catch (err) {
    return (err as { status: number }).status
  }
}

describe('check-branch-name', () => {
  it('타입 prefix 규칙을 지키는 브랜치는 통과한다', () => {
    for (const branch of [
      'feat/inline-github-login',
      'fix/first-message-stall',
      'docs/readme-demo-gif',
      'release/v1.2.0',
      'chore/deps/bump-electron'
    ]) {
      expect(run(branch), branch).toBe(0)
    }
  })

  it('보호 브랜치는 통과한다', () => {
    expect(run('main')).toBe(0)
    expect(run('HEAD')).toBe(0)
  })

  // 봇은 브랜치 이름을 바꿀 수 없으므로, 막으면 그 PR 은 영구히 머지 불가가 된다.
  it('Dependabot 브랜치는 통과한다', () => {
    for (const branch of [
      'dependabot/npm_and_yarn/electron-43.1.0',
      'dependabot/npm_and_yarn/types/node-26.1.1',
      'dependabot/npm_and_yarn/minor-and-patch-f723dd3fd3',
      'dependabot/github_actions/actions/checkout-7'
    ]) {
      expect(run(branch), branch).toBe(0)
    }
  })

  it('규칙을 어긴 사람 브랜치는 여전히 막는다', () => {
    for (const branch of [
      'my-change',
      'feature/inline-login', // 'feature' 는 허용 타입이 아니다
      'feat',
      'feat/',
      'FEAT/inline-login',
      'notdependabot/npm_and_yarn/electron-43.1.0' // prefix 는 시작 위치에서만 인정
    ]) {
      expect(run(branch), branch).toBe(1)
    }
  })

  it('인자가 없으면 잘못된 호출로 구분한다', () => {
    expect(run()).toBe(2)
    expect(run('   ')).toBe(2)
  })
})

describe('check-branch-name --pre-push', () => {
  it('규칙을 지키는 push 는 통과한다', () => {
    expect(runPrePush(refLine('refs/heads/feat/x', 'refs/heads/feat/x'))).toBe(0)
  })

  it('규칙을 어긴 push 는 막는다', () => {
    expect(runPrePush(refLine('refs/heads/my-change', 'refs/heads/my-change'))).toBe(1)
  })

  // 이 훅이 통제하려는 건 저장소에 만들어지는 이름이므로 **원격 ref** 를 봐야 한다.
  // 로컬 이름을 보면 아래 두 케이스가 정확히 거꾸로 판정된다.
  it('로컬과 원격 이름이 다르면 원격 이름으로 판정한다', () => {
    // 로컬은 규칙 위반이지만 원격은 예외 대상 — 통과해야 한다.
    // (실제로 dependabot 브랜치에 리베이스 결과를 push 하다 막혔던 케이스)
    expect(
      runPrePush(
        refLine('refs/heads/rebase-145', 'refs/heads/dependabot/npm_and_yarn/minor-and-patch')
      )
    ).toBe(0)

    // 로컬은 규칙을 지키지만 원격이 위반 — 막아야 한다.
    expect(runPrePush(refLine('refs/heads/feat/x', 'refs/heads/my-change'))).toBe(1)
  })

  it('브랜치 삭제 push 는 건너뛴다', () => {
    expect(runPrePush(refLine('(delete)', 'refs/heads/my-change', ZERO))).toBe(0)
  })

  it('태그 등 브랜치가 아닌 ref 는 건너뛴다', () => {
    expect(runPrePush(refLine('refs/tags/v1.2.0', 'refs/tags/v1.2.0'))).toBe(0)
  })

  it('여러 ref 중 하나라도 위반이면 막는다', () => {
    expect(
      runPrePush(
        refLine('refs/heads/feat/ok', 'refs/heads/feat/ok'),
        refLine('refs/heads/bad-name', 'refs/heads/bad-name')
      )
    ).toBe(1)
  })

  it('푸시할 ref 가 없으면 통과한다', () => {
    expect(runPrePush()).toBe(0)
  })
})
