import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isAllowedBranchName, TYPES } from '../../scripts/branch-name-rule.mjs'
import { ADJECTIVES, ANIMALS } from './names'

/**
 * Wooi 가 지은 랜덤 브랜치 이름을 **작업 내용에 맞는 이름으로 바꿀지** 판정한다.
 *
 * 이 모듈에 이름을 짓는 모델 호출은 없다. 재료는 **에이전트가 이미 정해 둔 워크스페이스
 * 이름**(`set_workspace_name`, 사용자가 직접 고친 이름이 있으면 그쪽) 하나뿐이다. 그 이름은
 * 사용자가 시킨 턴 안에서 이미 정해졌으므로 여기서 쓰는 데 드는 토큰이 0 이다. 이름 하나를
 * 얻자고 워크스페이스마다 생성 턴을 하나씩 붙이는 것은, 사용자가 시키지도 않은 턴을
 * 기본값으로 만들지 않는다는 Wooi 의 원칙에 어긋난다(`autoResolveConflicts` 주석 참고).
 * 그래서 재료가 없으면 **아무것도 하지 않는다** — 없는 재료를 만들러 가지 않는다.
 *
 * 시점은 첫 작업이 아니라 **push 직전**이다. 작업이 끝난 때가 그 작업의 이름을 가장 잘 아는
 * 때이고, 일찍 지으면 틀린 이름으로 굳는다. 규칙을 강제당하는 자리도 바로 거기다.
 */

const exec = promisify(execFile)

const ADJECTIVE_SET = new Set<string>(ADJECTIVES)
const ANIMAL_SET = new Set<string>(ANIMALS)
const TYPE_SET = new Set<string>(TYPES)

/** `resolveUniqueWorktree` 가 이름 충돌 때 붙이는 접미사(`swift-fox-2`). */
const COLLISION_SUFFIX = /-\d+$/

/** 브랜치 이름이 길어지면 읽히지 않는다. 설명 부분만 자른다. */
const MAX_DESCRIPTION_LENGTH = 60

/**
 * 이 브랜치 이름을 **Wooi 가 지었는가**.
 *
 * 사람이 지은 이름은 절대 건드리지 않기 위한 가드다. `generateWorkspaceName` 이 만드는 두
 * 형태(`<형용사>-<동물>` 과 폴백 `workspace-N`)만 참으로 본다. 목록을 그쪽에서 그대로
 * 가져오므로 단어가 늘어도 판정이 따라온다 — 여기서 다시 적으면 두 목록이 갈라진다.
 */
export function isGeneratedBranchName(branch: string): boolean {
  const base = branch.replace(COLLISION_SUFFIX, '')
  if (base === 'workspace') return true
  const dash = base.indexOf('-')
  if (dash <= 0) return false
  return ADJECTIVE_SET.has(base.slice(0, dash)) && ANIMAL_SET.has(base.slice(dash + 1))
}

/**
 * 사람이 읽는 이름을 git ref 로 쓸 수 있는 슬러그로 만든다.
 *
 * 브랜치 이름은 신뢰할 수 없는 입력이다 — 워크스페이스 이름은 모델이 정하고 사용자가 고친다.
 * 그래서 거를 문자를 열거하는 대신 **남길 문자만 허용한다**(`[a-z0-9-]`). 이러면 `..`,
 * `@{`, 선행 `-`, `.lock` 같은 git 이 거부하는 형태가 만들어질 수 없고, 셸 메타문자도 남지
 * 않는다(호출부는 그와 별개로 인자 배열을 쓴다).
 *
 * 아스키로 접히지 않는 이름(예: 한글로 지은 워크스페이스 이름)은 빈 문자열이 된다. 그때는
 * 제안하지 않는다 — 뜻이 사라진 이름을 브랜치에 새기느니 원래 이름을 두는 편이 낫다.
 */
export function slugifyBranchDescription(name: string): string {
  return (
    name
      .normalize('NFKD')
      // NFKD 가 떼어 낸 결합 문자(é → e + ´)를 지운다. 지우지 않으면 허용 목록이 그것을
      // 대시로 바꿔 `résumé` 가 `re-sume` 이 된다 — 단어 하나가 둘로 갈라진다.
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_DESCRIPTION_LENGTH)
      .replace(/-+$/g, '')
  )
}

