import { beforeEach, describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

describe('충돌 해결 턴은 접혀 있다', () => {
  const PROMPT = [
    'Branch feat/test is being rebased onto main, and a rebase is currently in progress.',
    '',
    'Conflicted files:',
    '- src/a.ts',
    '- src/b.ts'
  ].join('\n')

  function renderResolveTurn(auto: boolean) {
    const ws = workspace()
    useStore.setState({
      app: app([ws]),
      selectedWorkspaceId: ws.id,
      gitStatus: { [ws.id]: git() },
      prStatus: { [ws.id]: pr('open') },
      loadedTranscripts: { [ws.id]: true },
      transcripts: {
        [ws.id]: [
          {
            id: 'user:1',
            type: 'user',
            text: PROMPT,
            ts: 1,
            origin: { kind: 'conflictResolve', branch: 'feat/test', fileCount: 2, auto }
          }
        ]
      }
    })
    return renderWithStore(<ChatView workspace={ws} />)
  }

  // 감추는 것이 아니라 접는 것이다 — 눌러서 펼치면 전문이 그대로 있어야 한다.
  it('전문 대신 한 줄만 두고, 펼치면 전문이 나온다', async () => {
    const user = userEvent.setup()
    renderResolveTurn(false)

    const fold = screen.getByText('Resolve rebase conflict on').closest('button')!
    expect(screen.getByText('· 2 files')).toBeInTheDocument()
    expect(fold).toHaveAttribute('aria-expanded', 'false')
    expect(fold.textContent).not.toContain('- src/a.ts')

    await user.click(fold)
    expect(fold).toHaveAttribute('aria-expanded', 'true')
    expect(fold.textContent).toContain(PROMPT)
  })

  it('자동으로 시작된 턴은 접힌 채로도 그렇다고 읽힌다', () => {
    renderResolveTurn(true)

    expect(screen.getByText('auto')).toBeInTheDocument()
  })
})
