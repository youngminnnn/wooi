import { RESTART_SETTLE_MS, type UpdateStatus } from '@shared/types'

/**
 * 자동 업데이트 상태 해석 헬퍼. 상태는 store 의 `updateStatus` 한 곳에서만 구독하고,
 * 타이틀바 점 표시·설정 화면 문구는 모두 여기 규칙을 공유한다.
 */

/** 항상 최신 릴리스의 dmg 로 리다이렉트된다(자동 업데이트가 막혔을 때의 수동 경로). */
export const DOWNLOAD_URL =
  'https://github.com/youngminnnn/wooi/releases/latest/download/Wooi-arm64.dmg'

/**
 * "새 버전이 나와 있다"고 볼 수 있는 상태인지.
 * available/downloading 은 아직 받고 있는 중, ready 는 재시작만 남은 상태다.
 * blocked(읽기 전용 위치)는 자동 설치만 불가할 뿐 확인은 계속하므로,
 * 새 버전을 찾아낸 경우(version 이 채워진 경우)에만 포함한다.
 */
export function hasNewVersion(status: UpdateStatus): boolean {
  if (status.state === 'blocked') return !!status.version
  return status.state === 'available' || status.state === 'downloading' || status.state === 'ready'
}

/** 새 버전이 있을 때의 짧은 안내 문구(타이틀바 버튼 tooltip 용). */
export function newVersionLabel(status: UpdateStatus): string {
  const v = status.version ? ` ${status.version}` : ''
  if (status.state === 'ready') return `Version${v} ready — restart to update`
  if (status.state === 'downloading') return `Downloading update${v}… ${status.percent ?? 0}%`
  if (status.state === 'blocked') return `New version${v} available — download it manually`
  return `New version${v} available`
}

/**
 * "작업이 끝나면 재시작" 예약이 걸렸을 때의 문구. 예약이 없으면 빈 문자열.
 *
 * 세 국면을 구분한다 — 아직 다운로드 중 / 진행 중인 작업을 기다리는 중 / 카운트다운.
 * `now` 는 호출부가 1초마다 갱신하는 현재 시각(카운트다운을 그리기 위한 것). 카운트다운이
 * 막 시작된 첫 틱에는 `now` 가 한 박자 늦을 수 있으므로 유예 길이로 상한을 씌운다 —
 * 그러지 않으면 "restarting in 4213s" 같은 값이 한 번 스쳐 지나간다.
 */
export function scheduledRestartText(status: UpdateStatus, now: number): string {
  if (!status.restartWhenIdle) return ''
  if (status.restartAt) {
    const secs = Math.ceil((status.restartAt - now) / 1000)
    const left = Math.min(Math.round(RESTART_SETTLE_MS / 1000), Math.max(0, secs))
    return `All work finished — restarting in ${left}s.`
  }
  if (status.state !== 'ready') {
    return 'Restart scheduled — Wooi will update once the download and all work finish.'
  }
  const busy = status.busyCount ?? 0
  if (busy === 0) return 'Restart scheduled — waiting for work to settle.'
  return `Restart scheduled — waiting for ${busy} running ${busy === 1 ? 'task' : 'tasks'} to finish.`
}

/** 설정 화면 "About" 섹션에 보여 줄 상태 문구. idle 이면 빈 문자열. */
export function updateStatusText(status: UpdateStatus): string {
  switch (status.state) {
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return `Update available${status.version ? ` (${status.version})` : ''} — downloading…`
    case 'downloading':
      return `Downloading update… ${status.percent ?? 0}%`
    case 'ready':
      return `Version ${status.version ?? ''} downloaded — restart to install.`
    case 'not-available':
      return 'You’re on the latest version.'
    case 'blocked': {
      const reason = status.error ?? 'Automatic updates are unavailable from this location.'
      // 새 버전을 찾아낸 경우엔 "무엇을 놓치고 있는지"를 먼저 말해 준다.
      return status.version ? `Version ${status.version} is available. ${reason}` : reason
    }
    case 'error':
      return `Update check failed: ${status.error ?? 'unknown error'}`
    default:
      return ''
  }
}
