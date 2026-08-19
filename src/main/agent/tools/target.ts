import { workspaceDisplayName } from '@shared/types'
import type { Repo, Workspace } from '@shared/types'
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
 * 파일 끝의 리포 해석도 같은 이유로 여기 있다 — create_workspace 가 다른 리포에도 만들 수 있게
 * 되면서 "무엇에 작용하는가" 의 답이 워크스페이스 하나에서 (리포, 워크스페이스) 로 늘었다.
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
 *    (아카이브는 워크트리를 지우고 세션을 정리하므로, 말을 거는 쪽에도 똑같이 대상이 없다.)
 * 4. **running** — 남이 지금 도는 턴을 죽이는 것이다. 사용자가 지켜보는 작업이 이유 없이
 *    중간에 끊기고, 그 워크스페이스의 에이전트는 자기가 왜 죽었는지 남길 기회조차 없다.
 *
 * 넷 중 running 만 도구에 따라 갈린다(allowRunning). 나머지 셋은 어느 도구에서도 같은 사고를
 * 막으므로 끄는 길을 두지 않는다.
 */
export function resolveTargetWorkspace(
  callerWorkspaceId: string,
  targetWorkspaceId: unknown,
  /**
   * 도는 중인 대상을 허용한다.
   *
   * 기본이 거부인 이유는 4번이 **턴을 죽이는** 동작을 전제하기 때문이다(archive_workspace).
   * 메시지를 보내는 것은 그렇지 않다 — 세션 입력 큐가 현재 턴 뒤로 붙여 주므로 하던 일이
   * 끊기지 않고, 오히려 낡은 전제로 일하는 중일 때가 알려야 할 때다(notify_child).
   * 그래서 "도는 중" 이라는 사실 하나로 묶지 않고, 대상에게 무엇을 하는지로 가른다.
   */
  options: { allowRunning?: boolean } = {}
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
  if (target.status === 'running' && !options.allowRunning) {
    throw new Error(
      `${workspaceDisplayName(target)} is running a turn right now. Wait for it to finish — ` +
        'acting on it now would kill work in progress.'
    )
  }
  return target
}

/**
 * 도구가 **어느 리포에 만드는가**. 워크스페이스 대상 해석과 같은 이유로 여기 둔다 — 이름을
 * 리포로 바꾸는 규칙이 도구마다 갈리면, 갈린 쪽이 곧 엉뚱한 리포에 브랜치를 만드는 구멍이 된다.
 *
 * 이름으로 받는다. 모델이 볼 수 있는 것이 이름뿐이기 때문이다 — 리포 id 를 돌려주는 도구는
 * 하나도 없고(`list_workspace_peers` 는 이름을 준다), 사용자도 사이드바에서 이름으로 부른다.
 * 경로도 받아 주는 것은 이름이 겹칠 때의 유일한 탈출구라서다(리포 이름은 폴더 이름이라 겹칠 수
 * 있고, 경로는 등록 시점에 유일성이 보장된다 — ipc.ts repoAdd).
 *
 * 던지지 않고 error 를 돌려주는 이유: 같은 판정을 승인 카드도 해야 하는데
 * ([[agent/tools/permission]]) 거기서는 던질 수 없다. 카드가 자기 나름의 규칙을 새로 쓰면
 * 사용자가 승인한 문장과 실제로 만들어지는 리포가 갈라진다.
 */
export function lookupTargetRepo(
  caller: Workspace,
  requested: unknown
): { repo?: Repo; error?: string } {
  const repos = getStore().getState().repos
  const name = typeof requested === 'string' ? requested.trim() : ''

  // 생략이 압도적으로 흔한 경우다. 그때 리포를 짜내게 하면 틀린 리포에 조용히 만들어진다.
  if (!name) {
    const own = repos.find((r) => r.id === caller.repoId)
    return own
      ? { repo: own }
      : { error: 'This workspace’s repository is no longer registered with Wooi.' }
  }

  // 등록된 이름을 오류에 그대로 싣는다. `list_repositories` 로 다시 가라고만 하면 왕복이 한 번
  // 더 늘고, 그 왕복은 도구가 이미 아는 답을 얻으러 가는 길이다([[agent/tools/agentOptions]] 가
  // 모델 목록을 오류에 싣는 것과 같은 이유). 목록 도구는 자세히 볼 때(경로·기본 브랜치) 쓴다.
  const known = repos.map((r) => r.name).join(', ')
  const byPath = repos.find((r) => r.path === name)
  if (byPath) return { repo: byPath }

  const byName = repos.filter((r) => r.name.toLowerCase() === name.toLowerCase())
  if (byName.length === 1) return { repo: byName[0] }
  if (byName.length > 1) {
    return {
      error:
        `Wooi has ${byName.length} repositories called "${name}", so this is ambiguous. Pass the ` +
        `full checkout path instead: ${byName.map((r) => r.path).join(', ')}.`
    }
  }
  return {
    error:
      `Wooi has no repository called "${name}" — it only creates workspaces in repositories the ` +
      `user has added. Registered repositories: ${known || 'none'}. ` +
      'Call `list_repositories` for their paths and default branches.'
  }
}

/** 같은 판정의 던지는 판. 도구 핸들러가 쓴다 — 오류 문장이 그대로 모델에게 간다. */
export function resolveTargetRepo(caller: Workspace, requested: unknown): Repo {
  const { repo, error } = lookupTargetRepo(caller, requested)
  if (!repo) throw new Error(error ?? 'Repository not found.')
  return repo
}
