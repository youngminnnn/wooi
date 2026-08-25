import { describe, expect, it } from 'vitest'

import { checkE2eCoverage, resolveBaseRef } from './check-e2e-coverage.mjs'

function check(
  branchName: string,
  changedFiles: string[],
  commitMessages: string[] = ['feat: change behavior']
) {
  return checkE2eCoverage({ branchName, changedFiles, commitMessages })
}

describe('check-e2e-coverage', () => {
  it('원격 base ref 를 로컬 ref 보다 먼저 선택한다', () => {
    const calls: string[][] = []
    const git = (...args: string[]) => {
      calls.push(args)
      return 'resolved\n'
    }

    expect(resolveBaseRef('feat/parent', git)).toBe('origin/feat/parent')
    expect(calls).toEqual([['rev-parse', '--verify', '--quiet', 'origin/feat/parent']])
  })

  it('원격 base ref 가 없으면 로컬 ref 로 fallback 한다', () => {
    const git = (...args: string[]) => {
      if (args.at(-1) === 'origin/feat/parent') throw new Error('missing')
      return 'resolved\n'
    }

    expect(resolveBaseRef('feat/parent', git)).toBe('feat/parent')
  })

  it('base ref 를 찾지 못하면 ref 와 full-history 해결책을 알린다', () => {
    const git = () => {
      throw new Error('missing')
    }

    expect(() => resolveBaseRef('feat/parent', git)).toThrow(
      'could not resolve base branch "feat/parent" as "origin/feat/parent" or "feat/parent". Ensure the checkout has full history (actions/checkout with fetch-depth: 0).'
    )
  })

  it('feat 와 fix 가 아닌 브랜치 타입은 면제한다', () => {
    expect(check('docs/e2e-notes', ['src/renderer/src/App.tsx']).ok).toBe(true)
  })

  it('이름 규칙에 맞지 않는 브랜치는 별도 branch-name 게이트에 맡긴다', () => {
    expect(check('agile-cicada', ['src/renderer/src/App.tsx'])).toMatchObject({
      ok: true,
      reason: 'exempt-branch-type'
    })
  })

  it('renderer 를 바꾼 feat 브랜치에 e2e 변경이 없으면 실패한다', () => {
    const verdict = check('feat/new-panel', ['src/renderer/src/App.tsx'])
    expect(verdict.ok).toBe(false)
    expect(verdict.triggeringFiles).toEqual(['src/renderer/src/App.tsx'])
  })

  it('renderer 변경과 e2e 스펙 변경이 함께 있으면 통과한다', () => {
    expect(
      check('feat/new-panel', ['src/renderer/src/App.tsx', 'e2e/specs/new-panel.spec.mjs']).ok
    ).toBe(true)
  })

  it('e2e README 만 바꾸는 것은 coverage 로 세지 않는다', () => {
    expect(check('feat/new-panel', ['src/renderer/src/App.tsx', 'e2e/README.md']).ok).toBe(false)
  })

  it('사유가 있는 E2E-Skip trailer 는 통과시키고 사유를 돌려준다', () => {
    const verdict = check(
      'fix/panel-spacing',
      ['src/renderer/src/App.tsx'],
      ['fix: align panel\n\nE2E-Skip: visual-only CSS alignment']
    )
    expect(verdict).toMatchObject({
      ok: true,
      reason: 'skip-trailer',
      skipReason: 'visual-only CSS alignment'
    })
  })

  it('사유가 비어 있는 E2E-Skip trailer 는 통과시키지 않는다', () => {
    expect(
      check('fix/panel-spacing', ['src/renderer/src/App.tsx'], ['fix: align panel\n\nE2E-Skip:   '])
        .ok
    ).toBe(false)
  })

  it('사용자 표면 밖의 파일만 바꾸면 통과한다', () => {
    expect(check('feat/build-helper', ['scripts/build-demo.mjs']).ok).toBe(true)
  })

  it('renderer unit test 만 바꾸면 통과한다', () => {
    expect(check('feat/renderer-test', ['src/renderer/src/App.test.tsx']).ok).toBe(true)
  })
})
