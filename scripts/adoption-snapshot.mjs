#!/usr/bin/env node
// 텔레메트리 없이 Wooi 의 사용 규모를 추정하기 위한 스냅샷 수집기.
//
// Wooi 는 자체 서버도 애널리틱스도 없다(PRIVACY.md). 그래서 "사용자가 몇 명인지"는
// 원리적으로 알 수 없고, GitHub 이 이미 집계해 주는 부수 신호로 **추정**만 한다.
// 이 스크립트는 그 신호를 모아 stdout 요약 + JSONL 한 줄로 남긴다.
//
// ─────────────────────────────────────────────────────────────────────────────
// 이 숫자를 어떻게 읽어야 하는가 (읽지 않으면 나중에 스스로를 속인다)
// ─────────────────────────────────────────────────────────────────────────────
//
// 1. latest-mac.yml download_count 는 **사용자 수가 아니라 업데이트 체크 횟수**다.
//    한 명이 하루에도 여러 번 찍는다. src/main/updater.ts 기준으로 앱은
//    2시간마다(CHECK_INTERVAL_MS) + 앱을 다시 볼 때/절전 복귀 때(최소 30분 스로틀)
//    확인한다. 즉 하루 종일 켜 둔 사용자 1명 = 하루 12회 이상.
//    → 절대값을 "설치 수"로 읽지 말 것. 스냅샷 사이의 **증가율**과 **추세**만 본다.
//    → 아주 거친 하한선이 필요하면 (증가량 ÷ 경과일수 ÷ 12) 정도가 "매일 앱을 켜는
//      사람 수"의 자릿수 감이다. 자릿수 감일 뿐 정확한 값이 아니다.
//    → 이 카운트는 항상 **그 시점의 최신 릴리스**에만 쌓인다. 옛 릴리스의 숫자는
//      그게 최신이던 기간의 화석이다. 릴리스를 새로 내면 카운터가 0부터 다시 시작하므로
//      릴리스 직후 스냅샷의 "증가량 급락"은 사용자 이탈이 아니다.
//
// 2. .dmg download_count = **신규 설치 유입**. 사람이 README/랜딩에서 직접 받는 경로다.
//    자동 업데이트는 dmg 를 받지 않으므로 여기엔 재설치·신규만 섞인다. 셋 중 가장
//    "사람 1명"에 가까운 신호지만, 한 사람이 여러 번 받거나 받고 안 쓸 수 있다.
//
// 3. -mac.zip download_count = **기존 설치의 자동 업데이트 다운로드**.
//    macOS 에서 electron-updater 는 dmg 가 아니라 zip 을 받아 교체한다.
//    즉 zip 증가량 ≈ 실제로 새 버전으로 넘어간 설치 수. 릴리스마다 리셋되므로
//    "그 릴리스를 받은 설치 수"로 읽으면 가장 정직하다. .blockmap 은 차분 업데이트용
//    부산물이라 세지 않는다.
//
// 4. traffic views/clones 는 저장소 방문·클론이지 앱 사용이 아니다. uniques 는
//    GitHub 이 하루 단위로 중복을 제거한 값이라 **기간 합계 ≠ 사람 수**이고,
//    14일 창의 uniques 총계도 날짜별 uniques 의 합이 아니다(같은 사람이 여러 날 오면
//    각 날에 1씩). clones 는 CI·봇이 크게 부풀린다 — 절대값보다 referrer 구성이 유용하다.
//
// 5. **GitHub 은 traffic 을 14일치만 보관한다.** 주기적으로 안 찍으면 영구 소실이다.
//    그래서 스냅샷에 날짜별 배열(traffic.daily)까지 통째로 남긴다. 나중에 여러 줄을
//    이어 붙이면 정확한 일별 시계열을 복원할 수 있다. 같은 날짜가 여러 줄에 나오면
//    **나중에 찍은 줄을 채택**한다(먼저 찍은 줄은 그날이 아직 안 끝난 부분 집계다).
//
// 6. 공통 함정: CDN 캐시·미러·스크레이퍼 때문에 download_count 는 과소·과대 양쪽으로
//    틀릴 수 있다. 어떤 숫자도 단독으로는 의미가 없다. 항상 추세로 본다.
//
// ─────────────────────────────────────────────────────────────────────────────
// 사용법
// ─────────────────────────────────────────────────────────────────────────────
//
//   npm run metrics                    수집 → 요약 출력 → metrics/adoption.jsonl 에 append
//   node scripts/adoption-snapshot.mjs --dry-run     파일에 쓰지 않고 요약만
//   node scripts/adoption-snapshot.mjs --out <path>  JSONL 경로 지정
//   node scripts/adoption-snapshot.mjs --repo o/r    대상 저장소 지정
//   node scripts/adoption-snapshot.mjs --strict      traffic 수집 실패 시 exit 1 (CI 용)
//
// 표준 라이브러리 + gh CLI 만 쓴다(새 의존성 금지). gh 가 없거나 인증되지 않았으면
// 즉시 끊는다. traffic API 는 저장소 push 권한(fine-grained 기준 Administration:read)을
// 요구하므로, Actions 의 기본 GITHUB_TOKEN 으로는 **읽을 수 없다**.
// 자세한 내용은 .github/workflows/metrics.yml 주석 참고.

