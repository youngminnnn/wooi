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

describe('대화 밀도 3단계', () => {
  const ITEMS = [
    { id: 'user:1', type: 'user', text: 'fix the parser', ts: 1 },
    { id: 'think:1', type: 'thinking', text: 'weighing options', ts: 2 },
    {
      id: 'use:1',
      type: 'tool_use',
      name: 'Read',
      input: { file_path: '/tmp/sunny-bison/parser.ts' },
      toolId: 'call-read',
      ts: 3
    },
    {
      id: 'res:1',
      type: 'tool_result',
      toolId: 'call-read',
      text: 'const parse = () => {}\nsecond line\nthird line\nfourth line\nfifth line\nsixth line',
      isError: false,
      ts: 4
    },
    {
      id: 'use:2',
      type: 'tool_use',
      name: 'Edit',
      input: { file_path: '/tmp/sunny-bison/parser.ts' },
      toolId: 'call-edit',
      diff: '--- a/parser.ts\n+++ b/parser.ts\n+const parse = (s: string) => {}',
      ts: 5
    },
    { id: 'assistant:1', type: 'assistant', text: 'Parser fixed.', ts: 6 }
  ]

  function renderAt(density: 'summary' | 'normal' | 'verbose') {
    const ws = workspace()
    useStore.setState({
      app: app([ws]),
      selectedWorkspaceId: ws.id,
      gitStatus: { [ws.id]: git() },
      prStatus: { [ws.id]: pr('open') },
      loadedTranscripts: { [ws.id]: true },
      transcripts: { [ws.id]: ITEMS as never },
      transcriptDensity: { [ws.id]: density }
    })
    return renderWithStore(<ChatView workspace={ws} />)
  }

  it('Normal 은 전부 그리되 도구 결과는 접어 둔다 — 지금까지의 기본 상태', () => {
    renderAt('normal')

    expect(screen.getByText('Parser fixed.')).toBeInTheDocument()
    expect(screen.getByText('Read')).toBeInTheDocument()
    expect(screen.getByText('Thinking')).toBeInTheDocument()
    // 결과는 앞 몇 줄만 — 뒤쪽 줄은 펼치기 전에는 없다.
    expect(screen.queryByText(/fourth line/)).not.toBeInTheDocument()
  })

  it('Verbose 는 도구 결과를 펴 둔 채로 시작한다', () => {
    renderAt('verbose')

    expect(screen.getByText('Read')).toBeInTheDocument()
    expect(screen.getByText(/fourth line/)).toBeInTheDocument()
  })

  it('Summary 는 최종 응답과 바뀐 파일만 남기고, 몇 걸음을 접었는지 알린다', () => {
    renderAt('summary')

    expect(screen.getByText('Parser fixed.')).toBeInTheDocument()
    expect(screen.getByText('fix the parser')).toBeInTheDocument()
    // 바꾼 것은 남는다. 다만 diff 원문은 아니고 "무엇을 바꿨는지" 만.
    expect(screen.getByText('Edit')).toBeInTheDocument()
    expect(screen.queryByText(/const parse = \(s: string\)/)).not.toBeInTheDocument()
    // 중간 단계는 사라진다.
    expect(screen.queryByText('Read')).not.toBeInTheDocument()
    expect(screen.queryByText('Thinking')).not.toBeInTheDocument()
    // 성긴 화면이 고장이 아니라 밀도 때문임을 화면이 말해 준다.
    expect(screen.getByText(/Summary hides 2 steps/)).toBeInTheDocument()
  })

  it('상태줄이 현재 밀도를 말하고, 눌러서 바꿀 수 있다', async () => {
    const user = userEvent.setup()
    const ws = workspace()
    useStore.setState({
      app: app([ws]),
      selectedWorkspaceId: ws.id,
      gitStatus: { [ws.id]: git() },
      prStatus: { [ws.id]: pr('open') },
      loadedTranscripts: { [ws.id]: true },
      transcripts: { [ws.id]: ITEMS as never }
    })
    renderWithStore(<ChatView workspace={ws} />)

    await user.click(screen.getByText('Normal'))
    await user.click(screen.getByText('Summary'))

    expect(useStore.getState().transcriptDensity[ws.id]).toBe('summary')
    expect(screen.queryByText('Read')).not.toBeInTheDocument()
  })
})
