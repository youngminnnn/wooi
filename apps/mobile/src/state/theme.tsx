import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'
import { Appearance, useColorScheme } from 'react-native'
import { create } from 'zustand'
import { darkTheme, themes, type Theme, type ThemeName, type ThemePreference } from '../theme'
import { loadThemePreference, saveThemePreference } from '../storage/secure'

/**
 * 기본값은 **폰 설정을 따르는 것**이다. 데스크톱과 같은 기본값이고(`storeSchema.ts` 의
 * `theme`), 한 번이라도 골랐다면 그 값이 SecureStore 에 남아 이 기본값은 쓰이지 않는다.
 */
const DEFAULT_PREFERENCE: ThemePreference = 'system'

interface ThemeStore {
  preference: ThemePreference
  /** 저장된 값을 읽어 오기 전인가. 첫 페인트에서 잘못된 테마를 깜빡이지 않으려고 본다. */
  hydrated: boolean
  setPreference: (preference: ThemePreference) => void
}

export const useThemeStore = create<ThemeStore>((set) => ({
  preference: DEFAULT_PREFERENCE,
  hydrated: false,
  setPreference: (preference): void => {
    set({ preference })
    applyNativeAppearance(preference)
    // 저장 실패는 삼킨다 — 키체인이 잠겼어도 이번 실행의 테마는 이미 바뀌었고, 그게 사용자가
    // 방금 요청한 일이다. 다음 실행에서 예전 값으로 돌아가는 편이 여기서 터지는 것보다 낫다.
    void saveThemePreference(preference).catch(() => undefined)
  }
}))

/**
 * 네이티브 크롬(키보드·Alert·시스템 대화상자)도 같이 맞춘다. 이걸 안 하면 앱은 라이트인데
 * 키보드만 검게 올라온다 — RN 컴포넌트가 아니라 OS 가 그리는 부분이라 스타일이 닿지 않는다.
 * `null` 은 "OS 를 따르라"는 뜻이라 'system' 선호와 정확히 같다.
 */
function applyNativeAppearance(preference: ThemePreference): void {
  Appearance.setColorScheme(preference === 'system' ? null : preference)
}

/** 저장된 선호를 읽어 스토어에 넣는다. 실패하면 기본값(system) 그대로 간다. */
export async function hydrateThemePreference(): Promise<void> {
  const stored = await loadThemePreference().catch(() => null)
  const preference = stored ?? DEFAULT_PREFERENCE
  applyNativeAppearance(preference)
  useThemeStore.setState({ preference, hydrated: true })
}

interface ThemeContextValue {
  name: ThemeName
  theme: Theme
}

// provider 없이 쓰이는 경로는 없지만 context 는 기본값을 요구한다. 다크를 둔다 — 이 값이
// 보인다면 provider 를 빠뜨렸다는 뜻이고, 그때 눈에 띄는 쪽이 낫다.
const ThemeContext = createContext<ThemeContextValue>({ name: 'dark', theme: darkTheme })

/**
 * 앱 전체의 테마. 선호가 'system' 일 때만 OS 설정을 읽는다 — 명시적으로 고른 경우
 * `Appearance.setColorScheme` 때문에 `useColorScheme()` 도 그 값을 돌려주므로 어차피 같지만,
 * 선호에서 직접 푸는 편이 두 경로가 어긋날 여지를 남기지 않는다.
 */
export function AppThemeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const preference = useThemeStore((store) => store.preference)
  const system = useColorScheme()
  const name: ThemeName =
    preference === 'system' ? (system === 'light' ? 'light' : 'dark') : preference
  const value = useMemo(() => ({ name, theme: themes[name] }), [name])

  // 선호가 바뀔 때마다 네이티브 쪽도 따라가야 한다. 기본값이 'system' 이라 하이드레이션
  // 전에도 첫 페인트가 이미 맞고, 명시적으로 골라 둔 사람만 값이 도착하는 순간 한 번 바뀐다.
  useEffect(() => {
    applyNativeAppearance(preference)
  }, [preference])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

/**
 * 하위 트리의 테마를 한 쪽으로 고정한다. 카메라 스캐너처럼 **앱 배경이 아니라 카메라 화면
 * 위에** 얹히는 UI 에 쓴다 — 그 위는 항상 어두운 뷰포트라, 앱이 라이트여도 흰 글자여야 한다.
 */
export function FixedTheme({
  name,
  children
}: {
  name: ThemeName
  children: ReactNode
}): React.JSX.Element {
  const value = useMemo(() => ({ name, theme: themes[name] }), [name])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

/** 지금 테마의 색 토큰. 스타일시트 밖에서 색이 필요할 때(아이콘 prop 등) 쓴다. */
export function useTheme(): Theme {
  return useContext(ThemeContext).theme
}

/** 지금 테마의 이름. 색이 아니라 밝기 자체가 필요한 곳(상태바 스타일)에서 쓴다. */
export function useThemeName(): ThemeName {
  return useContext(ThemeContext).name
}

type StyleFactory<T> = (theme: Theme) => T

/**
 * 테마별 스타일시트를 **한 번만** 만든다.
 *
 * 예전에는 `StyleSheet.create` 를 모듈 최상단에서 한 번 부르면 끝이었다. 테마가 둘이 되면
 * 값이 렌더 시점에 정해지지만, 그렇다고 컴포넌트마다 새로 만들면 같은 화면의 행 수백 개가
 * 각자 똑같은 스타일 객체를 들고 있게 된다. 팩토리 함수를 키로 캐시해 (팩토리 × 테마) 조합당
 * 하나만 남긴다 — 모듈 최상단 호출과 같은 비용으로 돌아온다.
 */
const styleCache = new WeakMap<StyleFactory<unknown>, Partial<Record<ThemeName, unknown>>>()

export function useThemedStyles<T>(factory: StyleFactory<T>): T {
  const { name, theme } = useContext(ThemeContext)
  return useMemo(() => {
    let byTheme = styleCache.get(factory as StyleFactory<unknown>)
    if (byTheme === undefined) {
      byTheme = {}
      styleCache.set(factory as StyleFactory<unknown>, byTheme)
    }
    byTheme[name] ??= factory(theme)
    return byTheme[name] as T
  }, [factory, name, theme])
}
