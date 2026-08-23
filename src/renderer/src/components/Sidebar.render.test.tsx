import { beforeEach, describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import Sidebar, { StatusDot } from './Sidebar'
import { app, pr, workspace } from '../test/fixtures'
import { renderWithStore, resetStore, useStore } from '../test/harness'

const sidebarProps = {
  width: 280,
  onNewWorkspace: () => {},
  onNewFromIssue: () => {},
  onFanout: () => {},
  onStackWorkspace: () => {},
  onOpenQuickSwitch: () => {}
}

beforeEach(() => resetStore())

describe('사이드바 파생 상태 표시', () => {
  it('idle 워크스페이스에 백그라운드 셸만 남으면 정지된 Terminal 표시를 그린다', () => {
    const ws = workspace()
    useStore.setState({
      app: app([ws]),
      runningAgents: {
        [ws.id]: [
          {
            taskId: 'shell',
            taskType: 'local_bash',
            agentType: 'Bash',
            description: 'server',
            startedAt: 1
          }
        ]
      }
    })

    renderWithStore(<Sidebar {...sidebarProps} />)

    const indicator = screen.getByTitle(
      '1 background task still running here — the agent itself is idle'
    )
    expect(indicator.querySelector('[aria-label="Background tasks running"]')).toBeInTheDocument()
    expect(indicator.querySelector('.animate-spin')).not.toBeInTheDocument()
  })

  it('open·merged PR과 pending·failed CI를 서로 다른 점과 툴팁으로 표시한다', () => {
    const states = [pr('open'), pr('merged'), pr('ci_pending'), pr('ci_failed')]
    const { container } = renderWithStore(
      <>
        {states.map((value) => (
          <StatusDot
            key={value.state}
            status="idle"
            awaitingPermission={false}
            compacting={false}
            stale={false}
            runningMs={0}
            pr={value}
          />
        ))}
      </>
    )

    expect(screen.getByTitle('PR #42 — Open')).toHaveClass('bg-[var(--open-400)]')
    expect(screen.getByTitle('PR #42 — Merged')).toHaveClass('bg-[var(--merged-400)]')
    expect(screen.getByTitle('PR #42 — Checks pending')).toHaveClass('bg-[var(--warning-400)]')
    expect(screen.getByTitle('PR #42 — Checks failed')).toHaveClass('bg-[var(--danger-400)]')
    expect(
      new Set([...container.querySelectorAll('[title^="PR #42"]')].map((node) => node.className))
        .size
    ).toBe(4)
  })

  it('사용량 제한으로 멈춘 상태를 idle 점 대신 제한 배지로 표시한다', () => {
    renderWithStore(
      <StatusDot
        status="idle"
        awaitingPermission={false}
        compacting={false}
        stale={false}
        runningMs={0}
        rateLimited={{ backend: 'claude', detectedAt: Date.now(), resetsAt: Date.now() + 60_000 }}
      />
    )

    expect(screen.getByLabelText('Paused by usage limit')).toBeInTheDocument()
    expect(screen.queryByTitle('Idle — ready for input')).not.toBeInTheDocument()
  })
})
