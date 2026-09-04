import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ChatView from './ChatView'
import { app, git, pr, workspace } from '../test/fixtures'
import { fakeApi, renderWithStore, resetStore, useStore } from '../test/harness'

beforeEach(() => {
  resetStore()
  fakeApi.reset()
})

describe('⌘Enter — 턴을 멈추고 바로 보낸다', () => {
  it('interrupt 를 먼저 부르고 그 다음에 send 를 부른다(순서가 뒤집히면 메시지가 삼켜진다)', async () => {
    const ws = workspace({ status: 'running' })
    useStore.setState({
      app: app([ws]),
      selectedWorkspaceId: ws.id,
      gitStatus: { [ws.id]: git() },
      prStatus: { [ws.id]: pr('open') },
      loadedTranscripts: { [ws.id]: true }
    })
    renderWithStore(<ChatView workspace={ws} />)

    const textarea = screen.getByPlaceholderText(/Steer the agent while it works/)
    await userEvent.type(textarea, 'stop and do this instead')
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true })

    await waitFor(() => expect(fakeApi.called('chat.send')).toHaveLength(1))

    const interruptIndex = fakeApi.calls.findIndex((c) => c.path === 'chat.interrupt')
    const sendIndex = fakeApi.calls.findIndex((c) => c.path === 'chat.send')
    expect(interruptIndex).toBeGreaterThanOrEqual(0)
    expect(interruptIndex).toBeLessThan(sendIndex)
  })
})
