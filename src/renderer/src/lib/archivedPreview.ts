/**
 * 아카이브된 워크스페이스를 **읽기 전용으로 열어 보기** 위한 판단들.
 *
 * 아카이브는 worktree 디렉터리만 지운다 — 브랜치·PR·대화 기록은 그대로 남는다. 그래서 대화는
 * 여전히 읽을 수 있는데(트랜스크립트는 workspace id 로 저장된다), 지금까지 그것을 보는 유일한
 * 길은 **되살리는 것** 이었다. "이걸 되살릴까?" 를 판단하려면 안을 봐야 하는데, 안을 보려면
 * 먼저 되살려야 하는 순환이다. 여기 있는 함수들이 그 고리를 끊는다.
 *
 * IO 도 React 도 없이 순수하게 둔다 — "무엇을 감출지" 와 "잘려 있다는 사실을 어떻게 말할지"
 * 두 가지만 있다.
 */

/** 이 판단에 필요한 최소한의 워크스페이스 모양(테스트가 Workspace 전체를 지어내지 않게 한다). */
export interface ArchivableWorkspace {
  id: string
  archived: boolean
}

/**
 * 읽기 전용 미리보기가 대상으로 삼을 워크스페이스.
 *
 * 선택이 없거나, 선택한 워크스페이스가 살아 있거나(=평범한 대화 화면이 뜬다), 목록에서 사라졌으면
 * null 이다. 아카이브된 것을 골랐을 때만 그 워크스페이스를 돌려준다.
 */
export function archivedPreviewTarget<W extends ArchivableWorkspace>(
  workspaces: readonly W[] | undefined,
  selectedId: string | null
): W | null {
  if (!selectedId) return null
  const ws = workspaces?.find((w) => w.id === selectedId)
  return ws?.archived ? ws : null
}

/** 워크스페이스 화면에서 열려 있는 표면들. 아카이브 미리보기는 이 중 대부분이 닫혀 있다. */
export interface WorkspaceSurfaces {
  /** 메시지 입력창. 닫혀 있으면 ⌘L·타이핑 리다이렉트도 함께 죽는다. */
  composer: boolean
  /** 우측 작업 패널(git·변경·터미널). */
  workPanel: boolean
  /** 대화 위에 뜨는 큰 파일 뷰어(⇧⌘O). */
  fileViewer: boolean
  /** worktree 가 있어야 성립하는 헤더 도구들 — ⇧⌘E/F/D/S/O 와 아카이브(⇧⌘⌫). */
  worktreeTools: boolean
  /** ⌘[ / ⌘] 방문 이력에 이 선택을 남기는가. */
  visitHistory: boolean
}

// 참조를 고정해 둔다 — 매번 새 객체를 만들면 이 값을 읽는 셀렉터가 끝없이 다시 그린다.
const LIVE: WorkspaceSurfaces = {
  composer: true,
  workPanel: true,
  fileViewer: true,
  worktreeTools: true,
  visitHistory: true
}

/**
 * 아카이브 미리보기는 **전부 닫는다**.
 *
 * 인심을 쓰는 게 아니라 사실을 반영하는 것이다 — worktree 디렉터리가 없으므로 git·파일·터미널·
 * 스크립트는 실제로 불가능하고(main 의 IPC 핸들러들도 같은 이유로 아카이브를 막는다), 입력창은
 * 보낼 세션이 없다. 방문 이력에서도 빼는 이유는 조금 다르다: ⌘[ / ⌘] 는 살아 있는 워크스페이스
 * 사이를 오가는 축이라, 되살리지 않으면 돌아갈 수 없는 자리를 그 축에 끼우면 길만 길어진다.
 */
const READ_ONLY: WorkspaceSurfaces = {
  composer: false,
  workPanel: false,
  fileViewer: false,
  worktreeTools: false,
  visitHistory: false
}

export function workspaceSurfaces(archived: boolean): WorkspaceSurfaces {
  return archived ? READ_ONLY : LIVE
}

/**
 * 대화가 꼬리부터 잘려 있다는 사실을 알리는 한 줄. 다 읽었으면 null 이다.
 *
 * 미리보기도 살아 있는 대화와 **같은 읽기 창**(transcriptPagination)을 쓴다 — 아카이브라고
 * 다르게 읽으면 되살린 순간 화면이 달라진다. 다만 여기서는 잘렸다는 사실을 숨기지 않고 위쪽에
 * 못박아 둔다: 되살릴지 말지를 이 화면만 보고 정하는데, 보고 있는 것이 전부가 아니라면
 * 그것부터 알아야 한다.
 */
export function truncatedHistoryNotice(shown: number, hasMore: boolean): string | null {
  if (!hasMore || shown <= 0) return null
  return `Showing the most recent ${shown} messages — scroll up to load earlier ones.`
}
