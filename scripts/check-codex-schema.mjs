#!/usr/bin/env node
/**
 * codex app-server 프로토콜 스키마가 우리가 마지막으로 확인한 판본에서 움직였는지 검사한다.
 *
 * app-server 프로토콜에는 버전 헤더도, 호환 계층도 없다. 알림에 필드가 하나 늘거나 새 알림이
 * 생겨도 클라이언트가 알 방법이 없다 — 서버는 그냥 우리가 모르는 JSON 을 보내고, 우리는 그걸
 * 조용히 흘린다. 게다가 codex 는 사용자가 각자 설치한 CLI 라 우리가 버전을 고정할 수도 없다.
 *
 * Wooi 는 이 문제를 이미 두 군데서 막고 있고, 이 스크립트는 세 번째 다리다.
 *
 *   1. 런타임 — src/main/codex/jsonrpc.ts 의 tryRequest() 가 JSON-RPC -32601 을 잡아
 *      "이 서버엔 그 메서드가 없다"를 학습한다. 우리가 부르는 것에 대해서만 작동한다.
 *   2. 대화 — 해석하지 못한 입력은 unknown 카드로 사용자에게 보인다. 사용자가 실제로 그
 *      기능을 써서 그 알림이 도착해야만 걸린다.
 *   3. (이 스크립트) 릴리스 시점 — 아무도 그 기능을 쓰지 않아도, 스키마가 달라졌다는 사실
 *      자체를 잡는다. 1·2 는 "우리가 이미 아는 표면"만 훑지만, 이건 우리가 모르는 표면까지 본다.
 *
 * 비교 방식은 docs/comparison-sources.json 과 같다 — 사람이 확인한 판본을 저장소에 박아 두고,
 * 지금의 세계와 대조한다. 다른 점은 상대가 GitHub 커밋이 아니라 설치된 codex 가 직접 뱉는
 * 기계 판독 스키마라는 것뿐이다(OpenAI 가 프로토콜 변경을 따라잡는 권장 방법으로 안내한다).
 *
 * 파일 바이트가 아니라 **파싱한 JSON 을 정규화해서** 비교한다. 커밋된 스냅샷은 prettier 나
 * 에디터가 건드릴 수 있고, 들여쓰기가 바뀐 걸 프로토콜 변경이라고 보고하면 아무도 안 본다.
 *
 * codex 가 없거나 generate-json-schema 를 모르는 버전이면 **실패가 아니라 "판정 불가"** 로
 * 끊는다(종료 코드 0). 설치 안 된 도구 때문에 빨간불이 뜨면 그 빨간불은 곧 무시된다.
 *
 * 인증은 필요 없다 — generate-json-schema 는 바이너리에 컴파일된 타입을 덤프할 뿐이라
 * 로그인하지 않은 환경(빈 CODEX_HOME)에서도 돈다. 그래서 CI 스케줄에 걸 수 있다.
 *
 * 사용법:
 *   node scripts/check-codex-schema.mjs             # 사람이 읽는 출력
 *   node scripts/check-codex-schema.mjs --markdown  # 이슈 본문용
 *   node scripts/check-codex-schema.mjs --update    # 스냅샷을 지금 설치된 codex 기준으로 갱신
 *
 * 종료 코드: 손댈 게 없거나 판정 불가면 0, 스키마가 움직였으면 1.
 * CODEX_BIN 으로 codex 실행 파일 경로를 지정할 수 있다(기본값 PATH 의 `codex`).
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SNAPSHOT_DIR = join(ROOT, 'docs/codex-protocol')
const MANIFEST = join(SNAPSHOT_DIR, 'snapshot.json')

const markdown = process.argv.includes('--markdown')
const update = process.argv.includes('--update')
const CODEX = process.env.CODEX_BIN || 'codex'

/** 키 순서에 흔들리지 않는 표현. serde 는 순서를 지키지만, 우리가 거기 기대고 있을 이유는 없다. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])])
    )
  }
  return value
}

const digest = (value) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')

/** 판정 불가로 끊는다. 이유를 남기되 빨간불은 켜지 않는다. */
function inconclusive(reason) {
  console.log(
    markdown ? `스키마를 확인하지 못했습니다 — ${reason}` : `- 판정 불가 (skipped) — ${reason}`
  )
  process.exit(0)
}

