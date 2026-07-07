import type { ThemePreference } from '@shared/types'

// 권위 있는 설정은 main 의 store 에 있지만, 그 값은 비동기로 도착한다. 시작 시 다크→라이트
// 깜빡임을 막기 위해 마지막 선호를 localStorage 에 캐시해 두고 첫 페인트 전에 적용한다.
const CACHE_KEY = 'ditto.theme'

const media = (): MediaQueryList => window.matchMedia('(prefers-color-scheme: dark)')

/** 'system' 선호를 실제 적용할 'light' | 'dark' 로 해석한다. */
function resolve(pref: ThemePreference): 'light' | 'dark' {
  if (pref === 'system') return media().matches ? 'dark' : 'light'
  return pref
}

/** <html> 의 data-theme 속성을 갱신한다 — index.css 의 토큰이 여기에 반응한다. */
function paint(pref: ThemePreference): void {
  document.documentElement.dataset.theme = resolve(pref)
}

let unwatch: (() => void) | null = null

/**
 * 테마를 적용하고, 'system' 일 때는 OS 설정 변화를 구독한다.
 * 선호가 바뀔 때마다 호출하면 이전 구독은 정리된다.
 */
export function applyTheme(pref: ThemePreference): void {
  paint(pref)
  try {
    localStorage.setItem(CACHE_KEY, pref)
  } catch {
    /* private 모드 등에서 실패해도 무시 — 캐시는 깜빡임 방지용일 뿐이다. */
  }

  unwatch?.()
  unwatch = null

  if (pref === 'system') {
    const mq = media()
    const onChange = (): void => paint('system')
    mq.addEventListener('change', onChange)
    unwatch = () => mq.removeEventListener('change', onChange)
  }
}

/** 첫 페인트 전에 캐시된 선호를 적용한다(설정이 도착하기 전 깜빡임 방지). 기본 다크. */
export function bootstrapTheme(): void {
  let pref: ThemePreference = 'dark'
  try {
    const cached = localStorage.getItem(CACHE_KEY)
    if (cached === 'light' || cached === 'dark' || cached === 'system') pref = cached
  } catch {
    /* 무시 */
  }
  applyTheme(pref)
}
