import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import StackTrainModal from './StackTrainModal'
import type { StackOpProgress } from '@shared/types'
import { app, workspace } from '../test/fixtures'
import { fakeApi, renderWithStore, resetStore, useStore } from '../test/harness'

const trainProgress = (over: Partial<StackOpProgress> = {}): StackOpProgress => ({
  workspaceId: 'w-bottom',
  kind: 'train',
  total: 2,
  done: [],
  current: { branch: 'feat/schema', kind: 'merge' },
  waiting: null,
  finished: false,
  startedAt: 1,
  ...over
})

beforeEach(() => {
  resetStore()
  fakeApi.reset()
  useStore.setState({
    app: app([workspace({ id: 'w-bottom', branch: 'feat/schema', baseBranch: 'main' })])
  })
  fakeApi.override('stack.trainPlan', () => ({
    layers: [{ branch: 'feat/schema', prNumber: 12, state: 'approved', blockedReason: null }],
    mergeableCount: 1,
    forcePushCount: 1,
    forcePushBranches: ['feat/api']
  }))
})

describe('머지 트레인 모달', () => {
  // 예전에는 실행 중 푸터가 onClick 없는 disabled 버튼("Merge train in progress") 하나였다.
  // 누를 수 없는 것을 버튼으로 두면 사용자는 눌러 보고 앱이 멎었다고 읽는다.
  it('실행 중에는 죽은 버튼 대신 취소와 백그라운드 실행을 준다', async () => {
    useStore.setState({ stackProgress: { 'w-bottom': trainProgress() } })

    renderWithStore(<StackTrainModal workspaceId="w-bottom" onClose={() => {}} />)

    expect(screen.queryByText('Merge train in progress')).toBeNull()
    const cancel = await screen.findByRole('button', { name: 'Cancel merge train' })
    expect(cancel).toBeEnabled()

    await userEvent.click(cancel)
    await waitFor(() => expect(fakeApi.called('stack.trainCancel')).toHaveLength(1))
    expect(fakeApi.called('stack.trainCancel')[0].args).toEqual(['w-bottom'])
    expect(await screen.findByRole('button', { name: 'Canceling…' })).toBeDisabled()
  })

  it('백그라운드로 보내면 모달만 닫고 트레인은 건드리지 않는다', async () => {
    const onClose = vi.fn()
    useStore.setState({ stackProgress: { 'w-bottom': trainProgress() } })

    renderWithStore(<StackTrainModal workspaceId="w-bottom" onClose={onClose} />)

    await userEvent.click(await screen.findByRole('button', { name: 'Run in background' }))
    expect(onClose).toHaveBeenCalled()
    expect(fakeApi.called('stack.trainCancel')).toHaveLength(0)
  })

  // CI 를 기다리는 동안은 아무 단계도 늘지 않는다 — 무엇을 기다리는지 적지 않으면 멎어 보인다.
  it('CI 를 기다리는 중이면 그 사유를 보여 준다', async () => {
    useStore.setState({
      stackProgress: {
        'w-bottom': trainProgress({
          current: null,
          waiting: { branch: 'feat/api', note: 'Checks are still running.', since: Date.now() }
        })
      }
    })

    renderWithStore(<StackTrainModal workspaceId="w-bottom" onClose={() => {}} />)

    expect(await screen.findByText('feat/api')).toBeInTheDocument()
    expect(screen.getByText(/Checks are still running/)).toBeInTheDocument()
  })

  // 트레인은 모달을 닫아 둔 사이에 끝날 수 있다. 다시 열면 결과부터 보여야 한다.
  it('다시 열었을 때 끝난 트레인이 있으면 결과 화면으로 들어간다', async () => {
    useStore.setState({
      stackProgress: {
        'w-bottom': trainProgress({
          current: null,
          finished: true,
          result: { mergedPrs: [12], steps: [], stoppedAt: null }
        })
      }
    })

    renderWithStore(<StackTrainModal workspaceId="w-bottom" onClose={() => {}} />)

    expect(await screen.findByText('Merge train complete.')).toBeInTheDocument()
    expect(fakeApi.called('stack.trainPlan')).toHaveLength(0)

    // 결과를 닫는 것이 곧 "다 봤다" — main 이 들고 있던 결과도 함께 치운다.
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(fakeApi.called('stack.progressDismiss')).toHaveLength(1))
  })
})
