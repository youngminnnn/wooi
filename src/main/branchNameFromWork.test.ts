import { describe, expect, it } from 'vitest'
import { isAllowedBranchName } from '../../scripts/branch-name-rule.mjs'
import {
  branchNameFromWorkspaceName,
  isGeneratedBranchName,
  proposeBranchRename,
  slugifyBranchDescription
} from './branchNameFromWork'
import { generateWorkspaceName } from './names'

/** 판정이 실제로 켜지는 최소 조건. 개별 테스트는 여기서 한 축씩만 뒤집는다. */
function 제안입력(overrides: Partial<Parameters<typeof proposeBranchRename>[0]> = {}) {
  return {
    branch: 'savvy-numbat',
    workspaceName: 'Branch name from work',
    onOrigin: false,
    ...overrides
  }
}

describe('isGeneratedBranchName', () => {
  it('generateWorkspaceName 이 실제로 뱉는 이름을 전부 알아본다', () => {
    // 목록을 손으로 옮겨 적지 않는다 — 생성기를 돌려서 확인해야 단어가 늘어도 이 검사가 산다.
    for (let i = 0; i < 300; i++) {
      expect(isGeneratedBranchName(generateWorkspaceName(new Set()))).toBe(true)
    }
  })

  it('이름 충돌로 붙는 -N 접미사가 있어도 알아본다', () => {
    expect(isGeneratedBranchName('savvy-numbat-2')).toBe(true)
    expect(isGeneratedBranchName('fearless-echidna-17')).toBe(true)
  })

  it('workspace-N 폴백도 Wooi 가 지은 이름이다', () => {
    expect(isGeneratedBranchName('workspace-1')).toBe(true)
    expect(isGeneratedBranchName('workspace-42')).toBe(true)
  })

  it('사람이 지은 이름은 알아보지 않는다', () => {
    expect(isGeneratedBranchName('feat/inline-github-login')).toBe(false)
    expect(isGeneratedBranchName('my-branch')).toBe(false)
    expect(isGeneratedBranchName('savvy')).toBe(false)
    expect(isGeneratedBranchName('numbat')).toBe(false)
    // 형용사·동물 어느 한쪽만 맞는 것은 우연이다.
    expect(isGeneratedBranchName('savvy-thing')).toBe(false)
    expect(isGeneratedBranchName('quick-numbat')).toBe(false)
    // 순서가 뒤집힌 것도 생성기가 만들 수 없는 형태다.
    expect(isGeneratedBranchName('numbat-savvy')).toBe(false)
  })
})

describe('slugifyBranchDescription', () => {
  it('사람이 읽는 이름을 슬러그로 만든다', () => {
    expect(slugifyBranchDescription('Branch name from work')).toBe('branch-name-from-work')
    expect(slugifyBranchDescription('Fix: first message stall')).toBe('fix-first-message-stall')
  })

  it('git ref 로 불법인 문자를 남기지 않는다', () => {
    // 허용 목록 방식이므로 `..`, `@{`, `~`, `^`, `:`, `?`, 공백, 백슬래시가 모두 사라진다.
    const slug = slugifyBranchDescription('a..b @{c} d~e^f:g?h i\\j *k [l]')
    expect(slug).toBe('a-b-c-d-e-f-g-h-i-j-k-l')
    expect(slug).toMatch(/^[a-z0-9-]+$/)
  })

  it('셸 메타문자를 남기지 않는다', () => {
    expect(slugifyBranchDescription('rm -rf / ; echo $(whoami) `id` && :')).toBe(
      'rm-rf-echo-whoami-id'
    )
  })

  it('선행·후행 대시와 연속 대시를 정리한다', () => {
    expect(slugifyBranchDescription('  --hello---world--  ')).toBe('hello-world')
  })

  it('길이를 자르고 잘린 끝의 대시를 없앤다', () => {
    const slug = slugifyBranchDescription('word '.repeat(40))
    expect(slug.length).toBeLessThanOrEqual(60)
    expect(slug.endsWith('-')).toBe(false)
  })

  it('아스키로 접히지 않는 이름은 빈 문자열이 된다', () => {
    expect(slugifyBranchDescription('브랜치 이름 자동 변경')).toBe('')
    expect(slugifyBranchDescription(')(*&^%$#@!')).toBe('')
  })

  it('악센트는 아스키로 접는다', () => {
    expect(slugifyBranchDescription('café résumé')).toBe('cafe-resume')
  })
})

