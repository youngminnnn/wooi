import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, screen } from '@testing-library/react'
import Hint from './Hint'
import { app, git, pr, workspace } from '../test/fixtures'
import { renderWithStore, resetStore, useStore } from '../test/harness'
import { noteMouseSwitch } from '../lib/uiFlags'

beforeEach(() => resetStore())

/** 세션 상한 2개를 실제로 채우는 데 쓰는 상태 — anchor 없는 두 힌트(quick-switch·keyboard-switch)
 * 를 동시에 참으로 만든다. 워크스페이스 10개면 quick-switch(⌘K, >9)가 참이 되고, 마우스 전환
 * 3회면 keyboard-switch 도 참이 된다. 둘 다 anchor 가 없어 DOM 유무와 무관하게 바로 렌더된다 —
 * "세션 상한이 실제로 몇 개나 남아 있는지" 를 앵커 문제와 분리해서 확인하는 데 쓴다. */
function fillTwoRealSlots(ws: ReturnType<typeof workspace>): void {
  const extras = Array.from({ length: 9 }, (_, i) => workspace({ id: `extra-${i}` }))
  act(() => {
    useStore.setState((s) => ({
      app: s.app ? { ...s.app, workspaces: [ws, ...extras] } : s.app
    }))
    noteMouseSwitch()
    noteMouseSwitch()
    noteMouseSwitch()
  })
  expect(screen.getByText(/Only the top 9 rows/)).toBeInTheDocument()
  fireEvent.click(screen.getByLabelText('Dismiss hint'))
  expect(screen.getByText(/Switch workspaces without leaving the keyboard/)).toBeInTheDocument()
}

describe('Hint — 세션당 상한은 실제로 화면에 뜬 힌트만 센다', () => {
  it('앵커가 DOM 에 없어 안 뜬 힌트는 세션 상한을 먹지 않는다', () => {
    // review-pr 만 참인 상태를 만든다: 승인 대기 없음(permission-mode 꺼짐), 변경 파일 없음·
    // ahead 0(work-panel/open-pr 꺼짐), 워크스페이스 1개(quick-switch/shortcuts 꺼짐), 마우스
    // 전환 0회(keyboard-switch 꺼짐).
    const ws = workspace()
    useStore.setState({
      app: app([ws]),
      selectedWorkspaceId: ws.id,
      gitStatus: { [ws.id]: git({ changedFiles: 0, ahead: 0 }) },
      prStatus: { [ws.id]: pr('open') }
    })

    const { container } = renderWithStore(<Hint anyModalOpen={false} />)

    // review-pr 의 앵커(data-tour="review-pr")는 Overview 화면에만 있다 — 이 테스트는 App 셸
    // 없이 <Hint /> 만 그리므로 DOM 에 없다. 렌더되면 안 된다(가리킬 게 없으면 알릴 때가 아니다).
    expect(container).toBeEmptyDOMElement()

    // review-pr 을 끄고(prStatus 를 merged 로) 진짜로 뜰 수 있는 두 힌트로 세션 상한을 채운다.
    // review-pr 이 몰래 슬롯 하나를 먹었다면 두 번째(keyboard-switch)에서 이미 막혔어야 한다.
    act(() => useStore.setState({ prStatus: { [ws.id]: pr('merged') } }))
    fillTwoRealSlots(ws)

    // 닫으면 shortcuts 가 조건상 다음 차례지만, 세션 상한(2개)에 이미 도달했으므로 뜨지 않는다.
    fireEvent.click(screen.getByLabelText('Dismiss hint'))
    expect(screen.queryByText(/full shortcut list/)).not.toBeInTheDocument()
    expect(container).toBeEmptyDOMElement()
  })

  it('Show tips 를 끈 동안에는 세션 상한이 자라지 않는다 — 다시 켜면 2개를 온전히 다시 쓸 수 있다', () => {
    // review-pr 이 유일한 후보가 되는 상태를 Show tips 를 끈 채로 만든다 — 힌트가 "뽑히기만
    // 하고 꺼져서 안 그려지는" 동안 세션 카운트가 늘지 않는지가 요점이다.
    const ws = workspace()
    useStore.setState({
      app: { ...app([ws]), settings: { ...app([ws]).settings, showHints: false } },
      selectedWorkspaceId: ws.id,
      gitStatus: { [ws.id]: git({ changedFiles: 0, ahead: 0 }) },
      prStatus: { [ws.id]: pr('open') }
    })

    const { container } = renderWithStore(<Hint anyModalOpen={false} />)
    // Show tips 가 꺼져 있으니 조건은 참이어도 아무것도 그리지 않는다.
    expect(container).toBeEmptyDOMElement()

    // 다시 켠다 — 꺼져 있던 동안 아무것도 "본 적" 이 없으니, 세션 상한 2개가 그대로 남아 있어야
    // 한다(review-pr 도 앵커가 없어 여전히 안 뜬다 — 대신 anchor 없는 두 힌트로 확인한다).
    act(() =>
      useStore.setState((s) => ({
        app: s.app ? { ...s.app, settings: { ...s.app.settings, showHints: true } } : s.app,
        prStatus: { [ws.id]: pr('merged') }
      }))
    )
    fillTwoRealSlots(ws)
  })

  it('모달이 떠 있는 동안은 안 그리지만, 리마운트 없이 세션 상한을 그대로 지킨다', () => {
    // anyModalOpen=true 로 마운트한다 — App.tsx 가 Settings 등 어떤 모달이든 열려 있을 때
    // 넘기는 값과 같다. Hint 는 그동안 언마운트되지 않고 계속 살아 있어야 한다(그래야 세션
    // 카운터가 모달을 열고 닫을 때마다 리셋되지 않는다).
    const ws = workspace()
    useStore.setState({
      app: app([ws]),
      selectedWorkspaceId: ws.id,
      gitStatus: { [ws.id]: git({ changedFiles: 0, ahead: 0 }) },
      prStatus: { [ws.id]: pr('open') }
    })

    const { container, rerender } = renderWithStore(<Hint anyModalOpen={true} />)
    expect(container).toBeEmptyDOMElement()

    // 모달을 닫는다(anyModalOpen: true → false) — 언마운트/재마운트가 아니라 같은 인스턴스의
    // prop 변화다. review-pr 은 앵커가 없어 여전히 안 뜨지만, 세션 상한 2개는 온전해야 한다.
    act(() => useStore.setState({ prStatus: { [ws.id]: pr('merged') } }))
    rerender(<Hint anyModalOpen={false} />)
    fillTwoRealSlots(ws)
  })
})
