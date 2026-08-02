/**
 * "한 번 보여 주고, 닫으면 다시 안 뜨는" 류의 순수 화면 플래그를 실행 간에 기억한다.
 *
 * 권위 있는 설정(AppSettings)에 넣지 않는 이유: 이건 기기별 UI 기억일 뿐이고, main 프로세스가
 * 알아야 할 도메인 상태가 아니다(우측 패널 상태·테마 캐시와 같은 계층). 그래서 IPC 왕복도 없다.
 * localStorage 접근 실패(private 모드 등)는 무시한다 — 기억은 편의 기능일 뿐, 없으면 힌트가
 * 한 번 더 보이는 정도의 비용이다.
 */

/**
 * 이 원격 공지를 사용자가 닫았는지. 닫으면 그 id 는 다시 뜨지 않는다.
 *
 * 기기 로컬로 두는 이유는 이 파일의 원칙 그대로다 — main 이 알아야 할 도메인 상태가 아니고,
 * 실패해도 "공지가 한 번 더 보인다" 정도의 비용이다. 대신 **공지 id 는 재사용하면 안 된다**:
 * 이미 닫은 사람에겐 새 내용이 영영 안 보이기 때문이다.
 */
export const noticeDismissedFlag = (id: string): string => `noticeDismissed.${id}`

/** 사이드바 ⌘K 힌트를 사용자가 닫았는지. */
export const QUICK_SWITCH_HINT_DISMISSED = 'quickSwitchHintDismissed'

/**
 * 이 리포의 설정 모달을 한 번이라도 열어 봤는지.
 *
 * "설정이 비어 있음"이 아니라 "아직 열어 본 적 없음"을 기준으로 안내 점을 띄우기 위한 것.
 * 스크립트를 일부러 비워 둔 리포에까지 상시 배지를 다는 건 잔소리가 된다 — 한 번 보고 나면
 * 사용자가 내린 결정이므로 다시 채근하지 않는다.
 */
export const repoSettingsSeenFlag = (repoId: string): string => `repoSettingsSeen.${repoId}`

/**
 * 이 리포에 "전달 목록이 비었는데 후보가 있다"는 제안을 이미 띄웠는지.
 *
 * 워크스페이스를 만들 때마다 반복하면 잔소리가 되므로 리포당 한 번만 띄운다. 제안을 수락하면
 * carryItems 가 차서 조건 자체가 사라지고, 무시하더라도 기능의 존재는 이미 전달됐다
 * (이후로는 설정 모달에서 언제든 직접 켤 수 있다).
 */
export const carrySuggestShownFlag = (repoId: string): string => `carrySuggestShown.${repoId}`

/**
 * ⌘↑/⌘↓ 힌트가 제 역할을 끝냈는지. 사용자가 직접 닫았거나, 실제로 단축키를 써서
 * 이미 알고 있음이 증명된 경우 true — 어느 쪽이든 다시는 띄우지 않는다.
 */
export const SWITCH_HINT_DONE = 'switchHintDone'

/** 마우스로만 워크스페이스를 전환한 누적 횟수. 단축키를 아직 모르는 사용자를 골라내는 신호다. */
const SWITCH_CLICK_COUNT = 'switchClickCount'

/** 힌트를 띄우기 시작하는 마우스 전환 횟수. 한두 번은 우연이고, 이 정도면 습관이다. */
export const SWITCH_HINT_THRESHOLD = 3

/** 힌트 표시 조건이 바뀌었음을 사이드바에 알리는 이벤트(다른 컴포넌트에서 갱신되므로 필요). */
const SWITCH_HINT_EVENT = 'wooi:switch-hint-changed'

/** 사용자가 마지막으로 본 "새 기능" 안내 번호. */
export const FEATURE_TIP_SEEN = 'featureTipSeen'

/**
 * 지금 알릴 새 기능의 번호. **새로 알릴 것이 생겼을 때만** 올린다(패치 릴리즈마다가 아니라).
 *
 * 앱 버전을 직접 비교하지 않는 이유: 사용자가 여러 버전을 건너뛰고 업데이트하는 일이 흔해서
 * "직전 버전과 다른가" 로는 무엇을 알려야 할지 알 수 없다. 안내 자체에 번호를 매기면 몇
 * 버전을 건너뛰었든 못 본 안내만 정확히 한 번 보여 줄 수 있다.
 * (CURRENT_TERMS_VERSION 과 같은 방식이다.)
 *
 * 1 = PR 리뷰 모드
 */
export const CURRENT_FEATURE_TIP = 1

const key = (name: string): string => `wooi.${name}`

export function readUiFlag(name: string): boolean {
  try {
    return localStorage.getItem(key(name)) === 'true'
  } catch {
    return false
  }
}

export function setUiFlag(name: string, value: boolean): void {
  try {
    localStorage.setItem(key(name), String(value))
  } catch {
    /* 무시 */
  }
}

/** 숫자 값을 읽는다. 없거나 깨졌으면 0(=아무것도 못 봄). */
export function readUiNumber(name: string): number {
  try {
    const n = Number(localStorage.getItem(key(name)))
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

/** 현재까지의 마우스 전환 횟수. 힌트 노출 조건 계산에 쓴다. */
export function switchClickCount(): number {
  return readUiNumber(SWITCH_CLICK_COUNT)
}

/**
 * 사이드바 행을 마우스로 눌러 워크스페이스를 전환했을 때 호출. 이미 힌트가 끝난 사용자는
 * 세지 않는다(불필요한 쓰기도, 되살아날 여지도 없게).
 */
export function noteMouseSwitch(): void {
  if (readUiFlag(SWITCH_HINT_DONE)) return
  try {
    localStorage.setItem(key(SWITCH_CLICK_COUNT), String(switchClickCount() + 1))
  } catch {
    /* 무시 */
  }
  window.dispatchEvent(new Event(SWITCH_HINT_EVENT))
}

/**
 * 힌트를 영구히 끈다. 사용자가 X 로 닫았을 때, 그리고 ⌘↑/⌘↓ 를 실제로 썼을 때 모두
 * 호출한다 — 후자가 핵심이다. 단축키를 쓰는 순간 힌트는 목적을 달성했으므로 조용히 사라진다.
 */
export function finishSwitchHint(): void {
  if (readUiFlag(SWITCH_HINT_DONE)) return
  setUiFlag(SWITCH_HINT_DONE, true)
  window.dispatchEvent(new Event(SWITCH_HINT_EVENT))
}

/** 힌트 조건 변화 구독(마우스 전환 누적·학습 완료). 해제 함수를 돌려준다. */
export function onSwitchHintChange(fn: () => void): () => void {
  window.addEventListener(SWITCH_HINT_EVENT, fn)
  return () => window.removeEventListener(SWITCH_HINT_EVENT, fn)
}

export function setUiNumber(name: string, value: number): void {
  try {
    localStorage.setItem(key(name), String(value))
  } catch {
    /* 무시 */
  }
}