import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const DEFAULT_OUT = 'metrics/adoption.jsonl'

// 릴리스 자산 이름은 버전마다 다르다(Wooi-arm64.dmg, Wooi-1.0.2-arm64.dmg,
// Ditto-0.9.0-arm64.dmg …). 그래서 이름 하드코딩 대신 확장자로 분류한다.
function classifyAsset(name) {
  if (name.endsWith('.blockmap')) return null // 차분 업데이트 부산물 — 세지 않는다
  if (/^latest.*\.yml$/.test(name)) return 'updateFeed'
  if (name.endsWith('.dmg')) return 'dmg'
  if (name.endsWith('.zip')) return 'zip'
  return null
}

function fail(message, hint) {
  console.error(`\n✖ ${message}\n`)
  if (hint) console.error(`${hint}\n`)
  process.exit(1)
}

function parseArgs(argv) {
  const opts = { out: DEFAULT_OUT, repo: '', dryRun: false, strict: false }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\nimport ')[0])
      process.exit(0)
    } else if (arg === '--dry-run') {
      opts.dryRun = true
    } else if (arg === '--strict') {
      opts.strict = true
    } else if (arg === '--out') {
      opts.out = argv[++i] ?? ''
      if (!opts.out) fail('--out 에 경로가 필요합니다.')
    } else if (arg === '--repo') {
      opts.repo = argv[++i] ?? ''
      if (!opts.repo) fail('--repo 에 <owner>/<repo> 가 필요합니다.')
    } else {
      fail(`알 수 없는 인자: ${arg}`, '  사용법은 --help 를 보세요.')
    }
  }

  return opts
}

// gh 호출 한 번. 실패하면 stderr 를 담은 에러를 던져 호출부가 분기하게 한다.
// maxBuffer 기본값(1MB)은 릴리스가 쌓이면 쉽게 넘겨 ENOBUFS 로 죽는다 — 넉넉히 잡는다.
function gh(args) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024
    })
  } catch (err) {
    const stderr = (err.stderr ?? '').toString().trim()
    const error = new Error(stderr || err.message)
    error.stderr = stderr
    error.exitCode = err.status
    throw error
  }
}

// --paginate + --jq 는 모든 페이지를 NDJSON 한 줄씩 흘려보낸다. 응답 전체(릴리스 본문
// 포함)를 메모리에 담지 않으려면 jq 로 필요한 필드만 잘라 받는 게 맞다.
function ghLines(path, jq) {
  return gh(['api', '--paginate', path, '--jq', jq])
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

// gh 가 설치·인증되어 있는지 먼저 확인한다. 여기서 끊어야 뒤의 실패가 뭔지 헷갈리지 않는다.
function preflight() {
  try {
    execFileSync('gh', ['--version'], { stdio: 'ignore' })
  } catch {
    fail(
      'gh CLI 를 찾을 수 없습니다.',
      '  설치: brew install gh   (또는 https://cli.github.com)\n' +
        '  이 스크립트는 새 의존성 없이 gh 만으로 GitHub API 를 호출합니다.'
    )
  }

  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' })
  } catch {
    fail(
      'gh 가 인증되어 있지 않습니다.',
      '  로그인: gh auth login\n' +
        '  CI 라면 GH_TOKEN 환경변수에 토큰을 넣으세요.\n' +
        '  traffic 수집에는 저장소 push 권한이 있는 토큰이 필요합니다(repo 스코프).'
    )
  }
}

function resolveRepo(explicit) {
  if (explicit) return explicit
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY

  try {
    return gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim()
  } catch {
    fail(
      '대상 저장소를 알아낼 수 없습니다.',
      '  저장소 디렉터리에서 실행하거나 --repo <owner>/<repo> 를 넘기세요.'
    )
  }
}

const RELEASE_JQ =
  '.[] | {tag: .tag_name, publishedAt: .published_at, prerelease: .prerelease, ' +
  'draft: .draft, assets: [.assets[] | {name: .name, dl: .download_count}]}'

