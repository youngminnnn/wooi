/**
 * 스크린리더에 **무엇을 읽어 줄지** 정하는 순수 로직.
 *
 * 왜 있나: 이 앱은 워크스페이스가 실행 중 → 권한 대기 → 완료 → 오류로 계속 상태를 바꾸는데,
 * 그 변화를 소리로 알리는 층이 아예 없었다(`aria-live` 0건). 화면을 보지 않는 사용자는 지금
 * 무엇을 묻고 있는지 알 방법이 없었다.
 *
 * **알림음과 역할을 나눈다.** `lib/sound.ts` 의 차임은 이미 세 이벤트를 다 울린다 —
 * `completed`·`error`·`needsInput`(store.ts). 다만 셋 다 **같은 2음 차임**이라 어느
 * 워크스페이스인지도, 셋 중 무엇인지도, 무엇을 묻는지도 말해 주지 않는다. 그래서 여기서는
 * 차임이 이미 답하는 것("뭔가 끝났다")을 되풀이하지 않고, 차임이 **답할 수 없는 것**만 말한다:
 * 어느 워크스페이스가, 무엇을 기다리는가.
 *
 * 그래서 읽어 주는 것은 셋뿐이다. 늘리지 마라 — 라이브 리전은 늘리는 순간 시끄러워져서
 * 사용자가 스크린리더 자체를 꺼 버리는 층이다:
 *   1. 권한·질문 카드가 떠 사용자 응답을 기다리는 상태, 무엇을 묻는지까지 (assertive)
 *   2. 오류 (assertive)
 *   3. 토스트 내용 (polite)
 *
 * **턴 시작·종료는 읽지 않는다.** 차임이 그 자리를 이미 채우고 있어 말이 겹치고, 권한 승인마다
 * 턴이 running 으로 되돌아오므로(권한 대기 중에도 status 는 running 이다 — session.ts 의
 * syncStatus) 승인할 때마다 "started running" 이 따라붙었다. 한 턴에 세 번만 물어도 여덟 번을
 * 말하게 되는데, 그중 절반은 사용자가 방금 자기 손으로 승인해서 이미 아는 사실이었다.
 *
 * **사용자가 끊은 턴도 읽지 않는다** — 자기가 누른 버튼이다. 그 사실은 사이드바 상태 표시의
 * 접근 가능한 이름("Stopped by you")으로 언제든 확인할 수 있다.
 *
 * 스트리밍 토큰은 당연히 읽지 않는다. 한 글자씩 읽어대면 못 쓴다.
 */

export type Politeness = 'polite' | 'assertive'

export interface Announcement {
  message: string
  politeness: Politeness
}

/**
 * 알릴 수 있는 상태.
 *
 * `quiet` 하나가 idle·running·압축·재개·중단을 전부 삼킨다 — 이 층에서 그것들은 서로 구별할
 * 이유가 없다. 구별이 필요한 곳은 화면이고, 그건 `describeWorkspaceStatus` 의 11단 사다리가
 * 이미 한다.
 */
export type AnnounceState =
  { kind: 'quiet' } | { kind: 'awaiting-response'; ask?: string } | { kind: 'error' }

export interface AnnounceSnapshot {
  workspaceId: string
  /** 사용자가 보는 표시 이름(workspaceDisplayName). 문장에 그대로 들어간다. */
  workspaceName: string
  state: AnnounceState
}

/**
 * 두 상태가 "같은가" 의 기준. 질문 대기는 **묻는 내용까지** 키에 넣는다 — 한 워크스페이스가
 * 연달아 다른 것을 물으면 그건 새 사실이라 다시 읽어야 하기 때문이다.
 */
export function announceStateKey(state: AnnounceState): string {
  return state.kind === 'awaiting-response' ? `awaiting-response:${state.ask ?? ''}` : state.kind
}

function sentence(name: string, state: Exclude<AnnounceState, { kind: 'quiet' }>): Announcement {
  return state.kind === 'error'
    ? { politeness: 'assertive', message: `${name} stopped with an error.` }
    : {
        politeness: 'assertive',
        message: state.ask ? `${name} needs your input: ${state.ask}` : `${name} needs your input.`
      }
}

/**
 * 직전 스냅샷과 지금을 비교해 읽어 줄 문장을 고른다. 읽을 것이 없으면 `null`.
 *
 * 규칙은 셋이고, 셋 다 "조용한 쪽" 으로 기운다:
 *
 * 1. **첫 스냅샷은 침묵한다**(`prev === null`). 라이브 리전은 원래 초기 내용을 읽지 않는다 —
 *    앱을 켜자마자 지금 상태를 한 번 읊는 것은 변화의 통지가 아니라 잡음이다.
 * 2. **quiet 은 읽지 않는다.** 여기에는 턴 종료도 포함된다 — 차임이 이미 그 자리에 있다.
 * 3. **같은 워크스페이스에서 키가 같으면 침묵한다.** 스토어는 스트리밍 중 초당 여러 번
 *    갱신되므로 이 억제가 없으면 같은 문장을 끝없이 반복해 읽는다. 워크스페이스가 다르면
 *    억제하지 않는다 — 옮겨 간 곳이 응답을 기다리고 있다면 그건 지금 행동해야 할 사실이다.
 */
export function announceChange(
  prev: AnnounceSnapshot | null,
  next: AnnounceSnapshot
): Announcement | null {
  if (!prev) return null
  if (next.state.kind === 'quiet') return null
  if (
    prev.workspaceId === next.workspaceId &&
    announceStateKey(prev.state) === announceStateKey(next.state)
  ) {
    return null
  }
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
 * 토스트를 읽는 이유는 차임이 **토스트를 아예 다루지 않기 때문**이다(알림 이벤트는
 * completed·error·needsInput 셋뿐이다). 게다가 토스트는 스스로 사라지므로, 읽지 않으면
 * 화면을 보지 않는 사용자에게는 존재 자체가 없다.
 *
 * politeness 가 assertive 가 아니라 polite 인 이유: 토스트는 사용자가 방금 한 행동의 결과
 * 보고지, 하던 일을 끊고 들어야 할 질문이 아니다.
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
 * 스토어 상태에서 파생되는 것은 `LiveRegion` 이 직접 구독해 계산하므로 이 버스를 쓰지 않는다.
 * 이건 **스토어를 읽을 수 없는 자리** 하나를 위해 있다 — `ErrorBoundary` 는 클래스 컴포넌트고,
 * 렌더가 깨진 순간 알려야 하는데 그 사실은 스토어 어디에도 남지 않는다. `uiFlags.ts` 의
 * 이벤트 버스와 같은 모양이다.
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
