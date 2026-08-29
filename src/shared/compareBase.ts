import type { WorkspaceCompareBase } from './types'

/**
 * "지금 무엇과 비교해 보고 있는가" 를 사용자가 뒤집을 수 있게 하는 값.
 *
 * ⚠️ **이 값은 diff 표시에만 쓴다. PR 대상도, rebase 대상도 여기서 나오지 않는다.**
 *
 * Wooi 는 스택 PR 이 중심 기능이라 이 경계가 특히 위험하다 — "비교 기준을 origin/main 으로
 * 바꿨다" 를 "내 PR 이 이제 main 을 향한다" 로 읽으면 스택 전체가 어긋난 것처럼 보인다. 그래서
 * 실제 base 는 예전 그대로 `Workspace.baseBranch` / `StackedBranch.baseBranch` / GitHub 의
 * `baseRefName` 만 소유하고, 이 파일의 값은 `IPC.gitDiff` 한 경로에서만 읽힌다. UI 문구도 그
 * 경계를 그대로 말한다.
 *
 * 전역 설정으로 두지 않는 이유: "이 워크스페이스를 지금 무엇과 견줄까" 는 워크스페이스마다 다른
 * 질문이고, 스택 3층 중 한 층에서만 궁금한 일이 대부분이다. 앱 전체 스위치로 만들면 정작 필요한
 * 자리에서 매번 켜고 끄게 된다.
 */
export type { WorkspaceCompareBase }

/** 저장된 값이 없을 때의 기준 — 지금까지의 자동 판정 그대로다. */
export const DEFAULT_COMPARE_BASE: WorkspaceCompareBase = 'stack-parent'

export function normalizeCompareBase(value: unknown): WorkspaceCompareBase {
  return value === 'default-branch' ? 'default-branch' : DEFAULT_COMPARE_BASE
}

/**
 * diff 를 뜰 때 쓸 브랜치 이름을 고른다.
 *
 * `origin/` 을 붙일지 말지는 여기서 정하지 않는다 — 그건 `resolveBaseStartPoint` 가 리모트
 * 유무를 보고 하던 일이고, 그 판단은 어느 쪽을 고르든 그대로 적용돼야 한다.
 */
export function compareBaseBranch(opts: {
  /** 이 워크스페이스의 진짜 base(스택 부모이거나, 스택 뿌리면 기본 브랜치). */
  baseBranch: string
  /** 리포의 origin 기본 브랜치. */
  defaultBranch: string
  compareBase?: WorkspaceCompareBase | null
}): string {
  return normalizeCompareBase(opts.compareBase) === 'default-branch'
    ? opts.defaultBranch
    : opts.baseBranch
}

/**
 * 고를 것이 실제로 두 개인지. 스택 뿌리 워크스페이스는 base 가 이미 기본 브랜치라 두 선택지가
 * 같은 곳을 가리킨다 — 그럴 땐 아무것도 바꾸지 못하는 메뉴를 띄우지 않는다.
 */
export function offersCompareBaseChoice(baseBranch: string, defaultBranch: string): boolean {
  return stripOrigin(baseBranch) !== stripOrigin(defaultBranch)
}

function stripOrigin(ref: string): string {
  return ref.replace(/^origin\//, '')
}
