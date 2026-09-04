/**
 * 경로만 보고 "이 파일은 사람이 쓴 코드인가" 를 가른다.
 *
 * 브랜치 총합 `+8,259` 는 그 자체로는 아무 말도 하지 않는다. 그 안에 재생성된 lock 파일
 * 3천 줄이 섞여 있으면 "에이전트가 얼마나 썼나" 라는 질문의 답으로는 틀린 숫자다 — 그건
 * 작성된 코드가 아니라 churn 이다. 테스트도 같은 이유로 갈라 둔다: 섞으면 안 되지만 숨기면
 * 더 안 되는, 따로 보고 싶은 몫이다.
 *
 * main 과 renderer 가 **같은 판정**을 써야 해서 shared 에 둔다. 브랜치 합계를 두 화면이
 * 다르게 세면 그것부터 버그다(`diff.ts` 가 여기 있는 것과 같은 이유).
 *
 * 판정은 일부러 보수적이다 — 잘못 걸러 내면 실제로 한 일을 **적게** 말하게 되고, 그쪽이
 * 더 나쁜 오류다. 그래서 생태계를 가리지 않고 명백한 이름만 싣는다.
 */

/** git 은 `/` 로 보고하지만 호출자가 그렇지 않을 수 있어 양쪽 구분자를 받는다. */
const SEP = '[/\\\\]'
const SEGMENT = `(?:^|${SEP})`

// ── 생성 코드 ────────────────────────────────────────────────────────────

/**
 * 통째로 다시 쓰이는 의존성 잠금 파일. 한 줄도 손으로 쓰지 않는다.
 * `build`/`out`/`target`/`bin` 은 일부러 뺐다 — 손으로 쓴 소스 디렉터리 이름으로도 흔하다.
 */
const LOCK_FILE = new RegExp(
  `${SEGMENT}(?:${[
    'package-lock\\.json',
    'npm-shrinkwrap\\.json',
    'yarn\\.lock',
    'pnpm-lock\\.yaml',
    'bun\\.lockb?',
    'packages\\.lock\\.json',
    'cargo\\.lock',
    'poetry\\.lock',
    'pipfile\\.lock',
    'uv\\.lock',
    'composer\\.lock',
    'gemfile\\.lock',
    'go\\.sum',
    'mix\\.lock',
    'pubspec\\.lock',
    'flake\\.lock',
    'gradle\\.lockfile'
  ].join('|')})$`,
  'i'
)

/** 도구가 자기 산출물을 쏟아 놓는 디렉터리. 경로 **구간** 전체가 맞아야 한다. */
const GENERATED_DIRECTORY = new RegExp(
  `${SEGMENT}(?:__generated__|__pycache__|node_modules|vendor|coverage|dist|generated|\\.next|\\.nuxt)${SEP}`,
  'i'
)

/** 도구가 파일 이름에 찍는 표식. */
const GENERATED_BASENAME = new RegExp(
  `(?:${[
    '\\.(?:generated|designer)\\.[^./\\\\]+', // Foo.generated.ts, Form.Designer.cs
    '[._]gen\\.[^./\\\\]+', // schema.gen.ts, mock_gen.go
    '_generated\\.[^./\\\\]+', // bindings_generated.go
    // protobuf 플러그인은 뒤에 조각을 더 붙인다 — service.pb.go, service.pb.gw.go, api_pb2.py.
    '[._](?:pb|pb2|pb2_grpc)\\.(?:[^./\\\\]+\\.)*[^./\\\\]+',
    '\\.(?:g|freezed)\\.dart', // model.g.dart
    '\\.min\\.(?:js|mjs|css)',
    '\\.(?:js|mjs|css)\\.map', // 소스맵
    '\\.snap' // vitest/jest 스냅샷 — `-u` 한 번이면 통째로 다시 쓰인다
  ].join('|')})$`,
  'i'
)

/** 도구가 만들어 낸 파일인가. */
export function isGeneratedCodePath(path: string): boolean {
  return GENERATED_BASENAME.test(path) || LOCK_FILE.test(path) || GENERATED_DIRECTORY.test(path)
}

