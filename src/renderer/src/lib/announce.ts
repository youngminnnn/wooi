/**
 * 스크린리더에 **무엇을 읽어 줄지** 정하는 순수 로직.
 *
 * 왜 있나: 이 앱은 대화가 스트리밍으로 들어오고, 워크스페이스가 실행 중 → 권한 대기 → 완료 →
 * 오류로 계속 상태를 바꾼다. 그런데 그 변화를 소리로 알리는 층이 아예 없어서(`aria-live` 0건)
 * 화면을 보지 않는 사용자는 턴이 시작됐는지 끝났는지, 지금 무엇을 묻고 있는지 알 방법이 없었다.
 *
 * **판정을 컴포넌트가 아니라 여기 두는 이유**는 하나다 — "같은 상태가 연속으로 오면 두 번
 * 읽지 않는다" 는 규칙이 라이브 리전의 전부인데, 그걸 렌더 안에 흩어 두면 테스트할 수가 없다.
 * 여기 있는 함수는 전부 순수하고, 상태 보관(직전 스냅샷)은 유일한 호스트인 `LiveRegion.tsx` 의
 * ref 하나가 맡는다.
 *
 * **읽어 주는 것은 네 가지로 한정한다**(늘리지 마라 — 라이브 리전은 늘리는 순간 시끄러워져서
 * 사용자가 스크린리더 자체를 꺼 버리는 층이다):
 *   1. 지금 보고 있는 워크스페이스의 턴 시작/종료 (polite)
 *   2. 권한·질문 카드가 떠 사용자 응답을 기다리는 상태 (assertive)
 *   3. 오류·중단 (assertive)
 *   4. 토스트 내용 (polite)
 *
 * 스트리밍 토큰은 **읽지 않는다.** 한 글자씩 읽어대면 못 쓴다 — 턴 경계와 상태 전이만 알린다.
 */

export type Politeness = 'polite' | 'assertive'

export interface Announcement {
  message: string
  politeness: Politeness
}

/**
 * 알릴 수 있는 상태. `describeWorkspaceStatus` 의 사다리에서 위 네 항목에 해당하는 칸만 뽑아낸
 * 것이라, 순서를 바꾸려면 그쪽 사다리부터 본다(compacting 은 running 안에 접히고,
 * rate-limited·stacked·background·pr 은 이 층에서 알리지 않는다).
 */
export type AnnounceState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'awaiting-response'; ask?: string }
  | { kind: 'error' }
  | { kind: 'interrupted' }

export interface AnnounceSnapshot {
  workspaceId: string
  /** 사용자가 보는 표시 이름(workspaceDisplayName). 문장에 그대로 들어간다. */
  workspaceName: string
  state: AnnounceState
}

/**
 * 두 상태가 "같은가" 의 기준. 질문 대기는 **묻는 내용까지** 키에 넣는다 — 한 워크스페이스가
 * 연달아 다른 것을 물으면 그건 새 사실이라 다시 읽어야 하기 때문이다. 나머지는 종류만 본다.
 */
export function announceStateKey(state: AnnounceState): string {
  return state.kind === 'awaiting-response' ? `awaiting-response:${state.ask ?? ''}` : state.kind
}

/**
 * 워크스페이스를 갈아탔을 때도 그대로 읽어 줄 상태.
 *
 * 전환은 턴 전이가 아니므로 기본은 침묵이다 — 목록을 훑는 동안 "running… idle… running…" 이
 * 따라다니면 그게 바로 사용자가 스크린리더를 끄는 이유가 된다. 다만 **사용자의 응답을 기다리는
 * 중이거나 오류로 끝난 워크스페이스**로 옮겨 갔다면 그건 지금 행동해야 할 사실이라 알린다.
 */
const ANNOUNCE_ON_SWITCH: ReadonlySet<AnnounceState['kind']> = new Set([
  'awaiting-response',
  'error'
])

