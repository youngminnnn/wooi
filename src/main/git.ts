import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { wooiHome } from './paths'
import { runGh } from './github'
import type {
  FileDiff,
  FileDiffStatus,
  GitStatus,
  CommitEntry,
  CommitMoveStep,
  RestackResult,
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

const parseGitPathList = (output: string): string[] =>
  output
    .split('\n')
    .map((path) => path.trim())
    .filter(Boolean)

/**
 * 이 워크트리의 git 디렉터리. 워크트리에서는 `.git` 이 디렉터리가 아니라 `gitdir: <경로>` 한 줄이
 * 든 파일이라 두 경우를 모두 풀어야 한다. 프로세스를 띄우지 않는 것이 요점이다 — 이 경로를 쓰는
 * getStatus 는 15초 폴링에 얹혀 있어서, 워크스페이스마다 git 을 한 번 더 부르면 그대로 비용이 된다.
 */
function gitDirOf(worktreePath: string): string | null {
  const dotGit = join(worktreePath, '.git')
  try {
    if (statSync(dotGit).isDirectory()) return dotGit
    const found = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf-8'))?.[1]?.trim()
    if (!found) return null
    return isAbsolute(found) ? found : resolve(worktreePath, found)
  } catch {
    return null
  }
}

/** 이 워크트리에 rebase 가 진행 중인지. 충돌 여부와는 무관하다. */
function isRebasing(worktreePath: string): boolean {
  const dir = gitDirOf(worktreePath)
  if (!dir) return false
  return existsSync(join(dir, 'rebase-merge')) || existsSync(join(dir, 'rebase-apply'))
}

/** 진행 중인 rebase 가 끝나면 돌아갈 브랜치(head-name). 알 수 없으면 null. */
function rebaseHeadName(worktreePath: string): string | null {
  const dir = gitDirOf(worktreePath)
  if (!dir) return null
  for (const state of ['rebase-merge', 'rebase-apply']) {
    try {
      const ref = readFileSync(join(dir, state, 'head-name'), 'utf-8').trim()
      if (ref) return ref.replace(/^refs\/heads\//, '')
    } catch {
      // 다음 후보를 본다 — rebase 종류에 따라 둘 중 하나만 존재한다.
    }
  }
  return null
}

/**
 * 진행 중인 rebase 와 그 충돌 파일.
 *
 * `rebasing` 은 충돌 여부와 **독립**이다 — 충돌을 stage 하고 아직 `--continue` 하지 않은 순간에도
 * rebase 는 진행 중이다. 둘을 한 값으로 합치면 "지금 rebase 중인가"라는 질문에 답할 수 없게 된다.
 *
 * `branch` 는 rebase 가 끝나면 돌아갈 브랜치다. rebase 중에는 HEAD 가 detached 라
 * `rev-parse --abbrev-ref HEAD` 로는 알 수 없고, 모델 B 스택처럼 엔트리마다 체크아웃해 rebase 하는
 * 경로에서는 워크스페이스에 기록된 브랜치와 실제로 rebase 중인 브랜치가 다르다 — 그때 이 값이
 * 유일하게 믿을 수 있는 출처다.
 */
export async function rebaseConflictState(
  worktreePath: string
): Promise<{ rebasing: boolean; branch: string | null; conflictedFiles: string[] }> {
  if (!isRebasing(worktreePath)) return { rebasing: false, branch: null, conflictedFiles: [] }
  const conflicts = await git(worktreePath, ['diff', '--name-only', '--diff-filter=U']).catch(
    () => ''
  )
  return {
    rebasing: true,
    branch: rebaseHeadName(worktreePath),
    conflictedFiles: parseGitPathList(conflicts)
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
 *
 * dev 실행은 루트가 `~/wooi-dev` 로 갈린다([[paths]]) — 설치본이 관리하는 실제 워크트리와
 * 섞이거나 같은 경로를 두 프로세스가 동시에 조작하는 일을 막는다.
 */
export function worktreePathFor(repoPath: string, branch: string): string {
  const repoName = basename(repoPath)
  const slug = sanitizeBranch(branch).replace(/\//g, '-')
  return join(wooiHome(), 'workspaces', repoName, slug)
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
  desiredBranch: string,
  options?: { fixedBranch?: boolean }
): Promise<{ branch: string; worktreePath: string }> {
  const base = sanitizeBranch(desiredBranch)
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`
    const worktreePath = worktreePathFor(repoPath, candidate)
    // PR checkout 은 실제 로컬 브랜치명을 gh 가 나중에 정한다. 여기서 이름까지 uniquify 하면
    // checkout 전의 임시 판단이 그 결정을 앞질러 버리므로, 디렉토리 충돌만 피한다.
    if (options?.fixedBranch) {
      if (!existsSync(worktreePath)) return { branch: base, worktreePath }
      continue
    }
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

const remoteFetchesInFlight = new Map<string, Promise<void>>()

/** 같은 리포의 동시 fetch 를 하나로 합친다. 완료된 fetch 는 다음 폴링 틱이 새로 실행할 수 있게 비운다. */
export function fetchRemoteForRepo(
  repoPath: string,
  cacheKey: string,
  fetcher: (path: string) => Promise<void> = fetchRemote
): Promise<void> {
  const inFlight = remoteFetchesInFlight.get(cacheKey)
  if (inFlight) return inFlight

  const promise = fetcher(repoPath)
    .catch(() => {
      // fetchRemote 이 이미 실패를 삼키지만, 대체 구현이나 미래 변경도 폴링을 깨뜨리지 않게 경계를 지킨다.
    })
    .finally(() => {
      if (remoteFetchesInFlight.get(cacheKey) === promise) remoteFetchesInFlight.delete(cacheKey)
    })
  remoteFetchesInFlight.set(cacheKey, promise)
  return promise
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
 * startPoint 가 없으면 먼저 fetch 한 뒤 origin tracking ref(`origin/<base>`)에서 분기한다.
 * fork 는 원본의 로컬 HEAD 를 startPoint 로 넘긴다 — origin base 에서 만들면 아직 push 하지 않은
 * 커밋이 말없이 빠져, 물려받은 대화가 전제하는 코드와 실제 코드가 서로 달라진다.
 */
export async function addWorktree(
  repoPath: string,
  branch: string,
  baseBranch: string,
  worktreePath: string,
  startPoint?: string
): Promise<void> {
  const branchExists = await git(repoPath, ['rev-parse', '--verify', '--quiet', branch])
    .then(() => true)
    .catch(() => false)

  if (branchExists) {
    await git(repoPath, ['worktree', 'add', worktreePath, branch])
    return
  }

  let resolvedStartPoint = startPoint
  if (!resolvedStartPoint) {
    // 기본 생성은 최신 origin 기준으로 분기하기 위해 먼저 fetch 한다.
    await fetchRemote(repoPath)
    resolvedStartPoint = await resolveBaseStartPoint(repoPath, baseBranch)
  }
  await git(repoPath, ['worktree', 'add', '-b', branch, worktreePath, resolvedStartPoint])
}

/**
 * 커밋하지 않은 tracked 변경을 원본 worktree 를 건드리지 않고 스냅샷한다. 깨끗하면 null.
 * `git stash create` 는 stash 스택을 바꾸지 않는 대신 untracked 파일은 담지 않는다.
 */
export async function snapshotWorkingTree(worktreePath: string): Promise<string | null> {
  const sha = await git(worktreePath, ['stash', 'create'])
  return sha || null
}

/** snapshotWorkingTree 가 만든 스냅샷을 다른 worktree에 적용한다. */
export async function applySnapshot(worktreePath: string, sha: string): Promise<void> {
  await git(worktreePath, ['stash', 'apply', sha])
}

// ── gh 의 기본 PR base (branch.<name>.gh-merge-base) ────────────────────────
//
// `gh pr create` 는 `--base` 가 없으면 이 브랜치 설정을 읽고, 그것도 없으면 리포 기본 브랜치를
// 쓴다. 스택 워크스페이스에서 에이전트가 맨손으로 `gh pr create` 를 치면 PR 이 부모가 아니라
// main 을 향하는 이유가 이것이다 — 값을 미리 심어 두면 명령을 누가 치든(Wooi·에이전트·터미널)
// 부모 브랜치를 향한다. 프롬프트로 부탁하는 대신 기본값 자체를 옳게 만드는 쪽이다.
//
// 저장 위치는 리포 공용 config 의 브랜치 섹션이라 어느 worktree 에서 실행해도 같은 곳에 쓰이고,
// `git branch -m` 은 섹션을 함께 옮기며 브랜치 삭제 시 함께 지워진다. 이 키를 모르는 구버전 gh
// 는 그냥 무시한다.

function ghMergeBaseKey(branch: string): string {
  return `branch.${branch}.gh-merge-base`
}

/** 브랜치에 설정된 gh 기본 base. 없으면 null. */
export async function ghMergeBase(cwd: string, branch: string): Promise<string | null> {
  const r = await gitTry(cwd, ['config', '--get', ghMergeBaseKey(branch)])
  return r.ok && r.stdout ? r.stdout : null
}

/**
 * 브랜치의 gh 기본 base 를 base 로 맞춘다. base 가 null 이면 설정을 지워 gh 자신의 기본값
 * (리포 기본 브랜치)으로 되돌린다 — 부모가 병합돼 스택 뿌리로 내려온 브랜치가 여기 해당한다.
 * 이미 같은 값이면 아무것도 쓰지 않는다.
 */
export async function syncGhMergeBase(
  cwd: string,
  branch: string,
  base: string | null
): Promise<void> {
  const current = await ghMergeBase(cwd, branch)
  if (current === base) return
  if (base) await gitTry(cwd, ['config', ghMergeBaseKey(branch), base])
  else await gitTry(cwd, ['config', '--unset', ghMergeBaseKey(branch)])
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

// ── PR 리뷰용 worktree ──────────────────────────────────────────────────────
//
// 리뷰 대상은 남의 PR 이라 브랜치를 만들면 안 된다. 같은 브랜치가 이미 다른 worktree 에
// 체크아웃돼 있으면 git 이 거부하고(워크스페이스와 충돌), 로컬에 찌꺼기 브랜치도 남는다.
// 그래서 **detached HEAD** 로만 붙인다.

// 경로·ref 는 **리뷰 id** 로 키를 잡는다. PR 번호로 잡으면 같은 PR 을 두 번 리뷰할 때
// (예: 예전 리뷰를 아카이브해 두고 새로 시작) 두 세션이 같은 디렉토리와 ref 를 가리켜,
// 한쪽을 닫는 순간 다른 쪽의 워크트리와 ref 까지 지워진다.
// 경로에 PR 번호를 남기는 건 디렉토리를 눈으로 훑을 때 알아보기 위함이다.

/** 리뷰 worktree 경로. 워크스페이스 트리(`workspaces/`)와 완전히 분리한다. */
export function reviewWorktreePathFor(
  repoPath: string,
  prNumber: number,
  reviewId: string
): string {
  return join(wooiHome(), 'reviews', basename(repoPath), `pr-${prNumber}-${shortId(reviewId)}`)
}

/**
 * 이 리뷰의 레이어 하나가 붙잡아 둘 로컬 ref 이름. refs/heads 밖이라 브랜치 목록을 어지럽히지 않는다.
 *
 * 리뷰 하나가 PR 을 여러 개 볼 수 있으므로(스택 리뷰) 리뷰 id 아래에 PR 번호로 갈라 둔다.
 * 덕분에 정리는 `refs/wooi/review/<id>/` 네임스페이스를 통째로 지우는 것으로 끝난다.
 */
export function reviewRefFor(reviewId: string, prNumber: number): string {
  return `${reviewRefNamespace(reviewId)}/pr-${prNumber}`
}

/** 이 리뷰가 만든 모든 ref 의 접두사. */
export function reviewRefNamespace(reviewId: string): string {
  return `refs/wooi/review/${reviewId}`
}

/** UUID 를 경로에 쓸 만한 길이로 줄인다(구분에는 충분하다). */
function shortId(reviewId: string): string {
  return reviewId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'review'
}

/**
 * 리뷰가 보는 PR 들의 head 를 이 리뷰 전용 로컬 ref 로 **한 번의 fetch 로** 가져온다.
 *
 * GitHub 은 **fork 에서 온 PR 도** base 저장소의 `refs/pull/<n>/head` 로 공개한다. 덕분에
 * fork 리모트를 추가하지 않고도 origin 하나로 모든 PR 을 받을 수 있다.
 *
 * 스택이면 refspec 을 여러 개 넘긴다 — PR 마다 fetch 를 돌리면 5레이어 스택의 준비 시간이
 * 그대로 5배가 된다.
 */
export async function fetchPrHeads(
  repoPath: string,
  prNumbers: number[],
  reviewId: string
): Promise<boolean> {
  if (prNumbers.length === 0) return false
  const refspecs = prNumbers.map((n) => `+refs/pull/${n}/head:${reviewRefFor(reviewId, n)}`)
  const r = await gitTry(repoPath, ['fetch', '--no-tags', '--force', 'origin', ...refspecs])
  return r.ok
}

/** PR head 를 detached worktree 로 먼저 붙인 뒤 gh 가 정한 tracking 브랜치로 전환한다. */
export async function checkoutPrWorktree(
  repoPath: string,
  prNumber: number,
  worktreePath: string
): Promise<string> {
  const tempRef = `refs/wooi/pr-checkout/${prNumber}-${randomUUID()}`
  let worktreeAdded = false
  try {
    await git(repoPath, [
      'fetch',
      '--no-tags',
      '--force',
      'origin',
      `+refs/pull/${prNumber}/head:${tempRef}`
    ])
    await git(repoPath, ['worktree', 'add', '--detach', worktreePath, tempRef])
    worktreeAdded = true
    const { stderr, code } = await runGh(`gh pr checkout ${prNumber}`, worktreePath)
    if (code !== 0) throw new Error(stderr.trim() || `Failed to check out PR #${prNumber}.`)
    const branch = await git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (!branch || branch === 'HEAD') throw new Error(`PR #${prNumber} did not attach a branch.`)
    return branch
  } catch (error) {
    if (worktreeAdded) await removeWorktree(repoPath, worktreePath, '', false)
    throw error
  } finally {
    await gitTry(repoPath, ['update-ref', '-d', tempRef])
  }
}

/** detached HEAD 로 worktree 를 추가한다. */
export async function addDetachedWorktree(
  repoPath: string,
  worktreePath: string,
  ref: string
): Promise<void> {
  await git(repoPath, ['worktree', 'add', '--detach', worktreePath, ref])
}

/** 이미 있는 리뷰 worktree 를 새 ref 로 강제 이동시킨다(PR 에 새 커밋이 올라온 경우). */
export async function resetDetachedWorktree(worktreePath: string, ref: string): Promise<void> {
  await git(worktreePath, ['checkout', '--detach', '--force', ref])
  // 이전 리뷰에서 남은 잔여물을 지운다 — 리뷰 대상은 PR 상태 그대로여야 한다.
  await gitTry(worktreePath, ['clean', '-fd'])
}

/** 리뷰용 임시 ref 를 지운다. 이걸 지워야 해당 커밋이 GC 대상이 된다. */
export async function deleteRef(repoPath: string, ref: string): Promise<void> {
  await gitTry(repoPath, ['update-ref', '-d', ref])
}

/**
 * 이 리뷰가 만든 ref 를 전부 지운다.
 *
 * 레이어 목록을 인자로 받지 않고 **실제로 존재하는 ref 를 조회해** 지운다 — 레이어가 도중에
 * 바뀌었거나(스택이 자랐거나) 준비 중에 실패했을 때 남은 ref 를 놓치지 않기 위함이다.
 * 남으면 그 커밋이 영영 GC 되지 않는다.
 */
export async function deleteReviewRefs(repoPath: string, reviewId: string): Promise<void> {
  const ns = reviewRefNamespace(reviewId)
  const listed = await git(repoPath, ['for-each-ref', '--format=%(refname)', ns]).catch(() => '')
  const refs = listed
    .split('\n')
    .map((r) => r.trim())
    .filter(Boolean)
  // 옛 리뷰는 네임스페이스 자체가 ref 였다(refs/wooi/review/<id>). 그것도 함께 지운다.
  for (const ref of refs.length > 0 ? refs : [ns]) await deleteRef(repoPath, ref)
}

/** 사이드바 배지용 경량 상태 (브랜치, origin/base 우선 기준의 ahead/behind, 변경 파일 수). */
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
    const remoteBase = `origin/${baseBranch.replace(/^origin\//, '')}`
    // 15초 폴링의 공통 경로에 ref 확인 프로세스를 더하지 않는다. origin ref 로 바로 계산하고,
    // 리모트가 없는 리포에서만 같은 명령을 로컬 base 로 한 번 더 시도한다.
    const counts = await git(worktreePath, [
      'rev-list',
      '--left-right',
      '--count',
      `${remoteBase}...HEAD`
    ]).catch(() =>
      git(worktreePath, ['rev-list', '--left-right', '--count', `${baseBranch}...HEAD`])
    )
    const [b, a] = counts.split(/\s+/).map((n) => parseInt(n, 10))
    behind = Number.isFinite(b) ? b : 0
    ahead = Number.isFinite(a) ? a : 0
  } catch {
    // base 브랜치 ref 가 없으면 0 으로 둔다.
  }

  return { branch, ahead, behind, changedFiles, conflicted, rebasing: isRebasing(worktreePath) }
}

/**
 * base 대비 이 워크트리가 건드린 파일 경로들(커밋된 것 + 아직 커밋 안 한 것을 합친 집합).
 *
 * 둘 다 봐야 한다 — 옆 워크스페이스가 **방금 고쳤지만 아직 커밋하지 않은** 파일이 가장 위험하다.
 * 커밋된 것만 보면 그게 통째로 안 보인다.
 *
 * getStatus 와 같은 방식으로, base ref 가 없는 등의 실패는 조용히 빈 배열로 떨어뜨린다 — 남의
 * 워크스페이스를 훑는 조회라 하나가 실패했다고 전체를 세울 이유가 없다.
 */
export async function listChangedPaths(
  worktreePath: string,
  baseBranch: string
): Promise<string[]> {
  const paths = new Set<string>()

  const committed = await gitTry(worktreePath, ['diff', '--name-only', `${baseBranch}...HEAD`])
  if (committed.ok) {
    for (const line of committed.stdout.split('\n')) if (line.trim()) paths.add(line.trim())
  }

  const working = await gitTry(worktreePath, ['status', '--porcelain'])
  if (working.ok) {
    for (const line of working.stdout.split('\n')) {
      const path = parsePorcelainPath(line)
      if (path) paths.add(path)
    }
  }

  return [...paths]
}

/**
 * `git status --porcelain` 한 줄에서 경로만 뽑는다.
 * 형식은 `XY <path>` 이고, 이름이 바뀐 항목은 `R  <old> -> <new>` 로 온다(바뀐 뒤 이름을 쓴다).
 */
function parsePorcelainPath(line: string): string | null {
  if (line.length < 4) return null
  const rest = line.slice(3).trim()
  if (!rest) return null
  const arrow = rest.indexOf(' -> ')
  const path = arrow >= 0 ? rest.slice(arrow + 4) : rest
  // 공백이 든 경로는 git 이 따옴표로 감싼다.
  return path.replace(/^"(.*)"$/, '$1')
}

export function repoNameFromPath(path: string): string {
  return basename(path)
}

// ── PR 을 열기 전에 확인해야 하는 것들 ──────────────────────────────────────

/**
 * origin 에 이 브랜치가 이미 올라가 있는가. 아래 restack 의 remoteBranchExists 와 달리 로컬의
 * `origin/<branch>` ref 가 아니라 **origin 에 직접** 물어본다 — PR 을 열기 직전의 판단이라,
 * fetch 를 안 한 사이 다른 곳에서 올라간 브랜치를 "없다" 고 보면 헛된 push 를 시도하게 된다.
 *
 * 조회 자체가 실패하면(origin 없음·오프라인) false 로 떨어뜨린다 — 그러면 호출부가 push 를
 * 시도하고, 진짜 원인은 push 의 에러 메시지로 드러난다. 여기서 에러를 지어내는 것보다 구체적이다.
 */
export async function originHasBranch(worktreePath: string, branch: string): Promise<boolean> {
  const r = await gitTry(worktreePath, ['ls-remote', '--heads', 'origin', branch])
  return r.ok && r.stdout.length > 0
}

/**
 * 현재 브랜치를 origin 에 올리고 업스트림을 잡는다.
 *
 * 실패를 삼키지 않고 stderr 를 그대로 돌려주는 것이 요점이다 — 이 리포처럼 브랜치 이름 규칙
 * pre-push 훅이 걸린 곳에서는 그 문장이 "무엇을 어떻게 고쳐야 하는가" 그 자체다.
 */
export async function pushCurrentBranch(
  worktreePath: string
): Promise<{ ok: boolean; error: string }> {
  const target = await resolveBranchPushTarget(worktreePath)
  const refspec =
    target.destination === target.branch ? 'HEAD' : `HEAD:refs/heads/${target.destination}`
  const args = ['push', '-u', target.remote, refspec]
  const r = await gitTry(worktreePath, args)
  return { ok: r.ok, error: r.ok ? '' : r.stderr || r.stdout || 'git push failed.' }
}

interface BranchPushTarget {
  branch: string
  remote: string
  destination: string
}

/**
 * checkout 을 만든 주체가 기록한 tracking 설정을 push 의 단일 소스로 쓴다. 특히 fork PR 은
 * remote 이름 없이 URL 자체를 pushremote 로 남기므로, `origin` 으로 정규화하면 성공한 척 base
 * 리포에 동명 브랜치를 만드는 더 위험한 실패가 된다.
 *
 * ── 자동으로 붙은 tracking 은 목적지가 아니다 (실측) ──────────────────────────
 * tracking 설정을 남기는 주체가 `gh pr checkout` 만인 것은 아니다. Wooi 는 워크트리를
 * `git worktree add -b <branch> <path> origin/<default>` 로 만드는데, 시작점이 remote-tracking
 * ref 라 git 이 **스스로** upstream 을 걸어 준다(autoSetupMerge 기본값). 그래서 아직 한 번도
 * push 하지 않은 워크스페이스는 전부 `branch.<name>.merge = refs/heads/main` 을 들고 있다.
 *
 * 그걸 목적지로 읽으면 그 브랜치의 tip 이 **`main` 으로 force-push 된다**. 실측(2026-08-23,
 * stacked-pr-playground): 워크스페이스 커밋이 두 번 main 에 얹혔고, 미push 워크스페이스에서
 * 이 함수가 만드는 명령을 dry-run 하면 `+ 14ace7a...f71c618 HEAD -> main (forced update)` 로
 * **main 을 되감는다**. restack 버튼 한 번, PR 만들기 한 번으로 나갈 수 있는 경로였다.
 *
 * 그래서 "리포 자신(origin)의 기본 브랜치를 가리키는데 내 이름과 다르다" 면 자동으로 붙은
 * 것으로 보고 자기 브랜치로 떨어뜨린다. 진짜 fork PR 은 pushRemote(URL)를 들고 있어 걸리지
 * 않고, 같은 리포 PR 의 head 는 기본 브랜치일 수 없다(main→main PR 은 열리지 않는다).
 */
export async function resolveBranchPushTarget(worktreePath: string): Promise<BranchPushTarget> {
  const branch = await git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const config = async (key: string): Promise<string> => {
    const result = await gitTry(worktreePath, ['config', '--get', key])
    return result.ok ? result.stdout.trim() : ''
  }
  const pushRemote = await config(`branch.${branch}.pushRemote`)
  const remote = pushRemote || (await config(`branch.${branch}.remote`)) || 'origin'
  const merge = await config(`branch.${branch}.merge`)
  const destination = merge.startsWith('refs/heads/') ? merge.slice('refs/heads/'.length) : merge
  if (!destination || destination === branch) return { branch, remote, destination: branch }
  if (!pushRemote && remote === 'origin') {
    const defaultBranch = await detectDefaultBranch(worktreePath).catch(() => '')
    if (destination === defaultBranch) return { branch, remote, destination: branch }
  }
  return { branch, remote, destination }
}

/**
 * base 대비 HEAD 에만 있는 커밋 수. 0 이면 리뷰할 것이 없다는 뜻이다.
 *
 * 로컬 ref 가 없으면 origin/<base> 로 한 번 더 시도하고, 그래도 못 세면 null(판단 보류)이다 —
 * 세지 못했다는 이유만으로 PR 을 막지는 않는다.
 */
export async function countCommitsAhead(
  worktreePath: string,
  base: string
): Promise<number | null> {
  for (const ref of [base, `origin/${base}`]) {
    const r = await gitTry(worktreePath, ['rev-list', '--count', `${ref}..HEAD`])
    if (!r.ok) continue
    const n = parseInt(r.stdout, 10)
    if (Number.isFinite(n)) return n
  }
  return null
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

// ── restack (stacked PR: 부모 브랜치 위로 rebase) ─────────────────────────

/** 리모트에 같은 이름의 브랜치가 이미 있는지(origin/<branch>). force-push 대상 판단에 쓴다. */
async function remoteBranchOid(
  worktreePath: string,
  remote: string,
  destination: string
): Promise<string | null> {
  const result = await gitTry(worktreePath, [
    'ls-remote',
    '--heads',
    remote,
    `refs/heads/${destination}`
  ])
  if (!result.ok) return null
  return result.stdout.trim().split(/\s+/, 1)[0] || null
}

/**
 * `git push` 가 실패했을 때 사용자에게 보여 줄 한 줄을 stderr 에서 뽑는다.
 *
 * git 의 push stderr 는 길고, **진짜 사유는 끝이 아니라 끝에서 한두 줄 위에 있다**(실측):
 * pre-push 훅이 거부하면 훅이 stderr 에 뱉은 말 뒤에 `error: failed to push some refs to '<url>'`
 * 라는 상투구가 붙고, lease 가 어긋나면 `To <url>` / ` ! [rejected] ... (stale info)` / 같은
 * 상투구 순서로 붙는다. 그래서 상투구(`hint:`·`To <url>`·`failed to push some refs`)를 걷어낸 뒤
 * 남은 **마지막 두 줄**을 쓴다 — 거부는 대개 요약 한 줄과 상세 한 줄로 갈라져 오기 때문이다.
 */
export function summarizePushError(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && !/^\s*hint:/.test(l) && !/^To\s/.test(l))
  // 끝의 상투구는 어느 실패에나 붙는다. 그 앞줄이 진짜 사유다.
  while (lines.length > 1 && /failed to push some refs/.test(lines[lines.length - 1])) lines.pop()
  const tail = lines
    .slice(-2)
    .map((l) => l.trim())
    .join(' — ')
  if (!tail) return 'git push failed.'
  return tail.length > 300 ? `${tail.slice(0, 299)}…` : tail
}

/**
 * rebase 로 히스토리를 리라이트한 뒤 리모트에 반영한다. 리모트 브랜치가 있을 때만 `--force-with-lease`
 * 로 push 해(협업자가 그 사이 push 한 커밋을 덮어쓰지 않도록), 아직 push 되지 않은 브랜치는 건너뛴다.
 *
 * 실패 사유를 반드시 함께 돌려준다. 예전에는 `res.ok` 만 보고 stderr 를 버렸는데, 그러면 pre-push
 * 훅이 push 를 막아도 UI 는 "rebased" 라고만 말했다. 그 침묵은 나중에 오진으로 돌아온다 — 리모트가
 * 옛 커밋에 멈춰 있으니 다음 restack 이 갈라짐으로 읽고, 사용자는 "GitHub 이 다시 썼다"는 문구를
 * 믿고 `git reset --hard origin/<branch>` 로 rebase 결과를 버릴 뻔했다(실측).
 *
 * `pushed:false` 이면서 `error` 가 없으면 **일부러 건너뛴 것**이다(리모트에 아직 브랜치가 없음).
 *
 * 커밋 이동(commitMove.ts)도 이 함수를 그대로 쓴다 — 되쓴 뒤 리모트에 반영한다는 점이 restack 과
 * 같고, 자기만의 push 를 따로 만들면 fork·다른 destination 처리와 위 실패 보고가 곧바로 갈라진다.
 * 그래서 복제하지 않고 export 만 얹었다.
 */
export async function pushForceWithLease(
  worktreePath: string,
  branch: string
): Promise<{ pushed: boolean; error?: string }> {
  const target = await resolveBranchPushTarget(worktreePath)
  const expected = await remoteBranchOid(worktreePath, target.remote, target.destination)
  if (!expected) return { pushed: false }
  // 기존 Wooi 브랜치는 명령까지 그대로 둔다. URL remote 나 다른 destination 은 remote-tracking
  // ref 가 없을 수 있으므로, 방금 읽은 원격 SHA 를 lease 기대값으로 명시해야 동시 push 를 덮지 않는다.
  const legacyTarget = target.remote === 'origin' && target.destination === branch
  const args = legacyTarget
    ? ['push', '--force-with-lease', 'origin', branch]
    : [
        'push',
        `--force-with-lease=refs/heads/${target.destination}:${expected}`,
        target.remote,
        `HEAD:refs/heads/${target.destination}`
      ]
  const res = await gitTry(worktreePath, args)
  return res.ok ? { pushed: true } : { pushed: false, error: summarizePushError(res.stderr) }
}

/**
 * stacked 워크스페이스 브랜치를 최신 base(부모 브랜치) 위로 rebase 한다.
 * - 미커밋 변경이 있으면 시작하지 않는다('dirty').
 * - oldBase 를 주면 `git rebase --onto <base> <oldBase>` 로, 이 브랜치 고유 커밋만(=oldBase..HEAD)
 *   새 base 위로 옮긴다. 부모 PR 이 병합돼 자식을 조부모로 옮길 때(부모 커밋을 떨궈야 할 때) 쓴다.
 * - oldBase 가 없으면 부모가 새 커밋만 얹은 일반적인 경우로, 뒤처졌을 때만 `git rebase <base>` 한다.
 * - rebase 성공 후 리모트 브랜치가 있으면 force-with-lease 로 push 해 PR 을 갱신한다.
 * - 충돌 시 워킹트리를 rebase 진행 상태로 남기고 충돌 파일을 돌려준다(해결 후 계속하거나 abortRebase).
 */
export async function restackOnto(
  worktreePath: string,
  baseBranch: string,
  oldBase?: string
): Promise<RestackResult> {
  const dirty = (await git(worktreePath, ['status', '--porcelain']).catch(() => '')).trim()
  if (dirty) {
    return {
      status: 'dirty',
      baseBranch,
      message: 'Commit or stash your changes before restacking.'
    }
  }

  // 최신 origin 을 가져온 뒤 origin/<base>(없으면 로컬 base)를 rebase 대상으로 삼는다.
  await fetchRemote(worktreePath)
  const onto = await resolveBaseStartPoint(worktreePath, baseBranch)
  const branch = await git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')

  const behind = await git(worktreePath, ['rev-list', '--count', `HEAD..${onto}`])
    .then((s) => parseInt(s, 10) || 0)
    .catch(() => 0)

  const needsRebase = oldBase ? true : behind > 0
  if (needsRebase) {
    const rebaseArgs = oldBase ? ['rebase', '--onto', onto, oldBase] : ['rebase', onto]
    const rebase = await gitTry(worktreePath, rebaseArgs)
    if (!rebase.ok) {
      const conflicts = await git(worktreePath, ['diff', '--name-only', '--diff-filter=U']).catch(
        () => ''
      )
      const conflictedFiles = parseGitPathList(conflicts)
      if (conflictedFiles.length) return { status: 'conflict', baseBranch, conflictedFiles }
      // 충돌이 아닌 다른 실패 — rebase 를 깔끔히 되돌리고 메시지를 전달한다.
      await abortRebase(worktreePath)
      return {
        status: 'error',
        baseBranch,
        message: rebase.stderr || 'Failed to rebase onto base.'
      }
    }
  }

  // push 가 막혀도 rebase 자체는 성공했다 — status 는 그대로 두고 사유만 실어 보낸다. status 를
  // 'error' 로 바꾸면 호출부가 "히스토리가 안 옮겨졌다"로 읽어 되돌리려 든다(사실은 옮겨졌다).
  const push = await pushForceWithLease(worktreePath, branch)
  const pushError = push.error ? { pushError: push.error } : {}
  // rebase 도 필요 없었고 push 도 건너뛴(=리모트에 브랜치가 없는) 경우만 진짜 "할 일 없음"이다.
  // push 를 시도했다가 거부당했다면 그건 알려야 할 일이다.
  if (!needsRebase && !push.pushed) {
    if (!push.error) return { status: 'up-to-date', baseBranch }
    // base 기준으로는 정말 최신이지만, 아직 push 되지 않은 커밋을 밀어 넣으려다 거부당했다.
    return { status: 'up-to-date', baseBranch, pushed: false, ...pushError }
  }
  return { status: 'restacked', baseBranch, pushed: push.pushed, ...pushError }
}

// ── 리모트 tip 조회 (캐스케이드 갈라짐 판정용) ────────────────────────────
// 여기서 `origin/<branch>`(리모트 추적 ref)를 쓰지 않는 것이 요점이다. 그건 마지막 fetch 시점의
// 사진이라, "내가 모르는 사이에 리모트가 바뀌었나"라는 바로 그 질문에는 답할 수 없다.
// `ls-remote` 는 객체를 받아오지 않고 ref 만 물어보므로 fetch 보다 훨씬 싸다.

/** 리모트(origin)가 지금 들고 있는 브랜치 tip sha. 브랜치가 없거나 조회에 실패하면 null. */
export async function remoteTipSha(worktreePath: string, branch: string): Promise<string | null> {
  if (!branch) return null
  const res = await gitTry(worktreePath, ['ls-remote', '--heads', 'origin', branch])
  if (!res.ok) return null
  const sha = res.stdout.split('\n')[0]?.split('\t')[0]?.trim()
  return sha && /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null
}

/**
 * `origin/<branch>` 리모트 추적 ref 를 **마지막으로 움직인 항목**(새 sha + 리플로그 사유). 리플로그가
 * 없거나 ref 자체가 없으면 null.
 *
 * 갈라짐의 원인을 가르는 데 쓴다. 리모트 tip 이 로컬의 조상이 아니라는 사실만으로는 "남이 리모트를
 * 다시 썼다" 와 "내 지난 push 가 실패해 로컬만 앞섰다" 를 구분할 수 없는데, 대처는 정반대다.
 * 리플로그가 그 구분을 준다(실측, git 2.50):
 * - 우리 push 가 성공하면 항목이 하나 붙고 사유는 정확히 `update by push` 다.
 * - push 가 **실패하면 항목이 붙지 않는다**(pre-push 훅은 연결 전에 끊고, 거부는 ref 를 안 옮긴다).
 * - 리모트가 우리 밖에서 움직인 뒤 fetch 하면 사유는 `fetch <args>: forced-update`(또는
 *   `fast-forward`)다 — 서버가 쓴 sha 는 우리 리플로그에 push 로 남을 수 없다.
 * - 값이 그대로면 fetch 는 항목을 남기지 않는다. 그래서 restackOnto 의 fetch 가 이 판정을 흐리지 않는다.
 *
 * `remoteTipSha` 와 같은 이유로 리모트 이름은 origin 으로 고정한다(둘이 같은 ref 를 봐야 뜻이 있다).
 * 리플로그는 워크트리가 아니라 저장소 공통 디렉터리에 있으므로 어느 워크트리에서 물어도 같은 답이다.
 */
export async function lastRemoteRefUpdate(
  worktreePath: string,
  branch: string
): Promise<{ sha: string; reason: string } | null> {
  if (!branch) return null
  const res = await gitTry(worktreePath, [
    'reflog',
    'show',
    '--no-abbrev',
    '-n',
    '1',
    '--format=%H%x09%gs',
    `refs/remotes/origin/${branch}`
  ])
  if (!res.ok) return null
  const [sha, ...rest] = res.stdout.split('\n')[0]?.split('\t') ?? []
  if (!sha || !/^[0-9a-f]{40}$/i.test(sha.trim())) return null
  return { sha: sha.trim(), reason: rest.join('\t').trim() }
}

/** 이 저장소가 그 커밋을 알고 있는지. 모르면 리모트가 우리에게 없는 히스토리를 들고 있다는 뜻이다. */
export async function hasCommit(worktreePath: string, sha: string): Promise<boolean> {
  if (!sha) return false
  return (await gitTry(worktreePath, ['cat-file', '-e', `${sha}^{commit}`])).ok
}

/** a 가 b 의 조상인지(같아도 true). */
export async function isAncestor(worktreePath: string, a: string, b: string): Promise<boolean> {
  return (await gitTry(worktreePath, ['merge-base', '--is-ancestor', a, b])).ok
}

/** 진행 중인 rebase 를 취소해 워크스페이스를 rebase 직전 상태로 되돌린다(충돌 포기용). */
export async function abortRebase(worktreePath: string): Promise<void> {
  await git(worktreePath, ['rebase', '--abort']).catch(() => {})
}

// ── 모델 B: worktree 내부 브랜치 스택 (단일 worktree · N 브랜치) ────────────

/** 워킹트리에 미커밋 변경이 없는지(브랜치 전환 안전 여부 판단). */
export async function isWorktreeClean(worktreePath: string): Promise<boolean> {
  const dirty = (await git(worktreePath, ['status', '--porcelain']).catch(() => 'x')).trim()
  return dirty === ''
}

/** worktree 의 현재 HEAD 브랜치 이름. */
export async function currentBranch(worktreePath: string): Promise<string> {
  return git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')
}

/** ref(브랜치/커밋)의 커밋 sha. 없으면 null. 스택 restack 전 각 브랜치의 이전 tip 을 잡아 둘 때 쓴다. */
export async function revParse(worktreePath: string, ref: string): Promise<string | null> {
  return git(worktreePath, ['rev-parse', '--verify', '--quiet', ref]).catch(() => null)
}

/**
 * worktree 를 다른(이미 존재하는) 브랜치로 체크아웃 전환한다(모델 B 스택 내 이동).
 * 미커밋 변경이 있으면 전환하지 않고 실패를 반환한다(먼저 커밋/스태시 필요).
 */
export async function checkoutBranch(
  worktreePath: string,
  branch: string
): Promise<{ error?: string }> {
  if (!(await isWorktreeClean(worktreePath))) {
    return { error: 'Commit or stash your changes before switching branches.' }
  }
  const res = await gitTry(worktreePath, ['checkout', branch])
  if (!res.ok) return { error: res.stderr || `Failed to switch to "${branch}".` }
  return {}
}

// ── diff (변경 검토용) ───────────────────────────────────────────────────

const UNTRACKED_MAX_BYTES = 512 * 1024

/**
 * base 브랜치 대비 workspace 의 전체 변경을 파일별로 반환한다.
 * 추적 파일은 `git diff <base>`(커밋 + staged + unstaged 를 한 번에 반영)로,
 * 신규(untracked) 파일은 별도로 합쳐 "추가됨" 으로 표시한다.
 */
export async function getDiff(worktreePath: string, baseBranch: string): Promise<WorkspaceDiff> {
  // 워크트리에서는 로컬 base 브랜치를 체크아웃하지 않으므로 그 ref가 오래된 채로 남기 쉽다.
  // fetch 된 origin ref를 우선 써서 Changes가 실제 원격 base와 같은 기준을 보게 한다.
  const baseRef = await resolveBaseStartPoint(worktreePath, baseBranch)
  // base 가 분기 이후 전진했어도 base 의 새 커밋이 역방향 변경으로 보이지 않도록,
  // base..HEAD 의 공통 조상(merge-base)을 기준으로 working tree 와 비교한다(PR diff 와 동일 의미).
  const from = await git(worktreePath, ['merge-base', baseRef, 'HEAD']).catch(() => baseRef)

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
  return { baseBranch: baseRef, files }
}

/** 커밋 목록과 변경 파일 목록. 어느 쪽이든 잘렸으면 omitted 에 남는다. */
export interface BranchSummary {
  /** "d86b7e2 feat: 계산 엔진 구현" 형태, 최신이 먼저. */
  commits: string[]
  /** "src/calc.js (+82 −4)" 형태, 변경량이 큰 것이 먼저. */
  files: string[]
  omittedCommits: number
  omittedFiles: number
}

// 인계 메시지에 실릴 크기라 상한을 둔다. 리팩터 한 번에 200개 파일이 바뀌는 브랜치가 있고,
// 그걸 다 적으면 정작 읽어야 할 작업 지시가 목록에 묻힌다.
const SUMMARY_MAX_COMMITS = 20
const SUMMARY_MAX_FILES = 40

/**
 * 브랜치가 base 이후로 무엇을 했는지 한 눈에 보이게 요약한다.
 *
 * 스택 인계에 쓴다 — 자식은 부모의 커밋된 tip 에서 갈라지므로, 이 요약이 곧 "네가 물려받은
 * 코드에 이미 들어 있는 것" 이다. 모델을 부르지 않고 git 으로만 만들기 때문에 정확하고 공짜다.
 *
 * base 가 분기 후 전진했어도 base 쪽 커밋이 섞이지 않도록 merge-base 를 기준으로 삼는다
 * (getDiff 와 같은 이유·같은 방식).
 *
 * 요약할 것이 없거나 git 이 실패하면 null — 인계는 요약 없이도 성립해야 하므로 던지지 않는다.
 */
/**
 * 분기점을 고른다 — 로컬 base ref 와 그 upstream 중 **더 최근**을 쓴다.
 *
 * Wooi 의 워크트리는 base 브랜치를 절대 체크아웃하지 않으므로 로컬 `main` 은 대개 낡아 있다.
 * 그 낡은 ref 로만 merge-base 를 잡으면, 워크스페이스가 base 에서 당겨 온 커밋들이 "이 브랜치가
 * 한 일" 로 둔갑한다(실측: 로컬 main 이 한 커밋 뒤처져 릴리즈 커밋이 브랜치 몫으로 잡혔다).
 * 자식에게 남의 작업을 물려준 것처럼 알려 주는 셈이라, 요약의 쓸모가 바로 무너진다.
 *
 * resolveBaseStartPoint 처럼 `origin/<base>` 를 무조건 우선하지 않는다 — 리모트가 로컬보다
 * 뒤처진 경우(아직 push 안 한 부모 브랜치 위에 쌓기)에는 그쪽이 틀리기 때문에, 어느 쪽이든
 * **뒤에 있는 분기점**을 고르게 둔다.
 */
async function branchPoint(worktreePath: string, baseBranch: string): Promise<string | null> {
  const upstream = await git(worktreePath, [
    'rev-parse',
    '--abbrev-ref',
    `${baseBranch}@{upstream}`
  ]).catch(() => null)

  const candidates = [baseBranch, ...(upstream ? [upstream] : [])]
  const points = (
    await Promise.all(
      candidates.map((ref) => git(worktreePath, ['merge-base', ref, 'HEAD']).catch(() => null))
    )
  ).filter((p): p is string => !!p)

  let best: string | null = null
  for (const point of points) {
    // best 가 point 의 조상이면 point 쪽이 더 앞선 분기점이다.
    if (!best || (await gitTry(worktreePath, ['merge-base', '--is-ancestor', best, point])).ok) {
      best = point
    }
  }
  return best
}

/** base..HEAD 커밋을 최신 먼저로 돌려준다. merge 커밋은 레이어 사이 이동 대상에서 뺀다. */
export async function listCommits(
  worktreePath: string,
  baseBranch: string,
  limit?: number
): Promise<CommitEntry[]> {
  const from = await branchPoint(worktreePath, baseBranch)
  if (!from) return []
  const args = [
    'log',
    '--no-merges',
    '--format=%H%x1f%h%x1f%an%x1f%at%x1f%s',
    ...(limit === undefined ? [] : ['-n', String(Math.max(0, limit))]),
    `${from}..HEAD`
  ]
  const out = await git(worktreePath, args)
  if (!out) return []
  return out.split('\n').map((line) => {
    const [sha, shortSha, authorName, authoredAt, subject] = line.split('\x1f')
    return { sha, shortSha, authorName, authoredAt: Number(authoredAt) * 1000, subject }
  })
}

/** 커밋 하나가 건드린 경로. rename 은 Git 이 최종 경로 하나로 표현하게 둔다. */
export async function commitChangedPaths(worktreePath: string, sha: string): Promise<string[]> {
  const out = await git(worktreePath, [
    'diff-tree',
    '--no-commit-id',
    '--name-only',
    '-r',
    '--root',
    sha
  ])
  return out.split('\n').filter(Boolean)
}

/** sha 가 실제 레이어 범위에 속한 비-merge 커밋인지 확인한다. */
export async function commitInRange(
  worktreePath: string,
  baseBranch: string,
  sha: string
): Promise<boolean> {
  const from = await branchPoint(worktreePath, baseBranch)
  if (!from || !(await hasCommit(worktreePath, sha))) return false
  const inRange = await gitTry(worktreePath, ['merge-base', '--is-ancestor', sha, 'HEAD'])
  if (!inRange.ok || (await isAncestor(worktreePath, sha, from))) return false
  const parents = await git(worktreePath, ['rev-list', '--parents', '-n', '1', sha]).catch(() => '')
  return parents.split(/\s+/).filter(Boolean).length === 2
}

/** 충돌 경로를 반환한다. 충돌이 아닌 명령 실패에서는 빈 배열이다. */
async function conflictedPaths(worktreePath: string): Promise<string[]> {
  const out = await git(worktreePath, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')
  return out.split('\n').filter(Boolean)
}

/**
 * 위층 커밋 하나를 아래층으로 옮기되 리모트에는 손대지 않는다.
 *
 * 첫 cherry-pick 성공을 확인하기 전에는 위층 히스토리를 절대 건드리지 않는다. 이 경계가 흐려지면
 * 아래층 반영 실패 뒤에도 drop 단계가 진행되어 커밋이 양쪽 브랜치에서 사라질 수 있다. 실패 뒤에는
 * 각 정리 명령의 종료 코드뿐 아니라 tip·clean 상태까지 확인해, 복구되지 않은 상태를 성공처럼 숨기지 않는다.
 */
export async function moveCommitDownLocal(opts: {
  lowerWorktree: string
  lowerBranch: string
  upperWorktree: string
  upperBranch: string
  sha: string
}): Promise<
  | { ok: true; lowerTip: string; upperTip: string }
  | {
      ok: false
      step: CommitMoveStep
      conflictedFiles: string[]
      message: string
      rolledBack: boolean
    }
> {
  const { lowerWorktree, lowerBranch, upperWorktree, upperBranch, sha } = opts
  const lowerTip = await revParse(lowerWorktree, lowerBranch)
  const upperTip = await revParse(upperWorktree, upperBranch)
  const shortSha = sha.slice(0, 12)
  const temporary = `wooi/commit-move-${shortSha}`
  if (!lowerTip || !upperTip) {
    return {
      ok: false,
      step: 'cherry-pick',
      conflictedFiles: [],
      message: 'Could not record both branch tips before moving the commit.',
      rolledBack: true
    }
  }
  if (!(await isWorktreeClean(lowerWorktree)) || !(await isWorktreeClean(upperWorktree))) {
    return {
      ok: false,
      step: 'cherry-pick',
      conflictedFiles: [],
      message: 'Commit or stash your changes before moving a commit.',
      rolledBack: true
    }
  }
  if (
    (await currentBranch(lowerWorktree)) !== lowerBranch ||
    (await currentBranch(upperWorktree)) !== upperBranch
  ) {
    return {
      ok: false,
      step: 'cherry-pick',
      conflictedFiles: [],
      message: 'Both stack branches must be checked out in their own worktrees.',
      rolledBack: true
    }
  }

  const rollback = async (): Promise<boolean> => {
    await gitTry(upperWorktree, ['rebase', '--abort'])
    await gitTry(upperWorktree, ['checkout', upperBranch])
    await gitTry(upperWorktree, ['reset', '--hard', upperTip])
    await gitTry(upperWorktree, ['branch', '-D', temporary])
    await gitTry(lowerWorktree, ['cherry-pick', '--abort'])
    await gitTry(lowerWorktree, ['reset', '--hard', lowerTip])
    const [lowerNow, upperNow, lowerClean, upperClean, upperCurrent, temp] = await Promise.all([
      revParse(lowerWorktree, lowerBranch),
      revParse(upperWorktree, upperBranch),
      isWorktreeClean(lowerWorktree),
      isWorktreeClean(upperWorktree),
      currentBranch(upperWorktree),
      revParse(upperWorktree, temporary)
    ])
    return (
      lowerNow === lowerTip &&
      upperNow === upperTip &&
      lowerClean &&
      upperClean &&
      upperCurrent === upperBranch &&
      temp === null
    )
  }
  const failed = async (
    step: CommitMoveStep,
    result: { stderr: string }
  ): Promise<Extract<Awaited<ReturnType<typeof moveCommitDownLocal>>, { ok: false }>> => {
    const conflicts = await conflictedPaths(step === 'cherry-pick' ? lowerWorktree : upperWorktree)
    const rolledBack = await rollback()
    const recovery = rolledBack
      ? ''
      : ` Automatic rollback failed. Recover manually with '${lowerBranch}' at ${lowerTip} and '${upperBranch}' at ${upperTip}.`
    return {
      ok: false,
      step,
      conflictedFiles: conflicts,
      message: (result.stderr || 'Git could not move the commit.') + recovery,
      rolledBack
    }
  }

  const picked = await gitTry(lowerWorktree, ['cherry-pick', sha])
  if (!picked.ok) return failed('cherry-pick', picked)
  const newLowerTip = await revParse(lowerWorktree, lowerBranch)
  if (!newLowerTip) return failed('cherry-pick', { stderr: 'Could not read the new lower tip.' })

  const parent = `${sha}^`
  const madeBranch = await gitTry(upperWorktree, ['branch', temporary, parent])
  if (!madeBranch.ok) return failed('replay-below', madeBranch)
  const checkedOut = await gitTry(upperWorktree, ['checkout', temporary])
  if (!checkedOut.ok) return failed('replay-below', checkedOut)
  const below = await gitTry(upperWorktree, ['rebase', '--onto', newLowerTip, lowerTip, temporary])
  if (!below.ok) return failed('replay-below', below)
  const middle = await revParse(upperWorktree, 'HEAD')
  if (!middle) return failed('replay-below', { stderr: 'Could not read the replayed lower range.' })

  const above = await gitTry(upperWorktree, ['rebase', '--onto', middle, sha, upperBranch])
  if (!above.ok) return failed('replay-above', above)
  const cleanup = await gitTry(upperWorktree, ['branch', '-D', temporary])
  if (!cleanup.ok) return failed('cleanup', cleanup)
  const newUpperTip = await revParse(upperWorktree, upperBranch)
  if (!newUpperTip) return failed('cleanup', { stderr: 'Could not read the new upper tip.' })
  return { ok: true, lowerTip: newLowerTip, upperTip: newUpperTip }
}

export async function summarizeBranch(
  worktreePath: string,
  baseBranch: string
): Promise<BranchSummary | null> {
  const from = await branchPoint(worktreePath, baseBranch)
  if (!from) return null

  const range = `${from}..HEAD`
  const log = await gitTry(worktreePath, ['log', '--oneline', '--no-decorate', range])
  const numstat = await gitTry(worktreePath, ['diff', '--numstat', range])
  if (!log.ok && !numstat.ok) return null

  const allCommits = log.stdout.split('\n').filter(Boolean)

  // --numstat 은 "추가\t삭제\t경로". 바이너리는 추가/삭제가 "-" 로 오므로 숫자 대신 그대로 쓴다.
  const parsed = numstat.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [added = '', deleted = '', ...rest] = line.split('\t')
      const path = rest.join('\t')
      const churn = (Number(added) || 0) + (Number(deleted) || 0)
      const counts = added === '-' || deleted === '-' ? 'binary' : `+${added} −${deleted}`
      return { path, churn, label: `${path} (${counts})` }
    })
    .filter((f) => f.path)
    // 변경량이 큰 파일이 대개 그 브랜치의 요점이다 — 잘릴 때 남아야 할 쪽이다.
    .sort((a, b) => b.churn - a.churn)

  if (!allCommits.length && !parsed.length) return null

  return {
    commits: allCommits.slice(0, SUMMARY_MAX_COMMITS),
    files: parsed.slice(0, SUMMARY_MAX_FILES).map((f) => f.label),
    omittedCommits: Math.max(0, allCommits.length - SUMMARY_MAX_COMMITS),
    omittedFiles: Math.max(0, parsed.length - SUMMARY_MAX_FILES)
  }
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

      // hunk 안에서만 센다. 접두사만 보고 `+++`/`---` 를 헤더로 걸러 내면, diff 파일 자체를
      // 커밋할 때처럼 **본문이 `+++` 로 시작하는 줄**(= `++++`)까지 함께 빠져 숫자가 어긋난다.
      // 헤더는 hunk 시작(`@@`) 앞에만 오므로, 위치로 가르는 편이 정확하고 더 싸다.
      let additions = 0
      let deletions = 0
      let inHunk = false
      for (const l of lines) {
        if (l.startsWith('@@')) {
          inHunk = true
          continue
        }
        if (!inHunk) continue
        // "\ No newline at end of file" 은 어느 쪽도 아니다.
        if (l.startsWith('+')) additions++
        else if (l.startsWith('-')) deletions++
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
