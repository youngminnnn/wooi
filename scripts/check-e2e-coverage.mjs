#!/usr/bin/env node
// 사용자에게 보이는 변경이 e2e 스펙 또는 사유가 적힌 명시적 예외와 함께 오는지 검증한다.

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

import { PATTERN as BRANCH_PATTERN } from './check-branch-name.mjs'

// 사용자에게 보이는 표면이 늘어나면 여기만 조정한다.
export const USER_VISIBLE_SURFACES = ['src/renderer/', 'src/main/ipc.ts']

const SUBJECT_TYPES = new Set(['feat', 'fix'])
const EXEMPT_BRANCHES = new Set(['main', 'HEAD'])
const EXEMPT_PREFIXES = ['dependabot/']
const TEST_FILE_PATTERN = /\.test\.tsx?$/
const COVERAGE_PATH_PATTERN = /^(e2e\/specs\/.+|e2e\/fixtures\.mjs)$/
const SKIP_TRAILER_PATTERN = /^E2E-Skip:[ \t]+(\S(?:.*\S)?)[ \t]*$/m

/** 이미 모은 입력만으로 e2e 보강 필요 여부를 판정한다. */
export function checkE2eCoverage({ branchName, changedFiles, commitMessages }) {
  if (
    EXEMPT_BRANCHES.has(branchName) ||
    EXEMPT_PREFIXES.some((prefix) => branchName.startsWith(prefix))
  ) {
    return { ok: true, reason: 'exempt-branch' }
  }

  const branchMatch = BRANCH_PATTERN.exec(branchName)
  if (!branchMatch || !SUBJECT_TYPES.has(branchMatch[1])) {
    return { ok: true, reason: 'exempt-branch-type' }
  }

  const triggeringFiles = changedFiles.filter(
    (file) =>
      USER_VISIBLE_SURFACES.some((surface) =>
        surface.endsWith('/') ? file.startsWith(surface) : file === surface
      ) && !TEST_FILE_PATTERN.test(file)
  )
  if (triggeringFiles.length === 0) return { ok: true, reason: 'no-user-visible-change' }

  if (changedFiles.some((file) => COVERAGE_PATH_PATTERN.test(file))) {
    return { ok: true, reason: 'coverage-changed' }
  }

  for (const message of commitMessages) {
    const skip = SKIP_TRAILER_PATTERN.exec(message)
    if (skip) return { ok: true, reason: 'skip-trailer', skipReason: skip[1].trim() }
  }

  return { ok: false, reason: 'coverage-required', triggeringFiles }
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' })
}

export function resolveBaseRef(baseBranch, gitCommand = git) {
  const candidates = [`origin/${baseBranch}`, baseBranch]
  for (const candidate of candidates) {
    try {
      gitCommand('rev-parse', '--verify', '--quiet', candidate)
      return candidate
    } catch {
      // 다음 후보는 로컬에서 remote-tracking ref 없이 실행하는 경우를 위한 fallback 이다.
    }
  }

  throw new Error(
    `could not resolve base branch "${baseBranch}" as "${candidates[0]}" or "${candidates[1]}". Ensure the checkout has full history (actions/checkout with fetch-depth: 0).`
  )
}

function collectInputs(branchName, baseBranch) {
  const baseRef = resolveBaseRef(baseBranch)
  const mergeBase = git('merge-base', 'HEAD', baseRef).trim()
  const changedFiles = git('diff', '--name-only', '-z', `${mergeBase}..HEAD`)
    .split('\0')
    .filter(Boolean)
  const commitMessages = git('log', '--format=%B%x00', `${mergeBase}..HEAD`)
    .split('\0')
    .filter(Boolean)
  return { branchName, changedFiles, commitMessages }
}

function run() {
  const branchName = (process.argv[2] ?? process.env.HEAD_REF ?? '').trim()
  const baseBranch = (process.argv[3] ?? process.env.BASE_REF ?? '').trim() || 'main'
  if (!branchName) {
    console.error(
      'check-e2e-coverage: pass the pull request branch name as an argument or HEAD_REF.'
    )
    process.exit(2)
  }

  let verdict
  try {
    verdict = checkE2eCoverage(collectInputs(branchName, baseBranch))
  } catch (error) {
    console.error(`check-e2e-coverage: could not inspect the git range: ${error.message}`)
    process.exit(2)
  }

  if (verdict.skipReason) {
    console.log(`E2E coverage skipped: ${verdict.skipReason}`)
  }
  if (verdict.ok) process.exit(0)

  console.error(
    [
      'E2E coverage is required for these user-visible changes:',
      ...verdict.triggeringFiles.map((file) => `  - ${file}`),
      '',
      'Add or update a spec under e2e/specs/.',
      'Start from e2e/specs/_template.mjs.',
      'To opt out, add an E2E-Skip: <reason> trailer to a commit in this pull request.'
    ].join('\n')
  )
  process.exit(1)
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) run()