/**
 * 워크스페이스 이름 하나로 규칙에 맞는 브랜치 이름을 만든다. 만들 수 없으면 null.
 *
 * `type` 은 이름이 스스로 말할 때만 따른다 — "Fix first message stall" 이나
 * "feat(mobile): …" 처럼 앞머리가 커밋 타입이면 그것을 쓰고, 아니면 `feat` 으로 둔다.
 * 무엇을 고친 작업인지 여기서 **추론하지 않는다**. 그러려면 모델을 불러야 하고, 그것이
 * 이 기능이 피하려던 바로 그 비용이다.
 */
export function branchNameFromWorkspaceName(name: string): string | null {
  const slug = slugifyBranchDescription(name)
  if (!slug) return null

  const [head, ...rest] = slug.split('-')
  const branch =
    TYPE_SET.has(head) && rest.length > 0 ? `${head}/${rest.join('-')}` : `feat/${slug}`

  // 우리가 만든 이름이 규칙을 통과하는지 규칙 자신에게 물어본다. 통과하지 못하는 이름을
  // 제안하면 push 는 어차피 훅에 막히고, 사용자는 아무것도 얻지 못한 채 개명만 당한다.
  return isAllowedBranchName(branch) ? branch : null
}

export interface BranchRenameProposal {
  /** 지금 브랜치 이름(Wooi 가 지은 것). */
  from: string
  /** 제안하는 이름. 규칙을 통과하는 것이 보장된다. */
  to: string
}

export interface BranchRenameInput {
  /** 워크스페이스의 현재 브랜치. */
  branch: string
  /** 사용자가 고친 이름이 있으면 그것, 없으면 에이전트가 정한 이름. 둘 다 없으면 비어 있다. */
  workspaceName: string | null | undefined
  /** 이 브랜치가 이미 origin 에 있는가. 호출부가 조회해서 넘긴다. */
  onOrigin: boolean
  /** 한 워크트리 안에 브랜치를 여러 개 쌓아 둔 상태인가. */
  hasBranchStack?: boolean
}

/**
 * 개명을 제안할지 판정한다. 제안하지 않을 이유가 하나라도 있으면 null 이다.
 *
 * 가드가 다섯 개다. 이름은 사용자 것이므로, 애매하면 손대지 않는 쪽으로 기운다.
 */
export function proposeBranchRename(input: BranchRenameInput): BranchRenameProposal | null {
  // 이미 origin 에 올라간 이름은 바꾸지 않는다. 로컬만 바꾸면 원격 이름과 갈라지는데,
  // Wooi 의 restack 은 **현재 HEAD 이름**으로 `git push --force-with-lease origin <branch>`
  // 하므로(src/main/git.ts) 그 다음 push 부터 엉뚱한 ref 를 겨눈다. PR 이 열려 있다면 원격
  // 브랜치를 지우는 순간 PR 도 닫힌다.
  if (input.onOrigin) return null

  // 한 워크트리에 브랜치를 여러 개 쌓아 둔 상태(`Workspace.stack`)에서는 HEAD 하나만 바꾸면
  // 스택의 나머지 항목이 옛 이름을 가리킨 채 남는다. 그 정리는 이 기능의 몫이 아니다.
  if (input.hasBranchStack) return null

  // 규칙에 맞는 이름은 그대로 둔다. 사람이 지었든 우연이든, 규칙이 만족되면 고칠 이유가 없다.
  if (isAllowedBranchName(input.branch)) return null

  // 규칙에 어긋나더라도, Wooi 가 지은 이름이 아니면 사람의 선택이다. 건드리지 않는다.
  if (!isGeneratedBranchName(input.branch)) return null

  const source = (input.workspaceName ?? '').trim()
  if (!source) return null

  const to = branchNameFromWorkspaceName(source)
  if (!to || to === input.branch) return null
  return { from: input.branch, to }
}

/**
 * 로컬 브랜치 이름을 바꾼다.
 *
 * 이름은 신뢰할 수 없는 입력이므로 인자 배열로 넘긴다(src/main/git.ts 와 같은 방식). 문자열
 * 보간으로 셸에 넘기지 않는다. 실패는 삼키지 않고 그대로 올린다 — 같은 이름의 브랜치가 이미
 * 있으면 사용자가 그것을 알아야 다른 이름을 고를 수 있다.
 */
export async function renameLocalBranch(
  worktreePath: string,
  from: string,
  to: string
): Promise<void> {
  await exec('git', ['branch', '-m', from, to], { cwd: worktreePath })
}
