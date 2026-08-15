import { describe, it, expect } from 'vitest'
import { nativePeerInbound, peerSessionName } from './types'

/**
 * 네이티브 cross-session messaging 과 맞닿는 두 함수.
 *
 * 둘 다 "Wooi 의 개념을 CLI 의 개념으로 옮긴다" 는 한 가지 일을 하는데, 옮기는 과정에서 정보가
 * 줄기 때문에 어디로 줄어드는지가 곧 안전 계약이 된다.
 */

describe('peerSessionName', () => {
  it('리포와 브랜치를 wooi/ 아래로 모은다', () => {
    // 접두사가 있어야 사용자의 `/list-agents` 목록에서 터미널 세션과 구분된다.
    expect(peerSessionName('wooi', 'feat/inline-login')).toBe('wooi/wooi/feat/inline-login')
  })

  it('64 코드포인트를 넘기면 코드포인트 경계에서 자른다', () => {
    const name = peerSessionName('repo', 'feat/' + 'a'.repeat(200))
    expect(Array.from(name)).toHaveLength(64)
    expect(name.endsWith('…')).toBe(true)
  })

  it('이모지가 든 이름을 잘라도 깨진 문자를 남기지 않는다', () => {
    // 바이트나 UTF-16 코드 유닛으로 자르면 서러게이트 쌍이 반토막 난다.
    const name = peerSessionName('repo', '🚀'.repeat(100))
    expect(Array.from(name)).toHaveLength(64)
    expect(name).not.toContain('�')
    expect([...name].every((ch) => ch === '🚀' || !/[\uD800-\uDFFF]/.test(ch))).toBe(true)
  })

  it('제어문자·제로폭 문자를 걷어낸다', () => {
    // CLI 가 표시명에 적용하는 정규화를 미리 맞춘다 — 양방향 제어문자가 남으면 목록에서
    // 이름이 거꾸로 렌더될 수 있다.
    expect(peerSessionName('re​po', 'fe‮at')).toBe('wooi/repo/feat')
  })
})

describe('nativePeerInbound', () => {
  it('저장된 정책이 없으면 앱 바깥 세션에는 refuse 다', () => {
    // 앱 안의 자동 전달 기본값을 네이티브 경로까지 넓히지 않는 보안 경계다.
    expect(nativePeerInbound(undefined)).toBe('refuse')
  })

  it('hold 는 refuse 로 접는다', () => {
    // 네이티브 hold 는 CLI 승인 다이얼로그가 있어야 풀리는데 SDK 세션은 그것을 못 띄우고
    // 풀어 줄 API 도 없다 — 그대로 넘기면 메시지가 영영 갇힌다.
    expect(nativePeerInbound('hold')).toBe('refuse')
  })

  it('refuse 는 그대로 refuse', () => {
    expect(nativePeerInbound('refuse')).toBe('refuse')
  })

  it('accept 만 바깥 세션에게 문을 연다', () => {
    // 사용자가 명시적으로 자동 수신을 켠 워크스페이스뿐이다.
    expect(nativePeerInbound('accept')).toBe('accept')
  })
})