describe('branchNameFromWorkspaceName', () => {
  it('타입을 말하지 않는 이름에는 feat 를 붙인다', () => {
    expect(branchNameFromWorkspaceName('Branch name from work')).toBe('feat/branch-name-from-work')
  })

  it('이름이 스스로 말하는 커밋 타입을 따른다', () => {
    expect(branchNameFromWorkspaceName('Fix first message stall')).toBe('fix/first-message-stall')
    expect(branchNameFromWorkspaceName('docs: readme demo gif')).toBe('docs/readme-demo-gif')
    expect(branchNameFromWorkspaceName('feat(mobile): phone chat view')).toBe(
      'feat/mobile-phone-chat-view'
    )
  })

  it('타입만 있고 설명이 없으면 타입을 설명으로 쓴다', () => {
    expect(branchNameFromWorkspaceName('Refactor')).toBe('feat/refactor')
  })

  it('만들어 낸 이름은 항상 규칙을 통과한다', () => {
    for (const name of [
      'Branch name from work',
      'Fix first message stall',
      'chore: bump electron',
      '   spaced   out   name   ',
      'UPPERCASE NAME',
      'release v0.5.0'
    ]) {
      const branch = branchNameFromWorkspaceName(name)
      expect(branch).not.toBeNull()
      expect(isAllowedBranchName(branch!)).toBe(true)
    }
  })

  it('슬러그가 비면 이름을 만들지 않는다', () => {
    expect(branchNameFromWorkspaceName('브랜치 이름')).toBeNull()
    expect(branchNameFromWorkspaceName('   ')).toBeNull()
  })
})

describe('proposeBranchRename', () => {
  it('Wooi 가 지은 이름 + 워크스페이스 이름이 있으면 제안한다', () => {
    expect(proposeBranchRename(제안입력())).toEqual({
      from: 'savvy-numbat',
      to: 'feat/branch-name-from-work'
    })
  })

  it('이미 규칙에 맞는 이름은 건드리지 않는다', () => {
    expect(proposeBranchRename(제안입력({ branch: 'feat/already-named' }))).toBeNull()
    expect(proposeBranchRename(제안입력({ branch: 'main' }))).toBeNull()
    expect(proposeBranchRename(제안입력({ branch: 'dependabot/npm_and_yarn/x' }))).toBeNull()
  })

  it('사람이 지은 이름은 규칙에 어긋나도 건드리지 않는다', () => {
    expect(proposeBranchRename(제안입력({ branch: 'my-hand-typed-branch' }))).toBeNull()
  })

  it('이미 origin 에 push 된 브랜치는 건드리지 않는다', () => {
    // 로컬만 바꾸면 restack 의 force-push 가 다른 ref 를 겨눈다.
    expect(proposeBranchRename(제안입력({ onOrigin: true }))).toBeNull()
  })

  it('워크트리에 브랜치 스택이 있으면 건드리지 않는다', () => {
    expect(proposeBranchRename(제안입력({ hasBranchStack: true }))).toBeNull()
  })

  it('워크스페이스 이름이 없으면 아무것도 하지 않는다', () => {
    // 이름을 지으려고 새 모델 호출을 만들지 않는다 — 재료가 없으면 그냥 멈춘다.
    expect(proposeBranchRename(제안입력({ workspaceName: null }))).toBeNull()
    expect(proposeBranchRename(제안입력({ workspaceName: '' }))).toBeNull()
    expect(proposeBranchRename(제안입력({ workspaceName: '   ' }))).toBeNull()
  })

  it('워크스페이스 이름이 슬러그로 남지 않으면 아무것도 하지 않는다', () => {
    expect(proposeBranchRename(제안입력({ workspaceName: '브랜치 이름 자동 변경' }))).toBeNull()
  })

  it('제안한 이름은 항상 규칙을 통과한다', () => {
    const proposal = proposeBranchRename(제안입력({ workspaceName: 'Fix push name drift' }))
    expect(proposal).not.toBeNull()
    expect(isAllowedBranchName(proposal!.to)).toBe(true)
    expect(proposal!.to).toBe('fix/push-name-drift')
  })
})
