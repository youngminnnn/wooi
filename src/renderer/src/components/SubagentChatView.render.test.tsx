import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import SubagentChatView from './SubagentChatView'
import { app, workspace } from '../test/fixtures'
import { fakeApi, renderWithStore, resetStore, useStore } from '../test/harness'
import type { ChatItem, Workspace } from '@shared/types'

beforeEach(() => resetStore())

/**
 * 이 화면이 지키는 계약은 두 가지다.
 *
 * **격리** — 이 서브에이전트의 대화만 보인다. 부모의 말도, 옆 서브에이전트의 말도 섞이지 않는다.
 * 그러지 못하면 화면을 갈라 둔 이유가 사라진다.
 *
 * **보내기의 정직함** — 부를 수 있을 때만 입력창이 열리고, 못 부를 때는 **이유**가 보인다.
 * 그리고 부를 수 있을 때도 릴레이라는 사실을 감추지 않는다.
 */

const WS = 'ws1'

function ws(): Workspace {
  return { ...workspace(), id: WS }
}

function row(over: Partial<Extract<ChatItem, { type: 'subagent' }>> = {}): ChatItem {
  return {
    id: `subagent:${over.toolId ?? 't1'}`,
    type: 'subagent',
    toolId: 't1',
    taskId: 'task-1',
    backend: 'claude',
    agentType: 'Explore',
    description: 'Find the config loader',
    status: 'running',
    ts: Date.now(),
    ...over
  }
}

function spawn(toolId: string, name?: string): ChatItem {
  return {
    id: `use:${toolId}`,
    type: 'tool_use',
    toolId,
    name: 'Agent',
    input: { subagent_type: 'Explore', ...(name ? { name } : {}) },
    ts: Date.now()
  }
}

function seed(items: ChatItem[]): void {
  useStore.setState({
    // Composer 는 앱 설정(rate limit·백엔드 기본값)을 읽으므로 app 이 없으면 마운트되지 않는다.
    app: app([ws()]),
    selectedWorkspaceId: WS,
    selectedSubagent: { workspaceId: WS, toolId: 't1' },
    transcripts: { [WS]: items },
    loadedTranscripts: { [WS]: true }
  })
}

describe('서브에이전트 대화 화면', () => {
  it('이 서브에이전트의 말만 그리고 부모·옆 실행은 섞지 않는다', () => {
    seed([
      spawn('t1', 'explorer'),
      row(),
      row({ toolId: 't2' }),
      { id: 'p1', type: 'assistant', text: 'parent talking', ts: Date.now() },
      { id: 'a1', type: 'assistant', text: 'mine', ts: Date.now(), parentToolId: 't1' },
      { id: 'a2', type: 'assistant', text: 'the other one', ts: Date.now(), parentToolId: 't2' }
    ])
    renderWithStore(<SubagentChatView workspace={ws()} toolId="t1" />)

    expect(screen.getByText('mine')).toBeInTheDocument()
    expect(screen.queryByText('parent talking')).not.toBeInTheDocument()
    expect(screen.queryByText('the other one')).not.toBeInTheDocument()
  })

  it('이름이 있고 도는 중이면 입력창이 열리고, 릴레이라는 것을 밝힌다', () => {
    seed([spawn('t1', 'explorer'), row()])
    renderWithStore(<SubagentChatView workspace={ws()} toolId="t1" />)

    expect(screen.getByText(/Relayed through/)).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('Codex 서브에이전트에 내부 기록이 없으면 상태 안내만 보인다', () => {
    // Codex wire 는 subagent activity row 만 보내며 그 자식 transcript 는 보내지 않는다.
    seed([row({ backend: 'codex', status: 'completed' })])
    renderWithStore(<SubagentChatView workspace={ws()} toolId="t1" />)

    expect(screen.getByText(/internal transcript is not available from Codex/i)).toBeInTheDocument()
    expect(screen.getByText(/status and activity are shown above/i)).toBeInTheDocument()
    expect(screen.queryByText('Start an agent session')).not.toBeInTheDocument()
  })

  it('Claude 서브에이전트에 내부 기록이 없으면 기존 onboarding을 보인다', () => {
    seed([row({ backend: 'claude' })])
    renderWithStore(<SubagentChatView workspace={ws()} toolId="t1" />)

    expect(screen.getByText('Start an agent session')).toBeInTheDocument()
    expect(
      screen.queryByText(/internal transcript is not available from Codex/i)
    ).not.toBeInTheDocument()
  })

  it('보내면 그 task id 를 주소로 릴레이를 부른다', () => {
    // 주소는 이름이 아니라 SDK 의 task id 다 — 화면에 보이는 이름(Explore)과 부모가
    // SendMessage 에 실을 값이 다르다는 것이 이 단언의 요점이다.
    seed([spawn('t1', 'explorer'), row()])
    renderWithStore(<SubagentChatView workspace={ws()} toolId="t1" />)

    const box = screen.getByRole('textbox')
    fireEvent.change(box, { target: { value: 'check the loader again' } })
    fireEvent.keyDown(box, { key: 'Enter' })

    expect(fakeApi.calls).toContainEqual({
      path: 'chat.sendToSubagent',
      args: [WS, 't1', 'task-1', 'check the loader again']
    })
  })

  it('주소가 없으면 잠그고 이유를 적는다', () => {
    // 위임 실행·Codex collab 이 여기 걸린다 — SDK 의 task 가 아니라 task id 가 없다.
    const noTask = { ...row() } as Record<string, unknown>
    delete noTask.taskId
    seed([spawn('t1'), noTask as ChatItem])
    renderWithStore(<SubagentChatView workspace={ws()} toolId="t1" />)

    expect(screen.getByText(/no address the main agent can send to/)).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('끝난 실행은 잠그고 그 이유를 적는다', () => {
    seed([spawn('t1', 'explorer'), row({ status: 'completed' })])
    renderWithStore(<SubagentChatView workspace={ws()} toolId="t1" />)

    expect(screen.getByText(/has finished/)).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('도는 실행만 중지할 수 있다', () => {
    seed([spawn('t1', 'explorer'), row()])
    const { unmount } = renderWithStore(<SubagentChatView workspace={ws()} toolId="t1" />)
    expect(screen.getByRole('button', { name: /^Stop subagent/ })).toBeInTheDocument()
    unmount()

    seed([spawn('t1', 'explorer'), row({ status: 'completed' })])
    renderWithStore(<SubagentChatView workspace={ws()} toolId="t1" />)
    expect(screen.queryByRole('button', { name: /^Stop subagent/ })).not.toBeInTheDocument()
  })

  it('기록이 사라졌으면 빈 화면에 가두지 않고 돌아갈 길을 준다', () => {
    seed([])
    renderWithStore(<SubagentChatView workspace={ws()} toolId="t1" />)

    fireEvent.click(screen.getByRole('button', { name: /^Back to/ }))
    expect(useStore.getState().selectedSubagent).toBeNull()
  })
})
