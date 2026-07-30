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