const snapshot = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const committed = new Map(
  snapshot.files.map((entry) => {
    const path = join(SNAPSHOT_DIR, entry.path)
    return [entry.path, existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null]
  })
)

// ── 0. 스냅샷이 제 기록과 맞는지 ────────────────────────────────────────────
// 커밋된 스키마 파일과 snapshot.json 의 sha256 은 같은 사실을 두 번 적은 것이다. 갈라졌다면
// 누가 손으로 고쳤다는 뜻이고, 그러면 아래 대조는 "무엇에 대한" 비교인지 알 수 없어진다.
// codex 없이도 판정되므로 먼저 본다 — 이건 저장소 안의 모순이지 바깥세상의 변화가 아니다.
if (!update) {
  const broken = snapshot.files.filter((entry) => {
    const parsed = committed.get(entry.path)
    return parsed === null || digest(parsed) !== entry.sha256
  })
  if (broken.length > 0) {
    console.log(
      [
        markdown
          ? '커밋된 스키마 스냅샷이 `docs/codex-protocol/snapshot.json` 의 기록과 어긋납니다. ' +
            '누군가 손으로 고쳤거나 갱신이 중간에 끊긴 상태입니다.'
          : '스냅샷이 제 기록과 어긋난다 (손으로 고쳤거나 갱신이 덜 끝났다):',
        '',
        ...broken.map(
          (e) =>
            `- **\`${e.path}\`** — ${committed.get(e.path) === null ? '파일이 없다' : 'sha256 불일치'}`
        ),
        '',
        '복구: node scripts/check-codex-schema.mjs --update'
      ].join('\n')
    )
    process.exit(1)
  }
}

// ── 설치된 codex 로 스키마를 다시 뽑는다 ────────────────────────────────────
const versionRun = spawnSync(CODEX, ['--version'], { encoding: 'utf8' })
if (versionRun.error || versionRun.status !== 0) {
  inconclusive(
    `\`${CODEX}\` is not runnable here. ` +
      'Install the Codex CLI (`npm i -g @openai/codex`) or set CODEX_BIN to its path.'
  )
}
const installedVersion = (versionRun.stdout || '').trim()

