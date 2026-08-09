import { log } from '../../logger'
import type { ChatEvent, ChatItem } from '@shared/types'
import type { ScriptRunner } from '../../scripts'

/**
 * 에이전트가 Wooi 자체를 조작하는 도구들의 **실행부**.
 *
 * 여기가 능력의 단일 소유자다. 전송 계층(Claude 는 호스트의 인프로세스 MCP 서버, 나중에 Codex 는
 * stdio shim)은 이름과 인자를 실어 나르기만 하고, 무엇을 할 수 있는지는 이 테이블만 안다.
 * 그래서 이 파일은 `claude/` 밖에 있다 — 백엔드가 늘어도 능력은 하나로 남아야 한다.
 *
 * 도구 정의(이름·설명·스키마)는 [[agent/tools/catalog]] 에 있고, 여기에는 실행부만 둔다.
 * 둘을 잇는 등록은 [[agent/tools]] 의 initAgentTools 한 곳에서 눈에 보이게 한다.
 */

export interface AgentToolDeps {
  scripts: ScriptRunner
  /** 상태를 바꾼 도구가 사이드바·화면을 갱신시키는 통로. */
  broadcastState: () => void
  /**
   * 다른 워크스페이스의 에이전트에게 말을 건다. 지금은 스택 자식에게 최초 작업을 넘길 때만 쓴다.
   *
   * 이 호출은 그 워크스페이스의 턴을 **시작시킨다**. 그래서 "부모가 자식을 깨우는" 방향으로만
   * 쓰고, 반대 방향(자식 → 부모)은 쓰지 않는다 — 부모는 사람과 대화 중일 수 있고, 사용자가
   * 승인하지 않은 턴 비용이 발생한다. 자식의 보고는 기록만 하고 부모가 직접 읽는다.
   */
  sendMessage: (workspaceId: string, text: string) => void
  /**
   * 워크스페이스 대화에 항목 하나를 남긴다(트랜스크립트 영속 + 화면 반영).
   *
   * 트랜스크립트는 에이전트의 대화 맥락과 **별개**다 — 여기 남긴 것은 사람에게 보일 뿐,
   * 그 워크스페이스의 모델이 읽지 않는다. 알림용으로만 쓴다.
   */
  postToTranscript: (workspaceId: string, item: ChatItem) => void
  /**
   * 워크스페이스 대화의 **휘발성 이벤트**를 렌더러로 보낸다(트랜스크립트에 남지 않음).
   *
   * postToTranscript 와 나눠 두는 이유: 위임 서브에이전트의 "지금 돌고 있음" 같은 것은 영속하면
   * 안 되는 상태다. 세션이 끝나면 사라져야 하고, 다시 열었을 때 옛 스피너가 남아 있으면 안 된다.
   */
  emitChatEvent: (workspaceId: string, event: ChatEvent) => void
  /**
   * 워크스페이스를 아카이브할 때 그 워크스페이스에 매달린 것들을 끊는다([[workspaces]]
   * archiveWorkspace 가 요구하는 것과 같은 모양).
   *
   * 구체 클래스가 아니라 쓰는 메서드만 적는다 — 도구가 오케스트레이터·터미널의 나머지 능력에
   * 손을 뻗지 않아야 하고, 테스트가 이 둘을 흉내내는 값도 두 줄로 끝난다.
   */
  sessions: { dispose: (workspaceId: string) => void }
  terminals: { disposeWorkspace: (workspaceId: string) => void }
}

/**
 * 도구 1건의 실행 함수.
 *
 * `workspaceId` 는 **호출한 세션**이다 — 인자가 아니라 맥락으로 들어오므로(protocol.ts 의
 * toolCall 주석) 도구가 남의 워크스페이스를 건드릴 수 없다.
 * 돌려주는 값은 그대로 모델에게 간다. 직렬화 가능해야 한다.
 */
export type AgentToolHandler = (
  deps: AgentToolDeps,
  workspaceId: string,
  args: Record<string, unknown>
) => Promise<unknown>

const handlers = new Map<string, AgentToolHandler>()

let deps: AgentToolDeps | null = null

/**
 * 메인이 부팅하면서 도구 실행에 필요한 것들을 주입한다(index.ts).
 *
 * 주입 방식인 이유: 이 테이블을 부르는 쪽은 ClaudeManager 인데, 그쪽으로 의존성을 꿰면
 * 오케스트레이터를 관통해 콜백을 넘겨야 한다. setCodexStatusProvider 와 같은 결을 쓴다.
 */
export function initRegistry(injected: AgentToolDeps): void {
  deps = injected
}

/** 카탈로그의 도구 이름에 실행부를 붙인다. 같은 이름을 두 번 등록하는 것은 프로그래밍 오류다. */
export function registerAgentTool(name: string, handler: AgentToolHandler): void {
  if (handlers.has(name)) throw new Error(`agent tool registered twice: ${name}`)
  handlers.set(name, handler)
}

/**
 * 도구 1건을 실행한다. 호스트에서 올라온 toolCall 이 여기로 들어온다.
 *
 * 던지는 대신 문자열 에러를 **결과로** 돌려주지 않는다 — 던진 것은 호출부(ClaudeManager)가
 * `toolResult { ok: false }` 로 바꿔 모델에게 도구 오류로 전달한다. 모델은 그걸 보고 고쳐서
 * 다시 부를 수 있어야 하므로, 메시지는 사람이 읽을 문장으로 쓴다.
 */
export async function runAgentTool(
  workspaceId: string,
  tool: string,
  args: unknown
): Promise<unknown> {
  if (!deps) throw new Error('Wooi tools are not ready yet.')

  // `tool` 은 모델이 준 문자열이 그대로 온다. 조회를 Map 으로 하는 것이 1차 방어다 —
  // 객체였다면 `__proto__`·`constructor` 같은 이름이 프로토타입 사슬을 타고 함수를 물어왔겠지만
  // Map 은 자기가 담은 키만 안다. 그 위에 실제로 함수인지까지 확인하고 부른다.
  const handler = handlers.get(tool)
  if (typeof handler !== 'function') throw new Error(`Unknown Wooi tool: ${tool}`)

  log.info(`agent tool: ${tool} (workspace=${workspaceId})`)
  return handler(deps, workspaceId, (args ?? {}) as Record<string, unknown>)
}

/** 테스트 전용 — 등록 상태를 비운다. */
export function resetAgentToolsForTest(): void {
  handlers.clear()
  deps = null
}
