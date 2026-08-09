import { workspaceDisplayName } from '@shared/types'
import type { Workspace } from '@shared/types'
import { getStore } from '../../store'

/**
 * 도구가 **어느 워크스페이스에 작용하는가**를 정하는 한 곳.
 *
 * 오래도록 대답이 하나였다 — "부르는 자기 자신". workspaceId 는 인자가 아니라 맥락으로 들어오므로
 * (registry.ts 의 AgentToolHandler) 남을 지목하는 것이 애초에 불가능했고, 서버 안내도 그렇게 적혀
 * 있었다. archive_workspace 가 그 불변식을 깬 첫 도구다.
 *
 * 그래서 검증을 도구마다 흩뿌리지 않고 여기 모은다. 대상을 받는 도구가 하나 더 생길 때 가드를
 * 다시 발명하게 두면, 빠뜨린 가드가 곧 남의 워크스페이스를 건드리는 구멍이 된다.
 *
 * **승인 카드에 기대지 않는다.** `fullAccess` 모드에서는 needsApproval 이 그냥 통과시키고
 * ([[agent/tools/permission]]), Codex 경로의 verifyCaller 는 이름 그대로 **호출자만** 본다
 * ([[agent/tools/socket]]) — 대상 쪽에는 아무 방어가 없다. 방어는 핸들러 안에 있어야 한다.
 */

/** 호출자 자신. 도구가 도는 중에도 사용자가 워크스페이스를 지울 수 있다. */
export function callerWorkspace(workspaceId: string): Workspace {
  const ws = getStore()
    .getState()
    .workspaces.find((w) => w.id === workspaceId)
  if (!ws) throw new Error('This workspace no longer exists.')
  return ws
}

/**
 * 인자로 지목된 워크스페이스를 확인하고 돌려준다. 하나라도 어긋나면 던진다 — 던진 문장은
 * 도구 오류로 모델에게 가므로, 모델이 무엇을 잘못 지목했는지 알아볼 수 있게 쓴다.
 *
 * 조건은 넷이고 각각 다른 사고를 막는다:
 * 1. 실재 — 사라진 id 를 조용히 성공으로 만들지 않는다.
 * 2. **자기가 만든 것** — 이것이 핵심 경계다. 모델은 다른 워크스페이스의 id 를 볼 수 있고
 *    (check_stacked_work · check_related_work 는 id 를 그대로 돌려준다), 사용자가 승인 카드를
 *    대충 넘길 수도 있다. 만든 것에만 손댈 수 있으면 최악의 오폭이 자기가 만든 것에서 멈춘다.
 *
 *    부모 관계(parentWorkspaceId)로 판정하지 않는다. 그건 "어느 브랜치 위에 쌓였는가" 라는 git
 *    사실이라 **사람이 UI 에서 만든 스택 자식까지 포함해 버리고**, 에이전트가 만들지 않은 것을
 *    지울 권한을 준다. 반대로 에이전트가 만든 독립 워크스페이스는 부모가 없어 빠져나간다 —
 *    양쪽으로 다 틀린다. 그래서 생성자를 따로 기록한다(Workspace.createdByWorkspaceId).
 * 3. 이미 아카이브됨 — 되돌릴 수 있는 동작이라도 두 번 하면 사용자가 되살린 것을 다시 지운다.
 * 4. **running** — 남이 지금 도는 턴을 죽이는 것이다. 사용자가 지켜보는 작업이 이유 없이
 *    중간에 끊기고, 그 워크스페이스의 에이전트는 자기가 왜 죽었는지 남길 기회조차 없다.
 */
export function resolveTargetWorkspace(
  callerWorkspaceId: string,
  targetWorkspaceId: unknown
): Workspace {
  const id = typeof targetWorkspaceId === 'string' ? targetWorkspaceId.trim() : ''
  if (!id) throw new Error('No workspace id was given — say which workspace you mean.')

  const target = getStore()
    .getState()
    .workspaces.find((w) => w.id === id)
  if (!target) throw new Error(`No Wooi workspace has the id ${id}.`)

  // 옛 워크스페이스는 이 값이 null 이라(v19 마이그레이션) 아무에게도 걸리지 않는다 — 기록이
  // 없으면 권한도 없다. 호출자 id 는 맥락에서 오는 실제 uuid 라 null 과 마주칠 일이 없다.
  if (target.createdByWorkspaceId !== callerWorkspaceId) {
    throw new Error(
      `${workspaceDisplayName(target)} was not created by this workspace, so you cannot act on ` +
        'it. You can only target a workspace you created yourself — ask the user to do it ' +
        'themselves.'
    )
  }
  if (target.archived) throw new Error(`${workspaceDisplayName(target)} is already archived.`)
  if (target.status === 'running') {
    throw new Error(
      `${workspaceDisplayName(target)} is running a turn right now. Wait for it to finish — ` +
        'acting on it now would kill work in progress.'
    )
  }
  return target
}
