#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const GATE_TIMEOUT_MS = 120_000
const MAX_FAILURE_LINES = 80
const MAX_FAILURE_CHARS = 12_000
const CACHE_VERSION = 1

/**
 * 변경 경로별 검사 정책:
 * - renderer 소스만 바뀌면 web 타입과 renderer 테스트만 실행한다.
 * - 그 밖의 제품/도구 코드나 빌드·테스트 설정은 전체 타입과 테스트를 실행한다.
 * - 문서, 에이전트 설정 등 실행 결과에 영향을 주지 않는 파일은 건너뛴다.
 *
 * 긴급히 우회해야 하면 Claude Code 를 WOOI_SKIP_STOP_GATE=1 환경 변수와 함께 실행한다.
 */
export function selectGates(files) {
  const relevant = files.filter(isRelevant)
  if (relevant.length === 0) return []

  if (relevant.every((file) => file.startsWith('src/renderer/'))) {
    return ['typecheck:web', 'test:renderer']
  }

  return ['typecheck', 'test']
}

function isRelevant(file) {
  return (
    file.startsWith('src/') ||
    file.startsWith('scripts/') ||
    file === 'package.json' ||
    file === 'package-lock.json' ||
    file === 'electron.vite.config.ts' ||
    file === 'vitest.config.ts' ||
    file.startsWith('tsconfig')
  )
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(result.stderr.trim() || `git ${args.join(' ')} failed`)
  }
  return result.stdout.trim()
}

function defaultBranchRef(cwd) {
  const symbolic = spawnSync(
    'git',
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    { cwd, encoding: 'utf8' }
  )
  if (symbolic.status === 0 && symbolic.stdout.trim()) return symbolic.stdout.trim()

  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    const exists = spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd })
    if (exists.status === 0) return ref
  }
  return null
}

export function getChangedFiles(cwd = process.cwd()) {
  const files = new Set()
  const add = (output) => {
    for (const file of output.split('\n')) if (file) files.add(file)
  }

  // 작업 트리, index, ignored 되지 않은 untracked 파일을 모두 포함한다.
  add(git(['diff', '--name-only'], cwd))
  add(git(['diff', '--cached', '--name-only'], cwd))
  add(git(['ls-files', '--others', '--exclude-standard'], cwd))

  // 브랜치에서 이미 커밋한 변경도 아직 CI 전이면 같은 품질 게이트의 대상이다.
  const branch = defaultBranchRef(cwd)
  if (branch) {
    const base = git(['merge-base', 'HEAD', branch], cwd)
    add(git(['diff', '--name-only', `${base}...HEAD`], cwd))
  }

  return [...files]
}

export function fingerprintChangedFiles(files, cwd = process.cwd()) {
  const hash = createHash('sha256')

  // mtime 은 보존되거나 해상도가 부족할 수 있다. 경로와 실제 바이트를 해시해 모든 편집을 잡는다.
  for (const file of [...files].sort()) {
    hash.update(`${file}\0`)
    try {
      const stat = lstatSync(join(cwd, file))
      if (stat.isSymbolicLink()) {
        hash.update(`symlink\0${stat.mode}\0${readlinkSync(join(cwd, file))}\0`)
      } else if (stat.isFile()) {
        hash.update(`file\0${stat.mode}\0`)
        hash.update(readFileSync(join(cwd, file)))
        hash.update('\0')
      } else {
        hash.update(`other\0${stat.mode}\0${stat.size}\0`)
      }
    } catch {
      hash.update('missing\0')
    }
  }

  return hash.digest('hex')
}

function cacheFile(cwd) {
  const gitDir = git(['rev-parse', '--git-common-dir'], cwd)
  const symbolic = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd,
    encoding: 'utf8'
  })
  const branch =
    symbolic.status === 0 ? symbolic.stdout.trim() : `detached:${git(['rev-parse', 'HEAD'], cwd)}`
  const branchKey = createHash('sha256').update(branch).digest('hex')
  return join(resolve(cwd, gitDir), 'stop-gate-cache', `${branchKey}.json`)
}

