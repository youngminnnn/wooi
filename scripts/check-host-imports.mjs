#!/usr/bin/env node
// 유틸리티 프로세스 진입점(agent-host · codex-host · toolShim)이 `electron` 모듈에 닿는지 검증한다.
//
// 왜 필요한가: 이 진입점들은 Electron 의 utilityProcess 로 뜨거나(host) codex app-server 가
// 직접 spawn 하는(toolShim) 순수 Node 프로세스라 `electron` 모듈이 없다. 그래서
// `import { app } from 'electron'` 은 **모듈 로드 시점에 throw** 한다 —
// `Named export 'app' not found. The requested module 'electron' is a CommonJS module...`.
// 호스트는 첫 로그 한 줄도 남기지 못하고 exit 1 로 죽고, 겉으로는 "Agent host crashed" 로만
// 보여서 원인을 찾기가 아주 어렵다. 실제로 이 회귀가 한 번 릴리즈에 실렸다(#262 → #280).
//
// 함정은 import 한 줄이 아니라 **전이 그래프**에 있다: 호스트가 직접 electron 을 부르는 일은
// 없고, 메인 전용 모듈(store 등)을 딸려 들어오게 하는 import 하나가 문제다. 그래서 진입점에서
// 시작해 우리 소스만 전이적으로 훑는다.
//
// 타입 전용 import(`import type ...`)는 번들에서 지워지므로 그래프 간선으로 세지 않는다.
// node_modules 는 따라가지 않는다 — 우리가 통제하는 것은 우리 소스의 그래프뿐이다.
//
// 사용법:
//   node scripts/check-host-imports.mjs             기본 진입점들을 검사한다 (CI · husky)
//   node scripts/check-host-imports.mjs <file...>   진입점을 직접 지정한다 (테스트)
//
//   통과: exit 0 / 위반: exit 1 / 진입점 없음: exit 2
//
// 원인을 고치는 방법은 대개 하나다: 메인 전용 상태(store·app 경로)를 호스트가 읽으려 들지 말고,
// 메인이 계산해 프로토콜 메시지(SessionConfig 등)로 실어 보낸다.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SRC = join(ROOT, 'src')

/** electron.vite.config.ts 의 main.build.rollupOptions.input 중 유틸리티 프로세스인 것들. */
const DEFAULT_ENTRIES = [
  'src/main/claude/host.ts',
  'src/main/codex/host.ts',
  'src/main/codex/toolShim.ts'
]

// 인자로 넘긴 진입점이 있으면 그것만 본다 — 검출 자체가 동작하는지 테스트가 확인할 통로다.
const ENTRIES = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_ENTRIES

const BANNED = 'electron'

/** import 지정자를 우리 소스 파일 경로로 옮긴다. 외부 패키지면 null(따라가지 않는다). */
function resolveSpecifier(spec, importer) {
  let base
  if (spec.startsWith('@shared/')) base = join(SRC, 'shared', spec.slice('@shared/'.length))
  else if (spec.startsWith('.')) base = join(dirname(importer), spec)
  else return null

  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), base]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

/**
 * 런타임까지 남는 import 지정자만 모은다.
 *
 * 타입 전용(`import type` · `export type` · 모든 specifier 가 `type` 인 경우)은 번들에서
 * 사라지므로 제외한다. side-effect import(`import './x'`)와 동적 import 는 포함한다.
 */
function valueImports(file) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ESNext,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const specs = []

  const add = (node) => {
    if (node && ts.isStringLiteral(node)) specs.push(node.text)
  }

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause
      // `import './x'` — 부작용만 취하는 import 도 모듈을 평가시키므로 간선이다.
      if (!clause) {
        add(statement.moduleSpecifier)
        continue
      }
      if (clause.isTypeOnly) continue
      const named = clause.namedBindings
      const allTypeOnly =
        !clause.name &&
        named !== undefined &&
        ts.isNamedImports(named) &&
        named.elements.every((el) => el.isTypeOnly)
      if (allTypeOnly) continue
      add(statement.moduleSpecifier)
      continue
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      if (statement.isTypeOnly) continue
      const clause = statement.exportClause
      if (clause && ts.isNamedExports(clause) && clause.elements.every((el) => el.isTypeOnly)) {
        continue
      }
      add(statement.moduleSpecifier)
    }
  }

  // 동적 import — 정적 문법과 달리 어디에나 있을 수 있으므로 트리 전체를 훑는다.
  const walk = (node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add(node.arguments[0])
    }
    ts.forEachChild(node, walk)
  }
  walk(source)

  return specs
}

/** 진입점에서 위반 모듈까지의 import 사슬을 사람이 읽을 형태로 되짚는다. */
function chainTo(file, parents) {
  const chain = []
  for (let at = file; at; at = parents.get(at)) chain.unshift(relative(ROOT, at))
  return chain
}

const violations = []

for (const entry of ENTRIES) {
  const entryPath = resolve(ROOT, entry)
  if (!existsSync(entryPath)) {
    console.error(`check-host-imports: entry not found: ${entry}`)
    process.exit(2)
  }

  const parents = new Map([[entryPath, null]])
  const queue = [entryPath]
  while (queue.length) {
    const file = queue.shift()
    for (const spec of valueImports(file)) {
      if (spec === BANNED) {
        violations.push({ entry, chain: chainTo(file, parents) })
        continue
      }
      const next = resolveSpecifier(spec, file)
      if (!next || parents.has(next)) continue
      parents.set(next, file)
      queue.push(next)
    }
  }
}

if (violations.length) {
  console.error(
    `check-host-imports: ${violations.length} import chain(s) from a utility-process entry reach \`${BANNED}\`.\n` +
      `The utility process has no Electron APIs — a value import of '${BANNED}' throws at module load\n` +
      `and the process dies before it can log anything.\n`
  )
  for (const { chain } of violations) {
    console.error(`  ${chain.join('\n    → ')}\n    → '${BANNED}'  ✗\n`)
  }
  console.error(
    `Fix by keeping main-only state out of the host graph: compute it in the main process and\n` +
      `send the result over the host protocol (see SessionConfig in src/main/claude/protocol.ts).`
  )
  process.exit(1)
}

console.log(
  `check-host-imports: ${ENTRIES.length} utility-process entries stay clear of \`${BANNED}\`.`
)