const out = mkdtempSync(join(tmpdir(), 'wooi-codex-schema-'))
let fresh
let unexpected
try {
  const run = spawnSync(CODEX, ['app-server', 'generate-json-schema', '--out', out], {
    encoding: 'utf8'
  })
  if (run.status !== 0) {
    // 이 서브커맨드는 experimental 이라 오래된 codex 에는 아예 없다. 그건 우리 잘못이 아니다.
    const detail = (run.stderr || run.stdout || '').trim().split('\n').slice(-1)[0] || 'no output'
    inconclusive(
      `\`${installedVersion}\` does not support \`app-server generate-json-schema\` (${detail}).`
    )
  }

  if (update) {
    // 스냅샷 갱신은 사람이 "확인했다"고 선언하는 행위다 — 스크립트는 옮겨 담기만 한다.
    const files = snapshot.files.map((entry) => {
      const parsed = JSON.parse(readFileSync(join(out, entry.path), 'utf8'))
      writeFileSync(join(SNAPSHOT_DIR, entry.path), readFileSync(join(out, entry.path)))
      return {
        ...entry,
        sha256: digest(parsed),
        definitions: Object.keys(parsed.definitions ?? {}).length
      }
    })
    const capturedOn = new Intl.DateTimeFormat('en-CA', {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date())
    writeFileSync(
      MANIFEST,
      JSON.stringify({ ...snapshot, codexVersion: installedVersion, capturedOn, files }, null, 2) +
        '\n'
    )
    console.log(
      `Snapshot updated from ${installedVersion} (${capturedOn}). ` +
        'Review the diff before committing — it is the record of what a human actually looked at.'
    )
    process.exit(0)
  }

  fresh = snapshot.files.map((entry) => {
    const path = join(out, entry.path)
    return {
      entry,
      parsed: existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
    }
  })

  // 프로토콜이 통째로 재편되면(예: v3 번들 등장) 추적 목록이 조용히 뒤처진다. 우리가 안 보는
  // 파일이 새로 생겼는지도 같이 본다 — 이게 가장 큰 변화인데 파일 단위 비교로는 안 잡힌다.
  unexpected = readdirSync(out)
    .filter((f) => f.endsWith('.schemas.json'))
    .filter((f) => !snapshot.files.some((e) => e.path === f))
} finally {
  rmSync(out, { recursive: true, force: true })
}

// ── 대조 ────────────────────────────────────────────────────────────────────
const findings = []

for (const { entry, parsed } of fresh) {
  if (!parsed) {
    findings.push(
      `**\`${entry.path}\` 가 사라졌다** — ${installedVersion} 는 이 번들을 더 이상 내보내지 않는다. ` +
        '프로토콜 표면이 재편됐다는 뜻이니 추적 목록부터 다시 짜야 한다.'
    )
    continue
  }
  if (digest(parsed) === entry.sha256) continue

  // 어느 타입이 움직였는지까지 말해 준다. 500KB 짜리 JSON 을 "달라졌다"로만 알려 주면
  // 받는 사람이 할 수 있는 일이 없다.
  const before = committed.get(entry.path).definitions ?? {}
  const after = parsed.definitions ?? {}
  const added = Object.keys(after).filter((k) => !(k in before))
  const removed = Object.keys(before).filter((k) => !(k in after))
  const changed = Object.keys(after).filter(
    (k) => k in before && digest(after[k]) !== digest(before[k])
  )

  const lines = [
    `**\`${entry.path}\`** — 추가 ${added.length}건 · 삭제 ${removed.length}건 · 변경 ${changed.length}건`
  ]
  const list = (label, names) => {
    if (names.length === 0) return
    const shown = names.slice(0, 20)
    const more = names.length - shown.length
    lines.push(
      `  - ${label}: ${shown.map((n) => `\`${n}\``).join(', ')}${more > 0 ? ` 외 ${more}건` : ''}`
    )
  }
  list('추가', added)
  list('삭제', removed)
  list('변경', changed)
  findings.push(lines.join('\n'))
}

if (unexpected.length > 0) {
  findings.push(
    `**추적하지 않는 번들 ${unexpected.length}건** — ${unexpected.map((f) => `\`${f}\``).join(', ')}. ` +
      'codex 가 우리가 모르는 스키마 번들을 내보내기 시작했다. 새 프로토콜 표면일 수 있다.'
  )
}

// ── 출력 ────────────────────────────────────────────────────────────────────
const versionNote =
  installedVersion === snapshot.codexVersion
    ? `codex ${installedVersion}`
    : `codex ${installedVersion} (snapshot: ${snapshot.codexVersion})`

if (findings.length === 0) {
  console.log(
    markdown
      ? `codex app-server 프로토콜은 스냅샷과 같습니다 — ${versionNote}, 확인일 ${snapshot.capturedOn}.`
      : `✓ 손댈 것 없음 — ${versionNote}, 스냅샷(${snapshot.capturedOn})과 동일.`
  )
  process.exit(0)
}

console.log(
  [
    markdown
      ? `codex app-server 프로토콜 스키마가 커밋된 스냅샷에서 움직였습니다. ` +
        `스냅샷은 codex \`${snapshot.codexVersion}\` 기준(${snapshot.capturedOn}), ` +
        `확인에 쓴 것은 \`${installedVersion}\` 입니다.`
      : `스키마가 스냅샷에서 움직였다 (${versionNote}, 스냅샷 ${snapshot.capturedOn}):`,
    '',
    ...findings.map((f) => `- ${f}`),
    '',
    markdown
      ? '변경된 타입이 `src/main/codex/wire.ts` 가 손으로 선언한 표면과 겹치는지 확인하고, ' +
        '겹치지 않더라도 우리가 놓치고 있는 기능인지 한 번 본다. ' +
        '확인을 마쳤으면 `node scripts/check-codex-schema.mjs --update` 로 스냅샷을 갱신한다.'
      : '확인 후 갱신: node scripts/check-codex-schema.mjs --update'
  ].join('\n')
)
process.exit(1)
