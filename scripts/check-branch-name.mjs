#!/usr/bin/env node
// 브랜치 이름이 Conventional Commits 타입 prefix 규칙을 따르는지 검증한다.
// 로컬(.husky/pre-push)과 CI(ci.yml) 에서 같은 규칙을 공유하기 위한 단일 소스.
//
// 사용법:
//   node scripts/check-branch-name.mjs <branch-name>   이름 하나를 검증한다 (CI)
//   node scripts/check-branch-name.mjs --pre-push      git pre-push stdin 을 검증한다 (훅)
//
//   통과: exit 0 / 위반: exit 1 / 잘못된 호출: exit 2

import { readFileSync } from 'node:fs'

// 커밋 메시지 prefix 와 동일한 타입 집합.
const TYPES = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
  'release'
]

// 규칙에서 제외하는 보호/특수 브랜치.
const EXEMPT = new Set(['main', 'HEAD'])

// 봇이 브랜치 이름을 정하는 경로. 이름을 우리가 통제할 수 없으므로 규칙에서 제외한다.
// 제외하지 않으면 해당 PR 은 CI 를 **구조적으로 통과할 수 없고**(브랜치를 바꿀 방법이
// 없다), 의존성·보안 업데이트가 조용히 막힌다. 실제로 Dependabot PR 5건이 이 잡
// 하나 때문에 전부 빨간불이었다.
const EXEMPT_PREFIXES = ['dependabot/']

// 예) feat/inline-login, fix/first-message-stall, chore/deps/bump-electron
const PATTERN = new RegExp(`^(${TYPES.join('|')})\\/[A-Za-z0-9._/-]+$`)

// 삭제 push 는 local_sha 가 전부 0 으로 온다.
const ZERO_SHA = /^0+$/

const HEADS = 'refs/heads/'

function isAllowed(branch) {
  return (
    EXEMPT.has(branch) ||
    EXEMPT_PREFIXES.some((prefix) => branch.startsWith(prefix)) ||
    PATTERN.test(branch)
  )
}

function reportViolation(branch) {
  const suggestion = branch.replace(/^[^A-Za-z0-9]+/, '') || 'my-change'

  console.error(
    [
      '',
      `✖ 브랜치 이름 규칙 위반: "${branch}"`,
      '',
      '  브랜치 이름은 커밋 타입 prefix + "/" + 설명 형식이어야 합니다.',
      `  허용 타입: ${TYPES.join(', ')}`,
      '',
      '  예시:',
      '    feat/inline-github-login',
      '    fix/first-message-stall',
      '    docs/readme-demo-gif',
      '',
      '  현재 브랜치 이름을 바꾸려면:',
      `    git branch -m ${branch} feat/${suggestion}`,
      ''
    ].join('\n')
  )
}

// git 이 pre-push 훅 stdin 으로 주는 형식:
//   <local_ref> <local_sha> <remote_ref> <remote_sha>
//
// 검증 대상은 **원격 ref** 다. 규칙이 통제하려는 건 저장소에 실제로 만들어지는 브랜치
// 이름이고, `git push origin <local>:<remote>` 처럼 양쪽 이름이 다르면 로컬 이름은
// 규칙과 무관하기 때문이다. 로컬 이름을 보면 원격이 예외 대상(dependabot/…)인데도
// 로컬 임시 브랜치 이름 때문에 push 가 막힌다.
function checkPrePush() {
  let input
  try {
    input = readFileSync(0, 'utf8')
  } catch {
    console.error('check-branch-name: --pre-push 는 git 훅이 넘기는 stdin 이 필요합니다.')
    process.exit(2)
  }

  let ok = true

  for (const line of input.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 3) continue // 빈 줄 등

    const localSha = parts[1]
    const remoteRef = parts[2]

    if (!remoteRef.startsWith(HEADS)) continue // 태그 등 브랜치가 아닌 ref
    if (ZERO_SHA.test(localSha)) continue // 브랜치 삭제 push

    const branch = remoteRef.slice(HEADS.length)
    if (!isAllowed(branch)) {
      reportViolation(branch)
      ok = false
    }
  }

  process.exit(ok ? 0 : 1)
}

const arg = (process.argv[2] ?? '').trim()

if (arg === '--pre-push') {
  checkPrePush()
} else if (!arg) {
  console.error('check-branch-name: 브랜치 이름 인자가 필요합니다.')
  process.exit(2)
} else if (isAllowed(arg)) {
  process.exit(0)
} else {
  reportViolation(arg)
  process.exit(1)
}