export const fileFingerprintCache = {
  read(cwd) {
    try {
      const value = JSON.parse(readFileSync(cacheFile(cwd), 'utf8'))
      return value?.version === CACHE_VERSION && typeof value.fingerprint === 'string'
        ? value.fingerprint
        : null
    } catch {
      return null
    }
  },
  write(cwd, fingerprint) {
    let temporary
    try {
      const target = cacheFile(cwd)
      mkdirSync(dirname(target), { recursive: true })
      temporary = `${target}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(
        temporary,
        `${JSON.stringify({ version: CACHE_VERSION, fingerprint })}\n`,
        'utf8'
      )
      renameSync(temporary, target)
    } catch {
      if (temporary) {
        try {
          unlinkSync(temporary)
        } catch {
          // 임시 파일 정리 실패가 원래 stop 결과를 바꾸면 안 된다.
        }
      }
    }
  }
}

export function runNpmGate(gate, { cwd = process.cwd(), timeoutMs = GATE_TIMEOUT_MS } = {}) {
  const result = spawnSync('npm', ['run', gate], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024
  })
  const timedOut = result.error?.code === 'ETIMEDOUT'
  return {
    status: result.status ?? (timedOut ? null : 1),
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    timedOut
  }
}

function trimFailure(output) {
  const lines = output.trim().split('\n')
  return lines.slice(-MAX_FAILURE_LINES).join('\n').slice(-MAX_FAILURE_CHARS)
}

export function evaluateStopHook(
  input,
  {
    env = process.env,
    changedFiles = getChangedFiles,
    fingerprinter = fingerprintChangedFiles,
    fingerprintCache = fileFingerprintCache,
    runner = runNpmGate,
    cwd = process.cwd()
  } = {}
) {
  // 반드시 첫 판단이어야 한다. 이전 block 이 시작한 turn 을 다시 막으면 무한 루프가 된다.
  if (input?.stop_hook_active === true) return { code: 0, stderr: '', ran: [] }
  if (env.WOOI_SKIP_STOP_GATE === '1') return { code: 0, stderr: '', ran: [] }

  try {
    const files = changedFiles(cwd)
    const gates = selectGates(files)
    if (gates.length === 0) return { code: 0, stderr: '', ran: [] }

    const fingerprint = fingerprinter(files, cwd)
    let cachedFingerprint = null
    try {
      cachedFingerprint = fingerprintCache.read(cwd)
    } catch {
      // 읽을 수 없는 cache 는 miss 로 취급한다.
    }
    if (cachedFingerprint === fingerprint) {
      return { code: 0, stderr: '', ran: [] }
    }

    const ran = []
    for (const gate of gates) {
      ran.push(gate)
      const result = runner(gate, { cwd, timeoutMs: GATE_TIMEOUT_MS })
      if (result.timedOut) {
        return {
          code: 0,
          stderr: `Warning: Stop quality gate "npm run ${gate}" timed out; allowing stop to avoid wedging the session.\n`,
          ran
        }
      }
      if (result.status !== 0) {
        const detail = trimFailure(result.output)
        return {
          code: 2,
          stderr: `Stop quality gate failed: npm run ${gate}\nFix the failure before stopping.\n${detail}${detail ? '\n' : ''}`,
          ran
        }
      }
    }
    try {
      fingerprintCache.write(cwd, fingerprint)
    } catch {
      // cache 저장 실패가 통과한 검사를 실패로 바꾸면 안 된다.
    }
    return { code: 0, stderr: '', ran }
  } catch (error) {
    return {
      code: 0,
      stderr: `Warning: Stop quality gate could not run; allowing stop: ${error instanceof Error ? error.message : String(error)}\n`,
      ran: []
    }
  }
}

function cli() {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'))
    const result = evaluateStopHook(input)
    if (result.stderr) process.stderr.write(result.stderr)
    process.exitCode = result.code
  } catch (error) {
    process.stderr.write(
      `Warning: Stop quality gate received invalid input; allowing stop: ${error instanceof Error ? error.message : String(error)}\n`
    )
    process.exitCode = 0
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) cli()
