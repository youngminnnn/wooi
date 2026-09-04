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

/** 리전은 role 을 달지 않으므로(아래 테스트 참고) 전용 훅으로 집는다. */
function region(name: 'toast' | 'alert'): Element {
  const found = document.querySelector(`[data-live-region="${name}"]`)
  if (!found) throw new Error(`${name} 라이브 리전이 마운트되지 않았다`)
  return found
}

function setStatus(status: 'idle' | 'running' | 'error'): void {
  act(() => {
    const ws = workspace({ status })
    useStore.setState({ app: app([ws]), selectedWorkspaceId: ws.id })
  })
}

describe('LiveRegion', () => {
  it('처음 마운트될 때는 비어 있다 — 라이브 리전은 초기 내용을 읽지 않는다', () => {
    setStatus('error')
    const { container } = renderWithStore(<LiveRegion />)
    for (const node of container.querySelectorAll('[data-live-region]')) {
      expect(node).toHaveTextContent('')
    }
  })

  it('턴이 시작하고 끝나도 아무 말도 하지 않는다 — 알림음이 그 자리에 있다', () => {
    setStatus('idle')
    const { container } = renderWithStore(<LiveRegion />)

    setStatus('running')
    setStatus('idle')

    for (const node of container.querySelectorAll('[data-live-region]')) {
      expect(node).toHaveTextContent('')
    }
  })

  it('오류는 assertive 리전으로 간다', () => {
    setStatus('running')
    renderWithStore(<LiveRegion />)

    setStatus('error')
    expect(region('alert')).toHaveTextContent('sunny-bison stopped with an error.')
  })

  it('토스트 내용을 polite 로 읽는다', () => {
    renderWithStore(<LiveRegion />)
    act(() => {
      useStore.getState().pushToast('error', 'Could not archive the merged workspaces.')
    })
    expect(region('toast')).toHaveTextContent('Could not archive the merged workspaces.')
  })

  it('스토어 밖의 사건(ErrorBoundary)도 같은 호스트로 들어온다', () => {
    renderWithStore(<LiveRegion />)
    act(() => announce('Something broke in Settings. boom', 'assertive'))
    expect(region('alert')).toHaveTextContent('Something broke in Settings. boom')
  })

  it('리전은 둘이고, 화면에 보이지 않는다 — 시각적 변경이 없어야 한다', () => {
    const { container } = renderWithStore(<LiveRegion />)
    const regions = [...container.querySelectorAll('[data-live-region]')]
    expect(regions.map((r) => r.getAttribute('data-live-region'))).toEqual(['toast', 'alert'])
    for (const node of regions) expect(node).toHaveClass('sr-only')
  })

  it('ARIA role 을 달지 않는다 — 상시 떠 있는 빈 그릇을 경보로 세면 안 된다', () => {
    // e2e 가 role="alert" 로 토스트를 세고 그것이 사라지기를 기다린다. 여기에 role 을 달면
    // 그 기다림은 영영 끝나지 않는다(실제로 slash-commands 스펙이 이 이유로 죽었다).
    const { container } = renderWithStore(<LiveRegion />)
    expect(container.querySelectorAll('[role="alert"], [role="status"]')).toHaveLength(0)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
