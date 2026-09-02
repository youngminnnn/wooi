import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import Sidebar from './Sidebar'
import { StatusDot } from './StatusDot'
import { app, pr, workspace } from '../test/fixtures'
import { renderWithStore, resetStore, useStore } from '../test/harness'
import { openNewWorkspaceMenu } from '../lib/newWorkspaceMenu'

const sidebarProps = {
  width: 280,
  onNewWorkspace: () => {},
  onNewFromIssue: () => {},
  onNewFromPr: () => {},
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
    // 접근 가능한 이름은 role="img" 를 가진 표시 자체에 붙는다(예전엔 안쪽 svg 에 있었다).
    expect(indicator).toHaveAttribute('aria-label', 'Background tasks running')
    expect(indicator.querySelector('.animate-spin')).not.toBeInTheDocument()
  })

  it('색으로만 구분되던 상태에 색 아닌 이름을 붙인다', () => {
    // 이 세 칸은 descriptor.aria 가 없어 예전에는 이름이 전혀 없었다 — 점 분기는 role 없는 빈
    // span 이라 보조 기술이 통째로 건너뛰었고, 사용자는 색 말고 상태를 알 방법이 없었다.
    const base = {
      awaitingPermission: false,
      compacting: false,
      stale: false,
      runningMs: 0
    } as const

    renderWithStore(
      <>
        <StatusDot {...base} status="idle" />
        <StatusDot {...base} status="running" />
        <StatusDot {...base} status="idle" pr={pr('approved')} />
      </>
    )

    expect(screen.getByLabelText('Idle')).toBeInTheDocument()
    expect(screen.getByLabelText('Running')).toBeInTheDocument()
    // PR 은 짧은 라벨('Ready to merge')만으로는 무엇의 상태인지 알 수 없어 aria 를 따로 둔다.
    expect(screen.getByLabelText('Pull request — Ready to merge')).toBeInTheDocument()
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

  it('스택 화면 진입점은 층이 더 쌓인 부모 행에만 붙는다', () => {
    const parent = workspace({ id: 'w-parent', name: 'schema', branch: 'feat/schema' })
    const child = workspace({
      id: 'w-child',
      name: 'api',
      branch: 'feat/api',
      baseBranch: 'feat/schema',
      parentWorkspaceId: 'w-parent'
    })
    useStore.setState({ app: app([parent, child]) })

    renderWithStore(<Sidebar {...sidebarProps} />)

    // 부모에는 하나, 꼭대기 층에는 없다 — 펼칠 아래 층이 없으면 지도도 없다.
    expect(screen.getAllByLabelText('Show this stack')).toHaveLength(1)
  })

  it('스택이 아닌 워크스페이스에는 스택 화면 진입점을 달지 않는다', () => {
    useStore.setState({ app: app([workspace()]) })

    renderWithStore(<Sidebar {...sidebarProps} />)

    expect(screen.queryByLabelText('Show this stack')).not.toBeInTheDocument()
  })

  it('단축키 메뉴를 열 때 대상 리포를 화면에 드러내고 이름을 표시한다', async () => {
    useStore.setState({ app: app([workspace()]) })
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView')

    renderWithStore(<Sidebar {...sidebarProps} />)
    openNewWorkspaceMenu('repo-1')

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    await waitFor(() => expect(screen.getByText('New workspace in Wooi')).toBeInTheDocument())
    expect(screen.getByText('Wooi').closest('.group')).toHaveClass('ring-[var(--info-500)]/60')
  })
})
