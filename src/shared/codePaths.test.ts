import { describe, expect, it } from 'vitest'
import { authoredLines, branchLineTotal, isGeneratedCodePath, isTestCodePath } from './codePaths'

describe('isGeneratedCodePath', () => {
  it.each([
    'package-lock.json',
    'apps/mobile/package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'bun.lockb',
    'Cargo.lock',
    'Gemfile.lock',
    'go.sum',
    'flake.lock',
    'src/__generated__/schema.ts',
    'node_modules/react/index.js',
    'dist/bundle.js',
    'vendor/github.com/pkg/errors.go',
    'coverage/lcov-report/index.html',
    'web/.next/static/chunk.js',
    'api/service.pb.go',
    'api/service.pb.gw.go',
    'api/service_pb2.py',
    'src/schema.gen.ts',
    'src/bindings_generated.go',
    'lib/model.g.dart',
    'lib/model.freezed.dart',
    'Form.Designer.cs',
    'public/app.min.js',
    'public/app.js.map',
    'src/__snapshots__/View.test.tsx.snap'
  ])('%s 는 생성 코드다', (path) => {
    expect(isGeneratedCodePath(path)).toBe(true)
  })

  // 잘못 걸러 내면 실제로 한 일을 적게 말하게 된다 — 이쪽 오류가 더 나쁘다.
  it.each([
    'src/main/git.ts',
    'src/shared/codePaths.ts',
    // 손으로 쓴 소스 디렉터리 이름으로 흔한 것들.
    'build/notarize.js',
    'out/index.ts',
    'src/target/main.rs',
    'cmd/bin/serve.go',
    // 디렉터리가 아니라 파일 이름이 dist/generated 인 경우.
    'src/dist.ts',
    'src/generated.ts',
    // lock 이 붙었지만 잠금 파일이 아닌 것.
    'src/lib/lock.ts',
    'src/useLock.ts',
    // .map 확장자지만 소스맵이 아닌 것.
    'assets/world.map'
  ])('%s 는 생성 코드가 아니다', (path) => {
    expect(isGeneratedCodePath(path)).toBe(false)
  })

  it('윈도 구분자도 받는다', () => {
    expect(isGeneratedCodePath('src\\__generated__\\schema.ts')).toBe(true)
  })
})

describe('isTestCodePath', () => {
  it.each([
    'src/shared/diff.test.ts',
    'src/renderer/src/components/DiffView.render.test.tsx',
    'src/shared/git.spec.js',
    'internal/handler_test.go',
    'spec/models/user_spec.rb',
    'src/__tests__/view.ts',
    'src/__mocks__/fs.ts',
    'e2e/run.mjs',
    'cypress/e2e/login.cy.ts',
    'testdata/fixture.json',
    'tests/conftest.py',
    'api/test_client.py',
    'src/renderer/src/test/harness.tsx',
    'app/src/test/java/com/example/UserTest.java',
    'Api/OrderSpec.cs'
  ])('%s 는 테스트 코드다', (path) => {
    expect(isTestCodePath(path)).toBe(true)
  })

  it.each([
    'src/main/git.ts',
    // 구간이 아니라 이름의 일부일 뿐이다.
    'src/latest/index.ts',
    'src/contest/entry.ts',
    // 소문자 접미사까지 받으면 평범한 타입 이름이 테스트로 둔갑한다.
    'app/Contest.java',
    'app/Latest.kt',
    // `specs/` 는 명세 문서를 담는 쪽이 더 흔하다.
    'docs/specs/protocol.md',
    // pytest 접두사는 .py 로만 좁혔다.
    'fixtures/test_data.json',
    'src/pages/test_page.tsx'
  ])('%s 는 테스트 코드가 아니다', (path) => {
    expect(isTestCodePath(path)).toBe(false)
  })
})

describe('branchLineTotal', () => {
  it('전체 합계와 갈래를 함께 낸다', () => {
    const total = branchLineTotal([
      { path: 'src/main/git.ts', additions: 100, deletions: 10 },
      { path: 'src/main/git.test.ts', additions: 50, deletions: 5 },
      { path: 'package-lock.json', additions: 3000, deletions: 2000 }
    ])
    expect(total).toEqual({
      added: 3150,
      removed: 2015,
      test: { added: 50, removed: 5 },
      generated: { added: 3000, removed: 2000 }
    })
    // 갈래는 전체에 포함된 몫이므로, 빼면 사람이 쓴 코드만 남는다.
    expect(authoredLines(total)).toEqual({ added: 100, removed: 10 })
  })

  // 스냅샷은 테스트이기도 하고 생성물이기도 하다. 두 몫에 다 세면 나머지가 음수가 된다.
  it('겹치는 파일은 생성 쪽으로만 센다', () => {
    const total = branchLineTotal([
      { path: 'src/__snapshots__/View.test.tsx.snap', additions: 40, deletions: 4 }
    ])
    expect(total.generated).toEqual({ added: 40, removed: 4 })
    expect(total.test).toEqual({ added: 0, removed: 0 })
    expect(authoredLines(total)).toEqual({ added: 0, removed: 0 })
  })

  it('빈 목록은 0 이다', () => {
    expect(branchLineTotal([])).toEqual({
      added: 0,
      removed: 0,
      test: { added: 0, removed: 0 },
      generated: { added: 0, removed: 0 }
    })
  })
})
