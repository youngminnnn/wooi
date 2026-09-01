import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import SplitPanes from './SplitPanes'
import { app, git, workspace } from '../test/fixtures'
import { renderWithStore, resetStore, useStore } from '../test/harness'

const parent = workspace({ id: 'parent', name: 'parent' })
const child = workspace({ id: 'child', name: 'child', parentWorkspaceId: 'parent' })

beforeEach(() => resetStore())

function renderSplit(focus: 'main' | 'split' = 'split'): HTMLElement {
  useStore.setState({
    app: app([parent, child]),
    selectedWorkspaceId: parent.id,
    splitPane: { kind: 'workspace', workspaceId: child.id },
    splitFocus: focus,
    gitStatus: { [parent.id]: git(), [child.id]: git() },
    loadedTranscripts: { [parent.id]: true, [child.id]: true }
  })
  const { container } = renderWithStore(
    <SplitPanes
      main={{ kind: 'workspace', workspaceId: parent.id }}
      split={{ kind: 'workspace', workspaceId: child.id }}
      contentWidth={1000}
    />
  )
  return container
}

const pane = (container: HTMLElement, slot: 'main' | 'split'): HTMLElement =>
  container.querySelector<HTMLElement>(`[data-pane="${slot}"]`)!

describe('나란히 편 두 칸', () => {
  it('두 워크스페이스의 대화를 동시에 그린다', () => {
    renderSplit()

    expect(screen.getByText('parent')).toBeInTheDocument()
    expect(screen.getByText('child')).toBeInTheDocument()
  })

  it('포커스된 칸에만 테두리를 준다 — 다음 사이드바 클릭이 어디로 갈지 보여야 한다', () => {
    const container = renderSplit('split')

    expect(pane(container, 'split').dataset.paneFocused).toBe('true')
    expect(pane(container, 'main').dataset.paneFocused).toBeUndefined()
    expect(pane(container, 'split').className).toContain('ring-[var(--focus-ring)]')
  })

  it('칸 안을 누르면 그 칸이 포커스를 가져간다', () => {
    const container = renderSplit('split')

    fireEvent.mouseDown(pane(container, 'main'))

    expect(useStore.getState().splitFocus).toBe('main')
  })

  it('주 칸만 폭을 정하고 나머지는 오른쪽 칸이 가져간다', () => {
    useStore.setState({ splitFraction: 0.6 })
    const container = renderSplit()

    expect(pane(container, 'main').style.width).toBe('60%')
    expect(pane(container, 'split').style.width).toBe('')
  })
})
