import { app } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, join } from 'node:path'
import { existsSync, readFileSync, statSync } from 'node:fs'
import type {
  FileDiff,
  FileDiffStatus,
  GitStatus,
  UpdateFromBaseResult,
  WorkspaceDiff
} from '@shared/types'

const exec = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 1024 * 1024 * 32 })
  return stdout.trim()
}

/** 종료 코드를 throw 하지 않고 그대로 받아, 충돌처럼 "정상적인 실패"를 분기 처리할 때 쓴다. */
async function gitTry(
  cwd: string,
  args: string[]
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout } = await exec('git', args, { cwd, maxBuffer: 1024 * 1024 * 32 })
    return { ok: true, stdout: stdout.trim(), stderr: '' }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    return {
      ok: false,
      stdout: (err.stdout ?? '').toString().trim(),
      stderr: (err.stderr ?? '').toString().trim()
    }
  }
}

/** 경로가 git 워킹트리인지 확인. */
export async function isGitRepo(path: string): Promise<boolean> {
  try {
    const out = await git(path, ['rev-parse', '--is-inside-work-tree'])
    return out === 'true'
  } catch {
    return false
  }
}

/** 리포의 기본 브랜치를 best-effort 로 감지한다 (origin/HEAD → main → master → 현재 브랜치). */
export async function detectDefaultBranch(repoPath: string): Promise<string> {
  try {
    const ref = await git(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    if (ref) return ref.replace(/^origin\//, '')
  } catch {
    // origin/HEAD 미설정 — 관용 이름으로 폴백.
  }
  for (const name of ['main', 'master']) {
    try {
      await git(repoPath, ['rev-parse', '--verify', '--quiet', name])
      return name
    } catch {
      // 해당 브랜치 없음.
    }
  }
  return git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
}

/** 로컬 브랜치 목록 (기본 브랜치를 맨 앞에 둔다). */
export async function listBranches(repoPath: string): Promise<string[]> {
  const out = await git(repoPath, ['branch', '--format=%(refname:short)'])
  const branches = out
    .split('\n')
    .map((b) => b.trim())
    .filter(Boolean)
  const def = await detectDefaultBranch(repoPath)
  return [def, ...branches.filter((b) => b !== def)]
}

/** 브랜치/디렉토리 이름으로 안전한 슬러그를 만든다. */
export function sanitizeBranch(name: string): string {
  const slug = name
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._/-]/g, '')
    .replace(/^[-/]+/, '')
    .replace(/\/{2,}/g, '/')
  return slug || 'workspace'
}

/**
 * worktree 경로를 사용자 홈 하위 `~/wooi/workspaces/<repo_name>/<branch>` 에 둔다.
 * 사용자 리포 부모 디렉토리를 어지럽히지 않으면서, 앱 데이터 디렉토리보다 사용자가
 * 직접 찾아 열기 쉬운 고정 위치에 workspace 들을 모은다.
 */
