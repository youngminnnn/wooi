#!/usr/bin/env node
// 브랜치 이름이 Conventional Commits 타입 prefix 규칙을 따르는지 검증한다.
// 로컬(.husky/pre-push)과 CI(ci.yml) 에서 같은 규칙을 공유하기 위한 단일 소스.
//
// 사용법: node scripts/check-branch-name.mjs <branch-name>
//   통과: exit 0 / 위반: exit 1 / 잘못된 호출: exit 2

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
// 없다), 의존성·보안 업데이트가 조용히 막힌다. 실제로 Dependabot PR 4건이 이 잡
// 하나 때문에 전부 빨간불이었다.
const EXEMPT_PREFIXES = ['dependabot/']

// 예) feat/inline-login, fix/first-message-stall, chore/deps/bump-electron
const PATTERN = new RegExp(`^(${TYPES.join('|')})\\/[A-Za-z0-9._/-]+$`)

const branch = (process.argv[2] ?? '').trim()

if (!branch) {
  console.error('check-branch-name: 브랜치 이름 인자가 필요합니다.')
  process.exit(2)
}

if (
  EXEMPT.has(branch) ||
  EXEMPT_PREFIXES.some((prefix) => branch.startsWith(prefix)) ||
  PATTERN.test(branch)
) {
  process.exit(0)
}

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

process.exit(1)
