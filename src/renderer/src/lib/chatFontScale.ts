import { useEffect, useState } from 'react'

/**
 * 대화 화면에만 걸리는 글자 크기. ⌘+ / ⌘- / ⌘0 으로 즉시 조절한다.
 *
 * 앱 전체 줌이 아니라 채팅 표면만 키우는 것이 요점이다 — 전체를 키우면 사이드바·터미널까지
 * 따라 커져서, 정작 읽으려던 대화는 좁아진 폭 안에서 더 답답해진다.
 *
 * 설정으로 만들지 않았다. 이건 지금 이 화면을 크게 보고 싶다는 즉석 조작이지, 앱의 성격을 정하는
 * 선택이 아니다. 기억은 localStorage 한 줄이면 충분하다.
 */

export const MIN_CHAT_FONT_SCALE = 0.8
export const MAX_CHAT_FONT_SCALE = 1.6
export const DEFAULT_CHAT_FONT_SCALE = 1
export const CHAT_FONT_SCALE_STEP = 0.1

const STORAGE_KEY = 'wooi.chatFontScale'

/**
 * 읽을 수 있는 범위로 자르고, 부동소수 드리프트를 걷어 낸다.
 *
 * 0.1 을 반복해서 더하고 빼면 0.7999999999999999 같은 값이 남는다. 그대로 두면 배율이 경계에
 * 영영 닿지 못하고, 화면에 숫자로 내보낼 때도 지저분하다.
 */
export function clampChatFontScale(scale: number): number {
  if (!Number.isFinite(scale)) return DEFAULT_CHAT_FONT_SCALE
  const clamped = Math.min(MAX_CHAT_FONT_SCALE, Math.max(MIN_CHAT_FONT_SCALE, scale))
  return Math.round(clamped * 100) / 100
}

export function increaseChatFontScale(scale: number): number {
  return clampChatFontScale(scale + CHAT_FONT_SCALE_STEP)
}

export function decreaseChatFontScale(scale: number): number {
  return clampChatFontScale(scale - CHAT_FONT_SCALE_STEP)
}

export type ChatFontScaleAction = 'increase' | 'decrease' | 'reset' | null

/**
 * 키 하나를 배율 조작으로 옮긴다.
 *
 * primary 수식키가 **단독**일 때만 받는다 — ⌘⌃ 같은 조합까지 삼키면 다른 단축키가 죽는다.
 * Shift·Alt 는 보지 않는다: 많은 배열에서 `+` 는 ⇧`=` 라, Shift 를 막으면 확대가 반쪽이 된다.
 * `_` 와 `+` 를 함께 받는 것도 같은 이유다.
 */
export function chatFontScaleActionForEvent(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey'>,
  isMac: boolean
): ChatFontScaleAction {
  const primaryOnly = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!primaryOnly) return null
  switch (e.key) {
    case '=':
    case '+':
      return 'increase'
    case '-':
    case '_':
      return 'decrease'
    case '0':
      return 'reset'
    default:
      return null
  }
}

export function isMacPlatform(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.userAgent)
}

function readRememberedChatFontScale(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return DEFAULT_CHAT_FONT_SCALE
    return clampChatFontScale(Number(raw))
  } catch {
    /* 기억 실패는 기본 배율로 폴백한다. */
    return DEFAULT_CHAT_FONT_SCALE
  }
}

function rememberChatFontScale(scale: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(scale))
  } catch {
    /* 기억하지 못해도 이번 실행 동안은 배율이 유지된다. */
  }
}

/**
 * 배율과 ⌘+ / ⌘- / ⌘0 바인딩. `enabled` 가 거짓이면 키를 듣지 않는다 — 모달·파일 뷰어가
 * 대화를 덮고 있을 때 뒤쪽 글자만 조용히 커지면 사용자는 무슨 일이 일어났는지 알 수 없다.
 */
export function useChatFontScale(enabled: boolean): number {
  const [scale, setScale] = useState(readRememberedChatFontScale)

  // 기억은 effect 로 뺀다 — setState 갱신 함수 안에서 쓰면 StrictMode 의 이중 호출에
  // 부작용이 그대로 따라붙는다.
  useEffect(() => {
    rememberChatFontScale(scale)
  }, [scale])

  useEffect(() => {
    if (!enabled) return
    const isMac = isMacPlatform()
    const onKey = (e: KeyboardEvent): void => {
      const action = chatFontScaleActionForEvent(e, isMac)
      if (!action) return
      // 캡처로 잡고 기본 동작을 막는다 — 그러지 않으면 일렉트론의 페이지 줌이 함께 걸려
      // 사이드바와 터미널까지 커진다. 그걸 피하려고 만든 기능이다.
      e.preventDefault()
      e.stopPropagation()
      setScale((s) => {
        if (action === 'reset') return DEFAULT_CHAT_FONT_SCALE
        return action === 'increase' ? increaseChatFontScale(s) : decreaseChatFontScale(s)
      })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [enabled])

  return scale
}
