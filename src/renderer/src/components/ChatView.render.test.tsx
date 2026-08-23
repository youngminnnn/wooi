import { beforeEach, describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import ChatView from './ChatView'
import { app, git, pr, workspace } from '../test/fixtures'
import { renderWithStore, resetStore, useStore } from '../test/harness'

beforeEach(() => resetStore())

function renderChat(options: { merged?: boolean; needsBaseUpdate?: boolean } = {}) {
  const ws = workspace()
  useStore.setState({
    app: app([ws]),
    selectedWorkspaceId: ws.id,
    gitStatus: { [ws.id]: git({ behind: 0 }) },
    prStatus: {
      [ws.id]: pr(options.merged ? 'merged' : 'open', {
        needsBaseUpdate: options.needsBaseUpdate ?? false
      })
    },
    loadedTranscripts: { [ws.id]: true }
  })
  return renderWithStore(<ChatView workspace={ws} />)
}

describe('대화 헤더 파생 상태 표시', () => {
  it('git은 최신이어도 PR이 branch update를 요구하면 rebase 액션을 활성화한다', () => {
    renderChat({ needsBaseUpdate: true })

    expect(screen.getByTitle('Rebase onto main')).toBeEnabled()
  })

  it('PR이 merged면 뒤처져 있어도 rebase 액션을 숨긴다', () => {
    const ws = workspace()
    useStore.setState({
      app: app([ws]),
      selectedWorkspaceId: ws.id,
      gitStatus: { [ws.id]: git({ behind: 3 }) },
      prStatus: { [ws.id]: pr('merged', { needsBaseUpdate: true }) },
      loadedTranscripts: { [ws.id]: true }
    })
    renderWithStore(<ChatView workspace={ws} />)

    expect(screen.queryByTitle('Rebase onto main')).not.toBeInTheDocument()
  })

  it('좁은 pane에서도 식별 영역이 남도록 헤더를 container 기준으로 구성한다', () => {
    const { container } = renderChat()

    expect(container.querySelector('.workspace-header')).toBeInTheDocument()
    expect(container.querySelector('.workspace-header-identity')).toBeInTheDocument()
    expect(container.querySelector('.workspace-header-actions')).toBeInTheDocument()
    expect(screen.getByText('Renderer tests')).toBeVisible()
  })
})
