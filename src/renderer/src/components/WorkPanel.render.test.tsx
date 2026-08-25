import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import WorkPanel from './WorkPanel'
import { workspace } from '../test/fixtures'
import { renderWithStore, resetStore } from '../test/harness'

beforeEach(() => resetStore())

/**
 * 좁은 폭에서 탭 라벨은 컨테이너 쿼리로 감춰지고 아이콘만 남는다([[index.css]] .workpanel-tabs).
 * jsdom 은 컨테이너 쿼리를 계산하지 않으므로 "감춰지는 것" 자체는 여기서 볼 수 없다 — 대신
 * **감춰져도 이름이 남는다**는 계약을 고정한다. 그 계약이 깨지면 좁은 패널에서 탭은 뜻 없는
 * 아이콘만 남는다.
 */
describe('work panel 탭', () => {
  it('탭마다 접근 가능한 이름이 있어 라벨이 감춰져도 식별된다', () => {
    renderWithStore(<WorkPanel workspace={workspace()} />)
    for (const label of ['All files', 'Changes', 'Check', 'Preview']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
    expect(screen.queryByRole('button', { name: 'Commits' })).not.toBeInTheDocument()
  })

  // 탭이 눌려 글자가 밀리던 회귀의 정체는 flex 기본값 shrink:1 이었다. 폭 계산은 jsdom 밖의
  // 일이라, 대신 "줄어들지 않는다"는 의도가 클래스에 남아 있는지를 지킨다.
  it('탭은 줄어들지 않고, 넘치면 탭 줄이 스크롤한다', () => {
    const { container } = renderWithStore(<WorkPanel workspace={workspace()} />)
    expect(screen.getByRole('button', { name: 'Changes' }).className).toContain('shrink-0')
    const strip = container.querySelector('.workpanel-tabs > div')
    expect(strip?.className).toContain('overflow-x-auto')
    expect(strip?.className).toContain('min-w-0')
  })

  it('Changes 안에서 파일 변경과 커밋을 전환한다', () => {
    renderWithStore(<WorkPanel workspace={workspace()} />)
    const changes = screen.getByRole('tab', { name: 'Changes' })
    const commits = screen.getByRole('tab', { name: 'Commits' })

    expect(changes).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(commits)
    expect(commits).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Commits in this layer')).toBeInTheDocument()
  })
})
