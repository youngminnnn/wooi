import { act } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import LiveRegion from './LiveRegion'
import { announce } from '../lib/announce'
import { app, workspace } from '../test/fixtures'
import { renderWithStore, resetStore, useStore } from '../test/harness'

/**
 * 문장을 **고르는** 규칙은 `lib/announce.test.ts` 가 순수 함수로 검사한다. 여기서 보는 것은
 * 배선뿐이다 — 이 기능은 화면에 아무것도 그리지 않아서, 호스트가 조용히 마운트되지 않거나
 * 스토어를 잘못 구독해도 눈으로는 영영 알 수 없다.
 */
beforeEach(() => resetStore())

function setStatus(status: 'idle' | 'running' | 'error'): void {
  act(() => {
    const ws = workspace({ status })
    useStore.setState({ app: app([ws]), selectedWorkspaceId: ws.id })
  })
}

describe('LiveRegion', () => {
  it('처음 마운트될 때는 비어 있다 — 라이브 리전은 초기 내용을 읽지 않는다', () => {
    setStatus('running')
    renderWithStore(<LiveRegion />)
    for (const region of screen.getAllByRole('status')) expect(region).toHaveTextContent('')
  })

  it('턴이 시작하고 끝나면 polite 리전에 문장이 들어간다', () => {
    setStatus('idle')
    renderWithStore(<LiveRegion />)

    setStatus('running')
    expect(screen.getByText('sunny-bison started running.')).toBeInTheDocument()

    setStatus('idle')
    expect(screen.getByText('sunny-bison finished.')).toBeInTheDocument()
  })

  it('오류는 assertive 리전으로 간다', () => {
    setStatus('running')
    renderWithStore(<LiveRegion />)

    setStatus('error')
    expect(screen.getByRole('alert')).toHaveTextContent('sunny-bison stopped with an error.')
  })

  it('토스트 내용을 polite 로 읽는다', () => {
    renderWithStore(<LiveRegion />)
    act(() => {
      useStore.getState().pushToast('error', 'Could not archive the merged workspaces.')
    })
    expect(screen.getByText('Could not archive the merged workspaces.')).toBeInTheDocument()
  })

  it('스토어 밖의 사건(ErrorBoundary)도 같은 호스트로 들어온다', () => {
    renderWithStore(<LiveRegion />)
    act(() => announce('Something broke in Settings. boom', 'assertive'))
    expect(screen.getByRole('alert')).toHaveTextContent('Something broke in Settings. boom')
  })

  it('리전은 화면에 보이지 않는다 — 시각적 변경이 없어야 한다', () => {
    renderWithStore(<LiveRegion />)
    const regions = [...screen.getAllByRole('status'), screen.getByRole('alert')]
    expect(regions).toHaveLength(3)
    for (const region of regions) expect(region).toHaveClass('sr-only')
  })
})
