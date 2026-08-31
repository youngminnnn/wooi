import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, screen } from '@testing-library/react'
import type { AppState, ConfirmSkipKey } from '@shared/types'
import ConfirmDialog from './ConfirmDialog'
import { app } from '../test/fixtures'
import { fakeApi, renderWithStore, resetStore, useStore } from '../test/harness'

/** confirmSkips 를 지정한 AppState. fixtures 의 app() 은 설정을 최소로만 채운다. */
function appWith(confirmSkips: Partial<Record<ConfirmSkipKey, boolean>>): AppState {
  const state = app([])
  return { ...state, settings: { ...state.settings, confirmSkips } } as AppState
}

const ARCHIVE = {
  title: 'Archive "wooi"?',
  confirmLabel: 'Archive',
  danger: true,
  skipKey: 'archiveWorkspace'
} as const

/** 대화상자를 연다. 스토어 직접 호출이라 React 밖의 갱신이므로 act 로 감싼다. */
function open(opts: Parameters<ReturnType<typeof useStore.getState>['confirm']>[0]) {
  let answer!: Promise<boolean>
  act(() => {
    answer = useStore.getState().confirm(opts)
  })
  return answer
}

function close(ok: boolean): void {
  act(() => useStore.getState().resolveConfirm(ok))
}

/** settings.update 로 넘어간 마지막 패치. */
function lastSettingsPatch(): Record<string, unknown> | undefined {
  return fakeApi.called('settings.update').at(-1)?.args[0] as Record<string, unknown> | undefined
}

beforeEach(() => {
  resetStore()
  useStore.setState({ app: appWith({}) })
})

describe('확인 대화상자의 "다시 묻지 않기"', () => {
  it('skipKey 가 있을 때만 체크박스를 그린다', () => {
    renderWithStore(<ConfirmDialog />)

    void open({ title: 'Delete for good?' })
    expect(screen.queryByLabelText("Don't ask again")).not.toBeInTheDocument()
    close(false)

    void open(ARCHIVE)
    expect(screen.getByLabelText("Don't ask again")).toBeInTheDocument()
  })

  it('체크하고 승인하면 그 종류만 끄고, 되돌릴 자리로 데려가는 토스트를 띄운다', async () => {
    renderWithStore(<ConfirmDialog />)
    const answer = open(ARCHIVE)

    fireEvent.click(screen.getByLabelText("Don't ask again"))
    await act(async () => {
      fireEvent.click(screen.getByText('Archive'))
    })

    expect(await answer).toBe(true)
    expect(lastSettingsPatch()).toEqual({ confirmSkips: { archiveWorkspace: true } })

    const toast = useStore.getState().toasts.at(-1)
    expect(toast?.message).toContain('archiving a workspace')
    expect(toast?.actions?.[0]?.label).toBe('Open settings')
  })

  it('체크했더라도 취소하면 저장하지 않는다', async () => {
    renderWithStore(<ConfirmDialog />)
    const answer = open(ARCHIVE)

    fireEvent.click(screen.getByLabelText("Don't ask again"))
    await act(async () => {
      fireEvent.click(screen.getByText('Cancel'))
    })

    expect(await answer).toBe(false)
    expect(fakeApi.called('settings.update')).toHaveLength(0)
  })

  it('열자마자 들어온 Enter 로 승인돼도 스킵은 저장되지 않는다', async () => {
    // Enter 로 연 대화상자가 그 Enter 로 즉시 승인되는 알려진 함정 — 체크박스가 꺼진 채로
    // 열리므로 사용자가 의도한 적 없는 스킵이 저장되면 안 된다.
    renderWithStore(<ConfirmDialog />)
    const answer = open(ARCHIVE)

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter' })
    })

    expect(await answer).toBe(true)
    expect(fakeApi.called('settings.update')).toHaveLength(0)
  })

  it('이미 꺼 둔 확인은 대화상자를 띄우지 않고 통과시킨다', async () => {
    useStore.setState({ app: appWith({ archiveWorkspace: true }) })
    renderWithStore(<ConfirmDialog />)

    expect(await open(ARCHIVE)).toBe(true)
    expect(screen.queryByText('Archive "wooi"?')).not.toBeInTheDocument()

    // 다른 종류는 그대로 묻는다 — 하나를 끈다고 전부 꺼지지 않는다.
    void open({ ...ARCHIVE, title: 'Archive review?', skipKey: 'archiveReview' })
    expect(screen.getByText('Archive review?')).toBeInTheDocument()
  })

  it('대화상자를 다시 열면 체크박스는 꺼진 상태로 돌아온다', () => {
    renderWithStore(<ConfirmDialog />)

    void open(ARCHIVE)
    fireEvent.click(screen.getByLabelText("Don't ask again"))
    expect(screen.getByLabelText("Don't ask again")).toBeChecked()
    close(false)

    void open(ARCHIVE)
    expect(screen.getByLabelText("Don't ask again")).not.toBeChecked()
  })
})
