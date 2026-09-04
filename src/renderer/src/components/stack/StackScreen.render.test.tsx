import { beforeEach, describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import StackScreen from './StackScreen'
import { app, git, pr, workspace } from '../../test/fixtures'
import { fakeApi, renderWithStore, resetStore, useStore } from '../../test/harness'

/** main → api → mid 3층 모델 A 스택. mid 의 base 는 일부러 어긋나게 둘 수 있다. */
function stack(overrides: { midBase?: string } = {}): ReturnType<typeof workspace>[] {
  return [
    workspace({ id: 'w-bottom', name: 'schema', branch: 'feat/schema', baseBranch: 'main' }),
    workspace({
      id: 'w-mid',
      name: 'api',
      branch: 'feat/api',
      baseBranch: overrides.midBase ?? 'feat/schema',
      parentWorkspaceId: 'w-bottom'
    }),
    workspace({
      id: 'w-top',
      name: 'ui',
      branch: 'feat/ui',
      baseBranch: 'feat/api',
      parentWorkspaceId: 'w-mid'
    })
  ]
}

beforeEach(() => {
  resetStore()
  fakeApi.reset()
  // 층별 조회는 화면이 직접 부른다. 기본 프록시는 배열이 아닌 값을 주므로 여기서 모양을 맞춘다.
  fakeApi.override('stack.commitsList', () => [
    {
      sha: 'abcdef1234',
      shortSha: 'abcdef1',
      subject: 'Add the schema',
      authorName: 'Kim',
      authoredAt: 1
    }
  ])
  fakeApi.override('git.diff', () => ({
    baseBranch: 'main',
    files: [{ path: 'a.ts', status: 'modified', additions: 10, deletions: 2, patch: '' }]
  }))
  fakeApi.override('stack.trainPlan', () => ({
    layers: [
      { branch: 'feat/schema', prNumber: 12, state: 'approved', blockedReason: null },
      { branch: 'feat/api', prNumber: 13, state: 'open', blockedReason: 'Checks are still running' }
    ],
    mergeableCount: 1,
    forcePushCount: 1,
    forcePushBranches: ['feat/ui']
  }))
})

describe('스택 화면', () => {
  it('스택의 모든 층을 바닥부터 세로로 늘어놓는다', async () => {
    useStore.setState({ app: app(stack()) })

    renderWithStore(<StackScreen workspaceId="w-mid" />)

    expect(screen.getByText('Layer 1 of 3')).toBeInTheDocument()
    expect(screen.getByText('Layer 3 of 3')).toBeInTheDocument()
    const layers = [...document.querySelectorAll('[data-stack-layer]')].map((node) =>
      node.getAttribute('data-stack-layer')
    )
    expect(layers).toEqual(['w-bottom', 'w-mid', 'w-top'])
  })

  it('층마다 PR 상태·behind·변경 요약을 같은 자리에 모은다', async () => {
    useStore.setState({
      app: app(stack()),
      prStatus: { 'w-bottom': pr('approved', { number: 12 }) },
      gitStatus: { 'w-mid': git({ behind: 3 }) }
    })

    renderWithStore(<StackScreen workspaceId="w-mid" />)

    expect(screen.getByTitle('PR #12 — Ready to merge. Open in your browser.')).toBeInTheDocument()
    expect(screen.getByTitle('This layer is 3 commits behind feat/schema')).toBeInTheDocument()
    // 커밋과 +/- 는 비동기로 읽어 온다.
    await waitFor(() => expect(screen.getAllByText('Add the schema').length).toBe(3))
    expect(screen.getAllByText('+10').length).toBeGreaterThan(0)
  })

  it('base 가 아래 층과 어긋나면 그 층에 표시하고 머리글에서도 센다', () => {
    useStore.setState({ app: app(stack({ midBase: 'main' })) })

    renderWithStore(<StackScreen workspaceId="w-mid" />)

    expect(
      screen.getByTitle(
        'This layer records main as its base, but the layer below it is feat/schema — its diff will swallow the layer below.'
      )
    ).toBeInTheDocument()
    expect(screen.getByTitle('Layers whose base is not the layer below them')).toHaveTextContent(
      '1 base drifted'
    )
  })

  it('머지 트레인 계획을 층별 상태로 옮겨 준다', async () => {
    useStore.setState({ app: app(stack()) })

    renderWithStore(<StackScreen workspaceId="w-mid" />)

    await waitFor(() =>
      expect(screen.getByTitle('The merge train would merge this layer')).toBeInTheDocument()
    )
    expect(screen.getByTitle('Checks are still running')).toHaveTextContent('Train blocked')
  })

  it('열려 있는 PR 이 둘 미만이면 스택 리뷰를 잠근다', () => {
    useStore.setState({ app: app(stack()), prStatus: { 'w-bottom': pr('open', { number: 12 }) } })

    renderWithStore(<StackScreen workspaceId="w-mid" />)

    expect(
      screen.getByTitle('Reviewing a stack needs at least two open pull requests')
    ).toBeDisabled()
  })

  it('스택이 아니면 층을 그리지 않고 이유를 말한다', () => {
    useStore.setState({ app: app([workspace({ id: 'w-solo', name: 'solo' })]) })

    renderWithStore(<StackScreen workspaceId="w-solo" />)

    expect(screen.getByText(/is not stacked on anything/)).toBeInTheDocument()
    expect(document.querySelector('[data-stack-layer]')).toBeNull()
  })
})