// ── 테스트 코드 ──────────────────────────────────────────────────────────

/**
 * 테스트가 사는 디렉터리. 구간 전체로만 맞춰, `src/latest/`·`contest/` 가 걸리지 않게 한다.
 * 뒤의 구분자가 **파일** `test.ts` 를 여기서 빼 주는 장치다.
 * `specs/` 는 뺐다 — 명세 문서를 담는 쪽이 더 흔하고, 그 안의 진짜 테스트는 파일 이름으로 걸린다.
 */
const TEST_DIRECTORY = new RegExp(
  `${SEGMENT}(?:__tests__|__mocks__|__snapshots__|tests?|spec|e2e|cypress|testdata)${SEP}`,
  'i'
)

/** 생태계별 테스트 파일 이름 규칙. */
const TEST_BASENAME = new RegExp(
  `(?:${[
    '\\.(?:test|spec)\\.[^./\\\\]+', // DiffView.render.test.tsx, git.spec.js
    '[-_](?:test|spec)s?\\.[^./\\\\]+', // handler_test.go, user_spec.rb
    // `test_` 접두사는 pytest 규약이라 `.py` 로만 좁힌다. 확장자를 열면 test_data.json,
    // test_page.tsx 같은 픽스처·화면까지 쓸려 들어온다.
    `${SEGMENT}test_[^./\\\\]*\\.py`,
    `${SEGMENT}conftest\\.py`
  ].join('|')})$`,
  'i'
)

/**
 * JVM·C#·Swift·PHP·Ruby 의 테스트 타입 이름. **대소문자를 가린다** — 소문자까지 받으면
 * Contest.java, Latest.kt 같은 평범한 타입 이름이 테스트로 둔갑한다.
 */
const TEST_TYPE_SUFFIX = /(?:Test|Tests|Spec)\.(?:java|kt|kts|scala|groovy|cs|swift|php|rb)$/

/** 테스트 코드인가. */
export function isTestCodePath(path: string): boolean {
  return TEST_DIRECTORY.test(path) || TEST_BASENAME.test(path) || TEST_TYPE_SUFFIX.test(path)
}

// ── 브랜치 합계 ──────────────────────────────────────────────────────────

/** 한 몫의 +/−. */
export interface LineCount {
  added: number
  removed: number
}

/** 브랜치 전체의 +/− 와, 거기서 갈라낸 몫들. `test`/`generated` 는 `added`/`removed` 에 **포함**된다. */
export interface BranchLineTotal extends LineCount {
  test: LineCount
  generated: LineCount
}

/** 합계를 내는 데 필요한 것만. FileDiff 를 그대로 받아도 되고, numstat 한 줄을 받아도 된다. */
export interface CountedFile {
  path: string
  additions: number
  deletions: number
}

/**
 * 파일별 +/− 를 브랜치 합계로 접는다.
 *
 * 겹치면(스냅샷은 테스트이기도 하고 생성물이기도 하다) **생성 쪽이 이긴다** — 이 갈래의
 * 목적이 "작성된 코드" 와 "churn" 을 나누는 것이고, 다시 만들어진 파일은 어디에 있든 churn 이다.
 */
export function branchLineTotal(files: readonly CountedFile[]): BranchLineTotal {
  const total: BranchLineTotal = {
    added: 0,
    removed: 0,
    test: { added: 0, removed: 0 },
    generated: { added: 0, removed: 0 }
  }
  for (const file of files) {
    total.added += file.additions
    total.removed += file.deletions
    const bucket = isGeneratedCodePath(file.path)
      ? total.generated
      : isTestCodePath(file.path)
        ? total.test
        : null
    if (bucket) {
      bucket.added += file.additions
      bucket.removed += file.deletions
    }
  }
  return total
}

/** 갈래를 뺀 나머지 — 사람이 직접 쓴 몫. */
export function authoredLines(total: BranchLineTotal): LineCount {
  return {
    added: total.added - total.test.added - total.generated.added,
    removed: total.removed - total.test.removed - total.generated.removed
  }
}
