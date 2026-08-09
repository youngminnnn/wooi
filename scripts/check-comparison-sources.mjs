#!/usr/bin/env node
/**
 * docs/alternatives.html 의 비교표가 낡았는지 검사한다.
 *
 * 이 표의 문제는 틀리는 게 아니라 **조용히** 틀리는 것이다. 경쟁 도구가 기능을 하나 추가하면
 * "문서 없음" 칸이 그날부터 거짓이 되는데, 아무도 알려 주지 않는다. 표를 항상 최신으로
 * 유지하는 건 불가능하니, 대신 낡았다는 사실이 눈에 띄게 만든다.
 *
 * 두 가지를 본다.
 *
 *   1. 업스트림이 움직였는가 — docs/comparison-sources.json 에 기록해 둔 커밋(사람이 실제로
 *      읽은 판본)과 지금 그 파일을 마지막으로 건드린 커밋을 비교한다. 다르면 다시 읽어야 한다.
 *      README 가 안 바뀌었다고 기능이 안 생긴 건 아니지만, 바뀌었다면 확인할 이유는 확실하다.
 *
 *   2. 그냥 오래됐는가 — reviewedOn 이 staleAfterDays 를 넘겼으면, 업스트림이 조용해도
 *      다시 볼 때가 된 것이다. 공개 저장소가 없는 Conductor 는 이 경로로만 잡힌다.
 *
 * 덤으로 alternatives.html 의 #freshness data-checked 가 manifest 의 reviewedOn 과 같은지
 * 확인한다. 둘이 갈라지면 페이지가 독자에게 말하는 날짜와 우리가 실제로 확인한 날짜가 달라진다.
 *
 * 사용법:
 *   node scripts/check-comparison-sources.mjs             # 사람이 읽는 출력
 *   node scripts/check-comparison-sources.mjs --markdown  # 이슈 본문용
 *
 * 종료 코드: 손댈 게 없으면 0, 다시 확인이 필요하면 1. GITHUB_TOKEN 이 있으면 쓰고,
 * 없으면 익명으로 부른다(레이트 리밋만 낮아진다).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = join(ROOT, 'docs/comparison-sources.json')
const PAGE = join(ROOT, 'docs/alternatives.html')

const markdown = process.argv.includes('--markdown')

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN

/** 해당 경로를 마지막으로 건드린 커밋의 sha. 저장소가 사라졌거나 응답이 이상하면 null. */
async function latestSha(repo, path) {
  const url = `https://api.github.com/repos/${repo}/commits?path=${encodeURIComponent(path)}&per_page=1`
  const res = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'wooi-comparison-freshness',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    }
  })
  if (!res.ok) throw new Error(`${repo}: HTTP ${res.status}`)
  const commits = await res.json()
  return Array.isArray(commits) && commits[0] ? commits[0].sha : null
}

const findings = []

// ── 1. 페이지와 manifest 가 갈라졌는지 ───────────────────────────────────────
// 갈라지면 페이지가 독자에게 말하는 것과 우리가 실제로 확인한 것이 달라진다.
const page = readFileSync(PAGE, 'utf8')
const attrs = /id="freshness"([^>]*)>/.exec(page)?.[1] ?? ''
const declaredOn = /data-checked="([^"]+)"/.exec(attrs)?.[1]
const declaredAfter = /data-stale-after="([^"]+)"/.exec(attrs)?.[1]

if (declaredOn !== manifest.reviewedOn) {
  findings.push(
    `**날짜 불일치** — alternatives.html 은 \`${declaredOn ?? '없음'}\` 에 확인했다고 말하지만 ` +
      `comparison-sources.json 은 \`${manifest.reviewedOn}\` 이다. 둘을 맞춰야 한다.`
  )
}
if (Number(declaredAfter) !== manifest.staleAfterDays) {
  findings.push(
    `**유효기간 불일치** — alternatives.html 의 경고 임계치는 \`${declaredAfter ?? '없음'}\`일, ` +
      `comparison-sources.json 은 \`${manifest.staleAfterDays}\`일이다. 페이지가 경고를 띄우는 시점과 ` +
      `이 검사가 이슈를 여는 시점이 어긋난다.`
  )
}

// ── 2. reviewedOn 이 얼마나 지났는지 ─────────────────────────────────────────
const age = Math.floor((Date.now() - Date.parse(manifest.reviewedOn)) / 86_400_000)
const stale = age >= manifest.staleAfterDays
if (stale) {
  findings.push(
    `**${age}일 경과** — 마지막 확인이 ${manifest.reviewedOn} 이고 기준은 ` +
      `${manifest.staleAfterDays}일이다. 표를 한 번 훑을 때가 됐다. ` +
      `공개 저장소가 없는 도구(Conductor)는 이 경로로만 잡히므로 특히 직접 봐야 한다.`
  )
}

// ── 3. 업스트림 문서가 움직였는지 ────────────────────────────────────────────
const tracked = manifest.projects.filter((p) => p.repo)
const results = await Promise.all(
  tracked.map(async (p) => {
    try {
      return { p, sha: await latestSha(p.repo, p.path) }
    } catch (err) {
      return { p, error: err.message }
    }
  })
)

for (const { p, sha, error } of results) {
  if (error) {
    findings.push(`**${p.name}** — 확인 실패: ${error}`)
    continue
  }
  if (sha && sha !== p.sha) {
    // 그 열만 따로 다시 본 날이 있으면 그 날짜를 기준으로 말한다. 최상위 reviewedOn 으로
    // 뭉뚱그리면 이미 재확인한 열을 다시 확인하라고 보채게 된다.
    const since = p.reviewedOn ?? manifest.reviewedOn
    findings.push(
      `**${p.name}** — \`${p.path}\` 가 ${since} 확인 이후 바뀌었다. ` +
        `[변경 내역](https://github.com/${p.repo}/compare/${p.sha}...${sha}) · ` +
        `기록 \`${p.sha.slice(0, 7)}\` → 현재 \`${sha.slice(0, 7)}\``
    )
  }
}

// ── 출력 ────────────────────────────────────────────────────────────────────
if (findings.length === 0) {
  console.log(
    markdown
      ? `비교표는 아직 유효하다 — 확인일 ${manifest.reviewedOn}(${age}일 전), 추적 중인 문서 ${tracked.length}건 모두 그대로.`
      : `✓ 손댈 것 없음 — 확인일 ${manifest.reviewedOn}(${age}일 전), 문서 ${tracked.length}건 변동 없음.`
  )
  process.exit(0)
}

const body = [
  markdown
    ? `\`docs/alternatives.html\` 의 비교표를 다시 확인할 때가 됐다. 마지막 확인은 **${manifest.reviewedOn}**(${age}일 전).`
    : `비교표를 다시 확인해야 한다 (확인일 ${manifest.reviewedOn}, ${age}일 전):`,
  '',
  ...findings.map((f) => `- ${f}`),
  '',
  markdown
    ? '확인을 마쳤으면 `docs/comparison-sources.json` 의 `reviewedOn` 과 각 `sha`, ' +
      '그리고 `docs/alternatives.html` 의 확인 날짜 문구와 `#freshness` 의 `data-checked` 를 같이 갱신한다.'
    : '갱신 대상: comparison-sources.json 의 reviewedOn·sha, alternatives.html 의 날짜 문구와 data-checked.'
].join('\n')

console.log(body)
process.exit(1)
