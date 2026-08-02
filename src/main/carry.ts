import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { CarryFailure, CarryItem } from '@shared/types'
import { validateCarryPath } from '@shared/carryPath'
import { log } from './logger'

const exec = promisify(execFile)

/**
 * worktree 는 `git worktree add` 결과 그대로라 git 이 추적하지 않는 파일이 하나도 딸려오지 않는다.
 * 이 모듈은 리포별로 지정된 전달 목록([[types]] CarryItem)을 새 worktree 에 복사/심링크한다.
 *
 * 삭제 안전성: worktree 제거는 전부 `git worktree remove --force` 한 경로로 수렴하는데
 * (git.ts removeWorktree), git 은 심링크를 unlink 만 하고 타겟을 따라가지 않는다.
 * 즉 여기서 만든 심링크 때문에 메인 체크아웃의 원본이 지워지는 일은 없다 —
 * carry.test.ts 가 실제 리포로 이 보장을 회귀 테스트한다.
 */

/**
 * 에이전트 컨텍스트로 분류되는 경로.
 *
 * 이 부류는 없어도 에러가 나지 않고 그저 에이전트가 지침을 못 읽은 채 다르게 동작하므로,
 * 전달 실패를 조용히 넘기면 안 된다(호출 측이 토스트로 알린다).
 */
const AGENT_CONTEXT_RE =
  /(^|\/)(CLAUDE([.\w-]*)?\.md|AGENTS?\.md|MEMORY\.md|\.cursorrules|\.claude(\/|$))/i

export function isAgentContextPath(path: string): boolean {
  return AGENT_CONTEXT_RE.test(path)
}

/**
 * 리포 추가 시 목록을 미리 채우기 위해 탐지하는 흔한 파일들.
 * 빈 목록으로 시작하면 사용자가 기능의 존재를 모른 채 "왜 에이전트가 규칙을 안 지키지?" 를
 * 계속 겪게 되므로, 실제로 존재하는 것만 골라 안전한 copy 모드로 미리 등록한다.
 */
const CANDIDATE_PATHS = [
  'CLAUDE.local.md',
  'AGENT.md',
  'AGENTS.md',
  'MEMORY.md',
  '.claude/settings.local.json',
  '.env',
  '.env.local'
]

export function detectCarryItems(repoPath: string): CarryItem[] {
  return CANDIDATE_PATHS.filter((p) => existsSync(join(repoPath, p))).map((path) => ({
    path,
    mode: 'copy' as const
  }))
}

// 경로 검증은 renderer(설정 모달의 인라인 오류)와 공유해야 하므로 shared 에 산다.
// 여기서 재수출해 기존 import 경로(main/carry)를 그대로 유지한다.
export { validateCarryPath, type CarryPathResult } from '@shared/carryPath'

export interface CarryOutcome {
  /** 실제로 전달된 경로들 — gitignore 보정(info/exclude)에 쓴다. */
  carried: string[]
  failures: CarryFailure[]
}

/**
 * 전달 목록을 worktree 로 옮긴다. **셋업 스크립트 실행 전에** 끝나야 한다 —
 * 셋업이 `.env` 를 읽거나, 심링크된 `node_modules` 를 보고 설치를 건너뛸 수 있어야 하기 때문.
 *
 * 개별 항목 실패는 워크스페이스 생성을 막지 않는다(요구사항 3). 원본에 파일이 없으면
 * 실패가 아니라 정상적인 "해당 없음" 이므로 조용히 건너뛴다(요구사항 2).
 */
