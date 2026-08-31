// 브랜치 이름 규칙의 단일 소스. **값과 순수 함수만** 두고 부작용을 두지 않는다.
//
// 규칙을 읽는 곳이 CLI 하나가 아니게 됐기 때문이다 — 훅과 CI 는 check-branch-name.mjs 를
// 실행하고, 앱은 push 직전에 같은 규칙으로 브랜치 이름을 판정한다
// ([[src/main/branchNameFromWork.ts]]). 앱이 CLI 를 그대로 import 하면 stdin 을 읽는 코드와
// `import.meta.url` 로 진입점을 판정하는 코드까지 Electron 번들에 딸려 들어간다. 규칙만 떼어
// 두면 그 일이 문법적으로 일어나지 않고, 규칙은 여전히 한 곳에만 적혀 있다.

// 커밋 메시지 prefix 와 동일한 타입 집합.
export const TYPES = [
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
export const PATTERN = new RegExp(`^(${TYPES.join('|')})\\/[A-Za-z0-9._/-]+$`)

/** 이 브랜치 이름이 규칙을 통과하는가. */
export function isAllowedBranchName(branch) {
  return (
    EXEMPT.has(branch) ||
    EXEMPT_PREFIXES.some((prefix) => branch.startsWith(prefix)) ||
    PATTERN.test(branch)
  )
}
