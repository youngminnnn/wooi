import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

/**
 * diff 안의 변경 덩어리 사이를 오간다 — 헤더의 이전/다음 버튼과 F7 / ⇧F7.
 *
 * **컨텍스트를 둘로 나눈 것이 요점이다.** 등록(`register`)은 한 번 만들고 영원히 같은 값이라
 * 덩어리 수가 바뀌어도 diff 본문은 다시 그리지 않는다. 개수(`count`)는 상태라서 바뀌면
 * 소비자가 다시 그리는데, 그 소비자는 헤더 버튼 하나뿐이다. 한 컨텍스트에 합치면 파일을
 * 펼칠 때마다 수만 행짜리 diff 가 통째로 리렌더된다 — 이 기능을 넣은 목적과 정확히 반대다.
 */

/**
 * 변경 덩어리 하나를 등록한다. React 19 의 ref 콜백 정리 함수를 그대로 쓴다 —
 * 정리 함수를 돌려주면 React 는 떼어낼 때 null 로 다시 부르지 않는다(타입만 null 을 받는다).
 */
type RegisterChange = (el: HTMLElement | null) => (() => void) | void

const noRegister: RegisterChange = () => {}

const RegistryContext = createContext<RegisterChange>(noRegister)

interface DiffNavValue {
  count: number
  goPrev: () => void
  goNext: () => void
}

const NO_NAV: DiffNavValue = { count: 0, goPrev: () => {}, goNext: () => {} }
const NavContext = createContext<DiffNavValue>(NO_NAV)

/**
 * 지금 화면에서 F7 을 받을 자격이 있는 핸들러들. **맨 뒤(가장 나중에 마운트된 것)만** 처리한다.
 *
 * DiffView 는 Changes 탭과 변경 보기 모달에 동시에 떠 있을 수 있다. 둘 다 키를 받으면 보이지도
 * 않는 뒤쪽 diff 까지 같이 스크롤한다. 모달은 뒤에 열리므로 스택의 맨 뒤가 곧 사용자가 보고
 * 있는 쪽이다.
 */
const keyStack: object[] = []

export function DiffNavProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const nodes = useRef(new Set<HTMLElement>())
  // 마지막으로 이동한 덩어리. 인덱스 대신 원소를 들고 있으면 diff 가 다시 읽혀 목록이 통째로
  // 바뀌어도 어긋난 자리로 뛰지 않는다 — 없어진 원소는 그냥 "처음부터" 로 떨어진다.
  const last = useRef<HTMLElement | null>(null)
  const [count, setCount] = useState(0)

  const register = useCallback<RegisterChange>((el) => {
    if (!el) return
    nodes.current.add(el)
    setCount(nodes.current.size)
    return () => {
      nodes.current.delete(el)
      if (last.current === el) last.current = null
      setCount(nodes.current.size)
    }
  }, [])

  const step = useCallback((delta: 1 | -1) => {
    // 등록 순서는 화면 순서가 아니다(파일을 펼친 순서대로 들어온다). 이동할 때 문서 순으로 세운다.
    const ordered = [...nodes.current].sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    )
    if (!ordered.length) return
    const at = last.current ? ordered.indexOf(last.current) : -1
    const next =
      at === -1
        ? delta === 1
          ? 0
          : ordered.length - 1
        : (at + delta + ordered.length) % ordered.length
    const el = ordered[next]
    last.current = el
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [])

  const goPrev = useCallback(() => step(-1), [step])
  const goNext = useCallback(() => step(1), [step])

  useEffect(() => {
    const token = {}
    keyStack.push(token)
    const onKey = (e: KeyboardEvent): void => {
      // 한글 IME 에서 e.key 가 흔들려 코드로 본다(App.tsx 의 규칙과 같다).
      if (e.code !== 'F7' || e.metaKey || e.ctrlKey || e.altKey) return
      if (keyStack[keyStack.length - 1] !== token) return
      // 뛸 자리가 없으면 키를 삼키지도 않는다 — 다른 곳이 쓸 기회를 뺏지 않는다.
      if (nodes.current.size === 0) return
      e.preventDefault()
      step(e.shiftKey ? -1 : 1)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      const i = keyStack.indexOf(token)
      if (i >= 0) keyStack.splice(i, 1)
    }
  }, [step])

  const nav = useMemo(() => ({ count, goPrev, goNext }), [count, goPrev, goNext])

  return (
    <RegistryContext.Provider value={register}>
      <NavContext.Provider value={nav}>{children}</NavContext.Provider>
    </RegistryContext.Provider>
  )
}

/**
 * 변경 덩어리 하나를 감싼다. 등록 컨텍스트만 읽으므로 개수가 바뀌어도 여기는 다시 그리지 않는다.
 * `register` 는 영원히 같은 함수라 React 가 매 렌더마다 ref 를 떼었다 붙이지도 않는다.
 */
export function DiffChangeAnchor({ children }: { children: React.ReactNode }): React.JSX.Element {
  const register = useContext(RegistryContext)
  return <div ref={register}>{children}</div>
}

export function useDiffNav(): DiffNavValue {
  return useContext(NavContext)
}