function collectReleases(repo) {
  const releases = ghLines(`/repos/${repo}/releases?per_page=100`, RELEASE_JQ)

  const totals = { updateFeed: 0, dmg: 0, zip: 0 }

  const perRelease = releases.map((release) => {
    const counts = { updateFeed: 0, dmg: 0, zip: 0 }

    for (const asset of release.assets ?? []) {
      const kind = classifyAsset(asset.name)
      if (!kind) continue
      counts[kind] += asset.dl
      totals[kind] += asset.dl
    }

    return {
      tag: release.tag,
      publishedAt: release.publishedAt,
      prerelease: release.prerelease,
      draft: release.draft,
      updateFeed: counts.updateFeed,
      dmg: counts.dmg,
      zip: counts.zip
    }
  })

  return { releases: perRelease, totals }
}

// traffic 은 push 권한을 요구한다. 권한이 없으면 403 이 오는데, 여기서 죽지 않고
// null 을 돌려준다 — 릴리스·스타 같은 나머지 데이터까지 같이 잃으면 안 된다.
function collectTraffic(repo) {
  const warnings = []

  const get = (path, label) => {
    try {
      return JSON.parse(gh(['api', path]))
    } catch (err) {
      const denied = /403|not accessible|push access|Forbidden/i.test(err.stderr ?? '')
      warnings.push(
        denied
          ? `traffic ${label}: 권한 없음 (403). 저장소 push 권한이 있는 토큰이 필요합니다.`
          : `traffic ${label}: 수집 실패 — ${err.stderr || err.message}`
      )
      return null
    }
  }

  const views = get(`/repos/${repo}/traffic/views`, 'views')
  const clones = get(`/repos/${repo}/traffic/clones`, 'clones')
  const referrers = get(`/repos/${repo}/traffic/popular/referrers`, 'referrers')

  if (!views && !clones && !referrers) return { traffic: null, warnings }

  return {
    traffic: {
      // count/uniques 는 GitHub 이 주는 14일 창 총계다. uniques 는 날짜별 값의 합이 아니다.
      views: views ? { count: views.count, uniques: views.uniques } : null,
      clones: clones ? { count: clones.count, uniques: clones.uniques } : null,
      referrers: referrers ?? null,
      // 14일 뒤 사라지는 원본. 스냅샷을 이어 붙여 일별 시계열을 복원하는 용도다.
      daily: {
        views: views?.views ?? null,
        clones: clones?.clones ?? null
      }
    },
    warnings
  }
}

function collectRepoStats(repo) {
  const info = JSON.parse(gh(['api', `/repos/${repo}`]))
  return {
    stars: info.stargazers_count,
    forks: info.forks_count,
    watchers: info.subscribers_count,
    openIssues: info.open_issues_count
  }
}

// 이전 스냅샷을 읽어 증분을 보여준다. 절대값보다 증분이 훨씬 정보량이 많다.
function readPrevious(outPath) {
  let text
  try {
    text = readFileSync(outPath, 'utf8')
  } catch {
    return null
  }

  const lines = text.split('\n').filter((line) => line.trim())
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i])
    } catch {
      // 손상된 줄은 건너뛰고 그 이전 줄을 본다.
    }
  }
  return null
}

function delta(current, previous) {
  if (typeof previous !== 'number' || typeof current !== 'number') return ''
  const diff = current - previous
  if (diff === 0) return '  (±0)'
  return `  (${diff > 0 ? '+' : ''}${diff})`
}

function daysBetween(a, b) {
  const ms = new Date(a).getTime() - new Date(b).getTime()
  return ms / 86_400_000
}