function sentence(name: string, state: AnnounceState): Announcement {
  switch (state.kind) {
    case 'awaiting-response':
      return {
        politeness: 'assertive',
        message: state.ask ? `${name} needs your input: ${state.ask}` : `${name} needs your input.`
      }
    case 'error':
      return { politeness: 'assertive', message: `${name} stopped with an error.` }
    case 'interrupted':
      return { politeness: 'assertive', message: `${name} was stopped before finishing.` }
    case 'running':
      return { politeness: 'polite', message: `${name} started running.` }
    case 'idle':
      return { politeness: 'polite', message: `${name} finished.` }
  }
}

/**
 * 직전 스냅샷과 지금을 비교해 읽어 줄 문장을 고른다. 읽을 것이 없으면 `null`.
 *
 * 규칙은 넷이고, 넷 다 "조용한 쪽" 으로 기운다:
 *
 * 1. **첫 스냅샷은 침묵한다**(`prev === null`). 라이브 리전은 원래 초기 내용을 읽지 않는다 —
 *    앱을 켜자마자 지금 상태를 한 번 읊는 것은 변화의 통지가 아니라 잡음이다.
 * 2. **워크스페이스를 갈아탔으면** 행동이 필요한 상태만 읽는다(위 ANNOUNCE_ON_SWITCH).
 * 3. **키가 같으면 침묵한다.** 이게 이 모듈의 존재 이유다 — 스토어는 스트리밍 중 초당 여러 번
 *    갱신되므로, 같은 상태를 걸러내지 않으면 "running" 을 끝없이 반복해 읽는다.
 * 4. **idle 은 running 다음에만 읽는다.** 그 자리에서만 idle 이 "턴이 끝났다" 는 뜻이고,
 *    다른 상태에서 흘러온 idle(예: 오류를 확인해 지운 뒤)은 알릴 사건이 아니다.
 */
export function announceChange(
  prev: AnnounceSnapshot | null,
  next: AnnounceSnapshot
): Announcement | null {
  if (!prev) return null
  if (prev.workspaceId !== next.workspaceId) {
    return ANNOUNCE_ON_SWITCH.has(next.state.kind) ? sentence(next.workspaceName, next.state) : null
  }
  if (announceStateKey(prev.state) === announceStateKey(next.state)) return null
  if (next.state.kind === 'idle' && prev.state.kind !== 'running') return null
  return sentence(next.workspaceName, next.state)
}

/** 토스트에서 읽을 것만 남긴 최소 형태(스토어의 `Toast` 가 구조적으로 들어맞는다). */
export interface AnnounceableToast {
  id: string
  message: string
}

/**
 * 아직 읽지 않은 토스트의 문장들. 닫힌 토스트는 목록에서 사라지므로 id 만 비교하면 된다.
 *
 * 토스트는 이미 `window.alert` 를 대체한 **명시적 통지**라 내용이 그대로 문장이 된다 — 상태
 * 전이처럼 문장을 새로 지어낼 필요가 없다. politeness 를 assertive 가 아니라 polite 로 두는
 * 이유: 토스트는 사용자가 방금 한 행동의 결과 보고지, 하던 일을 끊고 들어야 할 질문이 아니다.
 */
export function newToastMessages(
  seen: ReadonlySet<string>,
  toasts: readonly AnnounceableToast[]
): string[] {
  return toasts.filter((t) => !seen.has(t.id)).map((t) => t.message)
}

/**
 * 스토어 밖에서 한 번씩 터지는 문장을 같은 호스트로 밀어 넣는 통로.
 *
 * 스토어 상태에서 파생되는 것(위 네 항목)은 `LiveRegion` 이 직접 구독해 계산하므로 이 버스를
 * 쓰지 않는다. 이건 **스토어를 읽을 수 없는 자리** 하나를 위해 있다 — `ErrorBoundary` 는 클래스
 * 컴포넌트고, 렌더가 깨진 순간 알려야 하는데 그 사실은 스토어 어디에도 남지 않는다.
 * `uiFlags.ts` 의 이벤트 버스와 같은 모양이다.
 */
type Listener = (announcement: Announcement) => void

const listeners = new Set<Listener>()

export function announce(message: string, politeness: Politeness = 'polite'): void {
  if (!message) return
  for (const fn of listeners) fn({ message, politeness })
}

export function subscribeAnnouncements(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
