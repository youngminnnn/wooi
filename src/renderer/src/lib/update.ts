import type { UpdateStatus } from '@shared/types'

/**
 * 자동 업데이트 상태 해석 헬퍼. 상태는 store 의 `updateStatus` 한 곳에서만 구독하고,
 * 타이틀바 점 표시·설정 화면 문구는 모두 여기 규칙을 공유한다.
 */

/**
 * "설치 가능한 새 버전이 있다"고 볼 수 있는 상태인지.
 * available/downloading 은 아직 받고 있는 중, ready 는 재시작만 남은 상태다.
 * blocked(읽기 전용 위치)는 새 버전 존재 여부를 알 수 없으므로 제외한다.
 */
export function hasNewVersion(status: UpdateStatus): boolean {
  return status.state === 'available' || status.state === 'downloading' || status.state === 'ready'
}

/** 새 버전이 있을 때의 짧은 안내 문구(타이틀바 버튼 tooltip 용). */
export function newVersionLabel(status: UpdateStatus): string {
  const v = status.version ? ` ${status.version}` : ''
  if (status.state === 'ready') return `Version${v} ready — restart to update`
  if (status.state === 'downloading') return `Downloading update${v}… ${status.percent ?? 0}%`
  return `New version${v} available`
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
    case 'blocked':
      return status.error ?? 'Automatic updates are unavailable from this location.'
    case 'error':
      return `Update check failed: ${status.error ?? 'unknown error'}`
    default:
      return ''
  }
}