export function worktreePathFor(repoPath: string, branch: string): string {
  const repoName = basename(repoPath)
  const slug = sanitizeBranch(branch).replace(/\//g, '-')
  return join(app.getPath('home'), 'wooi', 'workspaces', repoName, slug)
}

/** 로컬 브랜치가 이미 존재하는지 확인. */
async function localBranchExists(repoPath: string, branch: string): Promise<boolean> {
  const r = await gitTry(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  return r.ok
}

/**
 * 원하는 브랜치 이름이 기존 로컬 브랜치나 이미 존재하는 worktree 디렉토리와 충돌하면
 * `-2`, `-3` … 처럼 접미사를 붙여 충돌하지 않는 브랜치/경로 쌍을 반환한다.
 * 새 worktree 생성 시 이름 충돌로 `git worktree add` 가 실패하는 것을 막는다.
 */
export async function resolveUniqueWorktree(
  repoPath: string,
  desiredBranch: string
): Promise<{ branch: string; worktreePath: string }> {
  const base = sanitizeBranch(desiredBranch)
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`
    const worktreePath = worktreePathFor(repoPath, candidate)
    const taken = existsSync(worktreePath) || (await localBranchExists(repoPath, candidate))
    if (!taken) return { branch: candidate, worktreePath }
  }
}

/** origin 에서 fetch 한다 (origin 미설정/오프라인 등은 조용히 무시). */
export async function fetchRemote(repoPath: string): Promise<void> {
  await git(repoPath, ['fetch', 'origin', '--prune']).catch(() => {
    // 리모트가 없거나 네트워크 실패 — 로컬 ref 로 폴백한다.
  })
}

/**
 * base 브랜치의 origin tracking ref(`origin/<base>`)를 우선 사용하고,
 * origin ref 가 없으면(리모트 미설정 등) 로컬 base 브랜치로 폴백한다.
 */
async function resolveBaseStartPoint(repoPath: string, baseBranch: string): Promise<string> {
  const remoteRef = `origin/${baseBranch.replace(/^origin\//, '')}`
  const hasRemote = await git(repoPath, ['rev-parse', '--verify', '--quiet', remoteRef])
    .then(() => true)
    .catch(() => false)
  return hasRemote ? remoteRef : baseBranch
}

/**
 * 새 브랜치로 worktree 를 추가한다. 브랜치가 이미 있으면 그 브랜치를 체크아웃한다.
 * 새로 만들 때는 항상 먼저 fetch 한 뒤 origin tracking ref(`origin/<base>`)에서 분기해
 * 최신 리모트 상태를 기준으로 삼는다.
 */
export async function addWorktree(
  repoPath: string,
  branch: string,
  baseBranch: string,
  worktreePath: string
): Promise<void> {
  const branchExists = await git(repoPath, ['rev-parse', '--verify', '--quiet', branch])
    .then(() => true)
    .catch(() => false)

  if (branchExists) {
    await git(repoPath, ['worktree', 'add', worktreePath, branch])
    return
  }

  // 항상 최신 origin 기준으로 분기하기 위해 먼저 fetch 한다.
  await fetchRemote(repoPath)
  const startPoint = await resolveBaseStartPoint(repoPath, baseBranch)
  await git(repoPath, ['worktree', 'add', '-b', branch, worktreePath, startPoint])
}

/** worktree 를 제거하고, 요청 시 브랜치도 삭제한다. */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  deleteBranch: boolean
): Promise<void> {
  await git(repoPath, ['worktree', 'remove', '--force', worktreePath]).catch(async () => {
    // worktree 디렉토리가 이미 사라졌으면 등록 정보만 정리.
    await git(repoPath, ['worktree', 'prune']).catch(() => {})
  })
  if (deleteBranch) {
    await git(repoPath, ['branch', '-D', branch]).catch(() => {})
  }
}

/** 사이드바 배지용 경량 상태 (브랜치, base 대비 ahead/behind, 변경 파일 수). */
export async function getStatus(worktreePath: string, baseBranch: string): Promise<GitStatus> {
  const branch = await git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '?')

  let changedFiles = 0
  let conflicted = false
  try {
    const porcelain = await git(worktreePath, ['status', '--porcelain'])
    const lines = porcelain ? porcelain.split('\n').filter(Boolean) : []
    changedFiles = lines.length
    // 미해결 머지 충돌은 XY 상태 코드에 'U' 가 있거나 AA/DD 인 항목으로 드러난다.
    conflicted = lines.some((l) => /^(DD|AU|UD|UA|DU|AA|UU)/.test(l))
  } catch {
    // 무시 — 0 으로 둔다.
  }

  let ahead = 0
  let behind = 0
  try {
    const counts = await git(worktreePath, [
      'rev-list',
      '--left-right',
      '--count',
      `${baseBranch}...HEAD`
    ])
    const [b, a] = counts.split(/\s+/).map((n) => parseInt(n, 10))
    behind = Number.isFinite(b) ? b : 0
    ahead = Number.isFinite(a) ? a : 0
  } catch {
    // base 브랜치 ref 가 없으면 0 으로 둔다.
  }

  return { branch, ahead, behind, changedFiles, conflicted }
}

export function repoNameFromPath(path: string): string {
  return basename(path)
}

/**
 * git 리모트 URL 에서 GitHub 소유자(owner) 이름을 뽑는다. GitHub 리모트가 아니면 null.
 * SSH(git@github.com:owner/repo.git)·HTTPS(https://github.com/owner/repo(.git))·
 * ssh://git@github.com/owner/repo 형태를 모두 받아 준다.
 */
export function parseGithubOwner(remoteUrl: string): string | null {
  const m = remoteUrl.trim().match(/github\.com[/:]([^/]+)\/[^/]+?(?:\.git)?\/?$/i)
  return m ? m[1] : null
}

/** origin 리모트가 GitHub 이면 소유자 이름을 반환한다(아니면 null). */
export async function getGithubOwner(repoPath: string): Promise<string | null> {
  const url = await git(repoPath, ['remote', 'get-url', 'origin']).catch(() => '')
  return url ? parseGithubOwner(url) : null
}

// ── base 브랜치에서 업데이트(머지) ────────────────────────────────────────

/**
 * 최신 base 브랜치를 현재 워크스페이스 브랜치로 머지해, 병렬 작업 중 움직인 base 와의 드리프트를
 * 해소한다(GitHub 의 "Update branch" 와 같은 의미 — base 를 브랜치로 끌어온다).
 *
 * 안전 장치:
 * - 미커밋 변경이 있으면 머지가 워킹트리를 덮어쓸 수 있어 먼저 막는다('dirty').
 * - 이미 최신이면 머지하지 않는다('up-to-date').
 * - 충돌이 나면 워킹트리를 충돌 상태로 남겨 두고 파일 목록을 돌려준다('conflict') —
 *   사용자가 에디터/에이전트로 해결하거나 abortMerge 로 되돌릴 수 있다.
 */
export async function updateFromBase(
  worktreePath: string,
  baseBranch: string
): Promise<UpdateFromBaseResult> {
  const dirty = (await git(worktreePath, ['status', '--porcelain']).catch(() => '')).trim()
  if (dirty) {
    return {
      status: 'dirty',
      baseBranch,
      message: 'Commit or stash your changes before updating from base.'
    }
  }

  // 최신 origin 을 먼저 가져온 뒤 origin/<base>(없으면 로컬 base)를 머지 대상으로 삼는다.
  await fetchRemote(worktreePath)
  const startPoint = await resolveBaseStartPoint(worktreePath, baseBranch)

  const behind = await git(worktreePath, ['rev-list', '--count', `HEAD..${startPoint}`])
    .then((s) => parseInt(s, 10) || 0)
    .catch(() => 0)
  if (behind === 0) return { status: 'up-to-date', baseBranch }

  const merge = await gitTry(worktreePath, ['merge', '--no-edit', startPoint])
  if (merge.ok) return { status: 'updated', baseBranch }

  const conflicts = await git(worktreePath, ['diff', '--name-only', '--diff-filter=U']).catch(
    () => ''
  )
  const conflictedFiles = conflicts
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  if (conflictedFiles.length) return { status: 'conflict', baseBranch, conflictedFiles }

  // 충돌이 아닌 다른 실패(예: 머지 진행 중 중단) — 머지를 깔끔히 되돌리고 메시지를 전달한다.
  await abortMerge(worktreePath)
  return { status: 'error', baseBranch, message: merge.stderr || 'Failed to update from base.' }
}

/** 진행 중인 머지를 취소해 워크스페이스를 머지 직전 상태로 되돌린다(충돌 포기용). */
export async function abortMerge(worktreePath: string): Promise<void> {
  await git(worktreePath, ['merge', '--abort']).catch(() => {})
}

// ── diff (변경 검토용) ───────────────────────────────────────────────────

const UNTRACKED_MAX_BYTES = 512 * 1024

/**
 * base 브랜치 대비 workspace 의 전체 변경을 파일별로 반환한다.
 * 추적 파일은 `git diff <base>`(커밋 + staged + unstaged 를 한 번에 반영)로,
 * 신규(untracked) 파일은 별도로 합쳐 "추가됨" 으로 표시한다.
 */
export async function getDiff(worktreePath: string, baseBranch: string): Promise<WorkspaceDiff> {
  // base 가 분기 이후 전진했어도 base 의 새 커밋이 역방향 변경으로 보이지 않도록,
  // base..HEAD 의 공통 조상(merge-base)을 기준으로 working tree 와 비교한다(PR diff 와 동일 의미).
  const from = await git(worktreePath, ['merge-base', baseBranch, 'HEAD']).catch(() => baseBranch)

  let raw = ''
  try {
    raw = await git(worktreePath, ['diff', from])
  } catch {
    // base ref 가 없으면 추적 변경은 비운다.
  }
  const files = parseUnifiedDiff(raw)

  // untracked(신규) 파일은 git diff 에 나오지 않으므로 직접 추가 패치를 만든다.
  try {
    const out = await git(worktreePath, ['ls-files', '--others', '--exclude-standard'])
    for (const rel of out
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean)) {
      files.push(untrackedFileDiff(join(worktreePath, rel), rel))
    }
  } catch {
    // 무시.
  }

  files.sort((a, b) => a.path.localeCompare(b.path))
  return { baseBranch, files }
}

/** 통합 diff 출력을 파일 단위로 쪼갠다. */
function parseUnifiedDiff(raw: string): FileDiff[] {
  if (!raw.trim()) return []
  // 각 파일 블록은 "diff --git " 으로 시작한다.
  return raw
    .split(/^diff --git /m)
    .filter((c) => c.trim())
    .map((chunk) => {
      const body = `diff --git ${chunk}`.replace(/\n+$/, '\n')
      const lines = body.split('\n')

      const binary = lines.some((l) => l.startsWith('Binary files'))
      let status: FileDiffStatus = 'modified'
      if (lines.some((l) => l.startsWith('new file'))) status = 'added'
      else if (lines.some((l) => l.startsWith('deleted file'))) status = 'deleted'
      else if (lines.some((l) => l.startsWith('rename '))) status = 'renamed'

      const plus = lines.find((l) => l.startsWith('+++ '))?.slice(4)
      const minus = lines.find((l) => l.startsWith('--- '))?.slice(4)
      const renameTo = lines.find((l) => l.startsWith('rename to '))?.slice('rename to '.length)
      const path =
        renameTo ??
        stripGitPrefix(plus && plus !== '/dev/null' ? plus : minus) ??
        firstHeaderPath(lines[0]) ??
        '(unknown)'

      let additions = 0
      let deletions = 0
      for (const l of lines) {
        if (l.startsWith('+') && !l.startsWith('+++')) additions++
        else if (l.startsWith('-') && !l.startsWith('---')) deletions++
      }

      return { path, status, additions, deletions, patch: binary ? '' : body, binary }
    })
}

function stripGitPrefix(p: string | undefined): string | undefined {
  if (!p) return undefined
  return p.replace(/^[ab]\//, '')
}

/** "diff --git a/foo b/foo" 헤더 라인에서 경로를 best-effort 로 추출. */
function firstHeaderPath(header: string | undefined): string | undefined {
  if (!header) return undefined
  const m = header.match(/^diff --git a\/(.+) b\//)
  return m?.[1]
}

/** untracked 신규 파일을 "추가됨" 통합 diff 로 만든다. */
function untrackedFileDiff(absPath: string, rel: string): FileDiff {
  const header = `diff --git a/${rel} b/${rel}\nnew file\n--- /dev/null\n+++ b/${rel}\n`
  try {
    if (statSync(absPath).size > UNTRACKED_MAX_BYTES) {
      return { path: rel, status: 'added', additions: 0, deletions: 0, patch: '', binary: true }
    }
    const buf = readFileSync(absPath)
    if (buf.includes(0)) {
      return { path: rel, status: 'added', additions: 0, deletions: 0, patch: '', binary: true }
    }
    const text = buf.toString('utf-8')
    if (text === '') {
      return {
        path: rel,
        status: 'added',
        additions: 0,
        deletions: 0,
        patch: header,
        binary: false
      }
    }
    // split('\n') 은 끝 개행 때문에 빈 마지막 항목을 만든다 — 실제 내용 줄만 남긴다.
    const all = text.split('\n')
    const contentLines = text.endsWith('\n') ? all.slice(0, -1) : all
    const n = contentLines.length
    const hunk = `@@ -0,0 +1,${n} @@\n` + contentLines.map((l) => `+${l}`).join('\n')
    return {
      path: rel,
      status: 'added',
      additions: n,
      deletions: 0,
      patch: header + hunk,
      binary: false
    }
  } catch {
    return { path: rel, status: 'added', additions: 0, deletions: 0, patch: '', binary: true }
  }
}