export function carryIntoWorktree(
  repoPath: string,
  worktreePath: string,
  items: CarryItem[]
): CarryOutcome {
  const carried: string[] = []
  const failures: CarryFailure[] = []

  for (const item of items) {
    const checked = validateCarryPath(item.path)
    if (!checked.ok) {
      failures.push({
        path: item.path,
        reason: checked.reason,
        agentContext: isAgentContextPath(item.path)
      })
      continue
    }
    const rel = checked.path
    const src = join(repoPath, rel)
    const dest = join(worktreePath, rel)

    // 원본이 없으면 조용히 건너뛴다 — 리포마다 있는 파일이 다르고, 없다고 해서
    // 워크스페이스 생성을 실패시킬 이유가 없다.
    if (!existsSync(src)) continue

    // worktree 에 이미 있으면(= git 이 추적하는 파일) 덮어쓰지 않는다.
    // 커밋된 내용을 메인 체크아웃의 로컬 상태로 조용히 갈아치우는 건 예상 밖의 동작이다.
    if (existsSync(dest) || isSymlink(dest)) continue

    try {
      mkdirSync(dirname(dest), { recursive: true })
      if (item.mode === 'link') {
        // 절대 경로로 링크한다 — worktree 는 리포와 완전히 다른 디렉토리 트리에 있어
        // (`~/wooi/workspaces/...`) 상대 링크는 이동·아카이브 시 쉽게 깨진다.
        symlinkSync(src, dest)
      } else {
        // dereference: 원본이 심링크여도 실체를 복사해, worktree 사본이 원본과 독립적이게 한다.
        cpSync(src, dest, { recursive: true, dereference: true, preserveTimestamps: true })
      }
      carried.push(rel)
    } catch (err) {
      failures.push({
        path: rel,
        reason: err instanceof Error ? err.message : String(err),
        agentContext: isAgentContextPath(rel)
      })
    }
  }

  return { carried, failures }
}

/** existsSync 는 끊어진 심링크에 false 를 주므로, 링크 자체의 존재는 lstat 으로 따로 본다. */
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * 전달한 경로가 worktree 에서 무시되지 않으면 `info/exclude` 에 추가한다.
 *
 * 왜 필요한가: `.gitignore` 의 `node_modules/` 처럼 슬래시로 끝나는 패턴은 **심링크에 매칭되지
 * 않는다** — git 은 심링크를 디렉토리가 아닌 파일로 보기 때문. 그래서 디렉토리를 link 모드로
 * 가져오면 해당 worktree 가 영구히 dirty 상태가 되고 사이드바 변경 파일 배지까지 오염된다.
 *
 * 주의: git 은 `info/exclude` 를 worktree 별로 두지 못하고 **공용 git 디렉토리 것만** 읽는다
 * (worktree 전용 gitdir 에 넣어도 무시된다 — 실측 확인). 그래서 기록 위치는 메인 리포의
 * `.git/info/exclude` 다. 커밋되지 않는 로컬 전용 파일이라 팀에 영향은 없고, 실제로 무시되지
 * 않는 항목만 골라 추가하므로 이미 gitignore 된 경로에는 아무것도 쓰지 않는다.
 */
export async function applyCarryExcludes(worktreePath: string, carried: string[]): Promise<void> {
  if (carried.length === 0) return

  const needed: string[] = []
  for (const rel of carried) {
    // check-ignore 는 무시되면 exit 0, 아니면 exit 1 — 후자만 보정 대상이다.
    const ignored = await exec('git', ['check-ignore', '-q', '--', rel], { cwd: worktreePath })
      .then(() => true)
      .catch(() => false)
    if (!ignored) needed.push(`/${rel}`)
  }
  if (needed.length === 0) return

  try {
    const commonDir = await exec(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: worktreePath }
    ).then((r) => r.stdout.trim())
    if (!commonDir) return

    const excludePath = join(commonDir, 'info', 'exclude')
    mkdirSync(dirname(excludePath), { recursive: true })
    const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf-8') : ''
    const lines = new Set(existing.split('\n').map((l) => l.trim()))
    const missing = needed.filter((p) => !lines.has(p))
    if (missing.length === 0) return

    const header = existing.endsWith('\n') || existing === '' ? '' : '\n'
    appendFileSync(
      excludePath,
      `${header}# wooi: carried into worktrees (not committed)\n${missing.join('\n')}\n`,
      'utf-8'
    )
  } catch (err) {
    // 보정 실패는 status 가 지저분해질 뿐이라 워크스페이스 생성을 막지 않는다.
    log.warn(`info/exclude 보정 실패: ${err instanceof Error ? err.message : String(err)}`)
  }
}
