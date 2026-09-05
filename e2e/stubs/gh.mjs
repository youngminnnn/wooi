#!/usr/bin/env node
/* global process, console */
/**
 * e2e 전용 `gh` 대역. 실제 GitHub 없이 PR 상태를 대본대로 돌려준다.
 *
 * 머지 트레인처럼 GitHub 응답에 전적으로 매인 흐름은 이것 없이는 앱을 띄워도 한 걸음도
 * 못 밟는다. 앱 코드를 건드리지 않고 **외부 CLI 만** 바꾸는 것이 요점이다 — 검증 대상인
 * main/renderer 는 실제 코드 그대로 돈다.
 *
 * 대본은 WOOI_E2E_GH_STATE 가 가리키는 JSON 파일이고, 스펙이 실행 중에 다시 쓸 수 있다.
 * 모양: { "prs": [ { "number": 1, "headRefName": "...", "baseRefName": "...", ... } ] }
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const statePath = process.env.WOOI_E2E_GH_STATE
const argv = process.argv.slice(2)

function readState() {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'))
  } catch {
    return { prs: [] }
  }
}

function currentBranch() {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

/** `--json a,b,c` 로 요청한 필드만 골라 낸다 — gh 가 그렇게 동작한다. */
function pick(record, fields) {
  if (!fields) return record
  const out = {}
  for (const field of fields) out[field] = record[field] ?? null
  return out
}

function jsonFields() {
  const at = argv.indexOf('--json')
  return at < 0 ? null : argv[at + 1].split(',')
}

function findPr(state, selector) {
  if (selector && /^\d+$/.test(selector)) {
    return state.prs.find((pr) => String(pr.number) === selector) ?? null
  }
  const branch = selector || currentBranch()
  return state.prs.find((pr) => pr.headRefName === branch) ?? null
}

const [command, sub, ...rest] = argv

if (command === 'auth' && sub === 'status') {
  console.log('github.com\n  ✓ Logged in to github.com as e2e')
  process.exit(0)
}

if (command === 'pr' && sub === 'view') {
  const state = readState()
  const selector = rest[0] && !rest[0].startsWith('-') ? rest[0] : null
  const pr = findPr(state, selector)
  if (!pr) {
    console.error('no pull requests found')
    process.exit(1)
  }
  const fields = jsonFields()
  const picked = pick(pr, fields)
  // `--jq .field` 는 gh 가 값 하나만 뱉게 하는 형태다. 여기서는 쓰이는 만큼만 흉내 낸다.
  const jqAt = argv.indexOf('--jq')
  if (jqAt >= 0) {
    const key = argv[jqAt + 1].replace(/^\./, '')
    console.log(picked[key] ?? '')
  } else {
    console.log(JSON.stringify(picked))
  }
  process.exit(0)
}

if (command === 'pr' && sub === 'list') {
  const state = readState()
  const fields = jsonFields()
  const open = state.prs.filter((pr) => pr.state === 'OPEN')
  console.log(JSON.stringify(open.map((pr) => pick(pr, fields))))
  process.exit(0)
}

if (command === 'pr' && sub === 'merge') {
  const state = readState()
  const selector = rest.find((arg) => !arg.startsWith('-')) ?? null
  const pr = findPr(state, selector)
  if (!pr) {
    console.error('no pull requests found')
    process.exit(1)
  }
  pr.state = 'MERGED'
  pr.mergeStateStatus = 'MERGED'
  writeFileSync(statePath, JSON.stringify(state, null, 2))
  console.log(`Merged pull request #${pr.number}`)
  process.exit(0)
}

// 나머지는 조용히 성공시킨다 — 검증 대상 밖의 조회가 앱을 멈춰 세우지 않게 한다.
console.log(jsonFields() ? '[]' : '')
process.exit(0)