function printSummary(snapshot, previous) {
  const p = previous ?? {}
  const line = (label, value, prev) =>
    `  ${label.padEnd(26)}${String(value).padStart(8)}${delta(value, prev)}`

  console.log(`\nWooi adoption snapshot — ${snapshot.repo}  @ ${snapshot.capturedAt}`)
  if (previous) {
    const gap = daysBetween(snapshot.capturedAt, previous.capturedAt)
    console.log(
      `직전 스냅샷: ${previous.capturedAt} (${gap.toFixed(1)}일 전) — 괄호는 그 사이 증분`
    )
  } else {
    console.log('직전 스냅샷 없음 — 이번이 기준점이다. 증분은 다음 실행부터 보인다.')
  }

  const latest = snapshot.releases.find((r) => !r.draft && !r.prerelease) ?? snapshot.releases[0]
  const prevLatest = p.releases?.find((r) => r.tag === latest?.tag)

  console.log('\n■ 저장소')
  console.log(line('stars', snapshot.stars, p.stars))
  console.log(line('forks', snapshot.forks, p.forks))
  console.log(line('watchers', snapshot.watchers, p.watchers))
  console.log(line('open issues', snapshot.openIssues, p.openIssues))

  if (latest) {
    console.log(`\n■ 최신 릴리스 ${latest.tag} — 여기가 살아 있는 신호다`)
    console.log(line('update checks (yml)', latest.updateFeed, prevLatest?.updateFeed))
    console.log(line('auto-update dl (zip)', latest.zip, prevLatest?.zip))
    console.log(line('new installs (dmg)', latest.dmg, prevLatest?.dmg))

    if (previous && prevLatest) {
      const gap = daysBetween(snapshot.capturedAt, previous.capturedAt)
      const grew = latest.updateFeed - prevLatest.updateFeed
      if (gap >= 0.5 && grew > 0) {
        // 앱은 2시간마다 + 포커스/절전복귀마다 확인한다 → 상시 사용자 1명당 하루 12회 이상.
        const rough = grew / gap / 12
        console.log(
          `\n  → 업데이트 체크 ${grew}회 / ${gap.toFixed(1)}일. 사용자 1명당 하루 12회 이상으로\n` +
            `    나누면 상시 사용자 ~${rough.toFixed(1)}명 규모. 자릿수 감일 뿐 정확한 값이 아니다.`
        )
      }
    }
  }

  console.log('\n■ 전체 릴리스 누적 (역사적 합계 — 최신 활동과 섞어 읽지 말 것)')
  console.log(line('update checks (yml)', snapshot.totals.updateFeed, p.totals?.updateFeed))
  console.log(line('auto-update dl (zip)', snapshot.totals.zip, p.totals?.zip))
  console.log(line('new installs (dmg)', snapshot.totals.dmg, p.totals?.dmg))

  console.log('\n■ traffic (GitHub 보관 14일)')
  if (!snapshot.traffic) {
    console.log('  수집하지 못했습니다 — 아래 경고를 보세요.')
  } else {
    const { views, clones, referrers } = snapshot.traffic
    console.log(
      line('views (14d)', views?.count ?? '—', p.traffic?.views?.count) +
        `   uniques ${views?.uniques ?? '—'}`
    )
    console.log(
      line('clones (14d)', clones?.count ?? '—', p.traffic?.clones?.count) +
        `   uniques ${clones?.uniques ?? '—'}`
    )

    if (referrers?.length) {
      console.log('\n  유입 경로 상위')
      for (const ref of referrers.slice(0, 10)) {
        console.log(
          `    ${ref.referrer.padEnd(30)}${String(ref.count).padStart(6)}   uniques ${ref.uniques}`
        )
      }
    } else if (referrers) {
      console.log('\n  유입 경로: 없음')
    }
  }

  if (snapshot.warnings.length) {
    console.log('\n⚠ 경고')
    for (const warning of snapshot.warnings) console.log(`  - ${warning}`)
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2))

  preflight()

  const repo = resolveRepo(opts.repo)
  const capturedAt = new Date().toISOString()

  const { releases, totals } = collectReleases(repo)
  const { traffic, warnings } = collectTraffic(repo)
  const stats = collectRepoStats(repo)

  // 키 순서를 고정해 JSONL diff 를 안정적으로 유지한다.
  const snapshot = {
    date: capturedAt.slice(0, 10),
    capturedAt,
    repo,
    stars: stats.stars,
    forks: stats.forks,
    watchers: stats.watchers,
    openIssues: stats.openIssues,
    totals,
    releases,
    traffic,
    warnings
  }

  const outPath = resolve(opts.out)
  const previous = readPrevious(outPath)

  printSummary(snapshot, previous)

  if (opts.dryRun) {
    console.log(`\n(--dry-run — ${opts.out} 에 쓰지 않았습니다)\n`)
  } else {
    mkdirSync(dirname(outPath), { recursive: true })
    // append-only. 한 줄 = 한 스냅샷이라 diff 가 항상 "+1 줄"이다.
    appendFileSync(outPath, JSON.stringify(snapshot) + '\n', 'utf8')
    console.log(`\n기록: ${opts.out} (+1 줄)\n`)
  }

  // CI 는 traffic 이 목적이다. 조용히 성공하면 14일 뒤 데이터가 사라진 걸 아무도 모른다.
  // 파일은 이미 썼으므로 여기서 죽어도 수집한 만큼은 남는다.
  if (opts.strict && !traffic) {
    fail(
      'traffic 데이터를 수집하지 못했습니다 (--strict).',
      '  기본 GITHUB_TOKEN 은 traffic API 를 읽을 수 없습니다.\n' +
        '  push 권한이 있는 PAT 를 METRICS_TOKEN 시크릿으로 등록하세요.\n' +
        '  자세한 내용: .github/workflows/metrics.yml 주석'
    )
  }
}

try {
  main()
} catch (err) {
  // gh 호출·JSON 파싱 실패가 raw 스택으로 새어 나가지 않게 한다.
  fail(
    `스냅샷 수집 실패: ${err.stderr || err.message}`,
    '  API 응답이 바뀌었거나 토큰 권한/네트워크 문제일 수 있습니다.\n' +
      '  gh api /repos/<owner>/<repo>/releases 를 직접 실행해 확인해 보세요.'
  )
}
