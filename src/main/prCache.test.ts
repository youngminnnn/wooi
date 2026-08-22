import { describe, expect, it, vi } from 'vitest'
import type { PrStatus, Workspace } from '@shared/types'

/**
 * 이 캐시가 존재하는 이유는 하나다 — 전체 훑기에서 워크스페이스마다 `gh` 로그인 셸이 한꺼번에
 * 뜨는 것을 막는 것. 그래서 지켜야 할 것도 하나다: 배치가 못 덮는 개별 조회가 상한을 넘겨
 * 동시에 돌지 않는다.
 */

const github = vi.hoisted(() => ({
  findOpenPrStatus: vi.fn(async () => null),
  isGithubConnected: vi.fn(() => true),
  getPrStatus: vi.fn(async (): Promise<PrStatus | null> => null)
}))

vi.mock('./github', () => github)

const { getWorkspacePrStatus, invalidateWorkspacePr } = await import('./prCache')

const workspace = (id: string): Workspace =>
  ({ id, worktreePath: `/tmp/${id}`, repoId: 'repo-1' }) as Workspace

it('기록된 PR 번호를 열린 목록과 개별 조회 모두에 우선 전달한다', async () => {
  invalidateWorkspacePr()
  github.findOpenPrStatus.mockResolvedValueOnce(null)
  github.getPrStatus.mockResolvedValueOnce(null)
  const ws = { ...workspace('numbered'), prNumber: 14196 }

  await getWorkspacePrStatus(ws, 'patch-1')

  expect(github.findOpenPrStatus).toHaveBeenLastCalledWith(
    '/tmp/numbered',
    'repo-1',
    'patch-1',
    14196
  )
  expect(github.getPrStatus).toHaveBeenLastCalledWith('/tmp/numbered', 14196)
})

const tick = async (times: number): Promise<void> => {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

/**
 * 자리 하나를 놓아 준 뒤 `gap` 틱 만에 새 호출이 들어오는 상황에서의 최대 동시 실행 수.
 *
 * 틈을 훑는 이유: 상한이 새는 창은 "놓는 쪽이 자리를 줄인 순간 ~ 대기자가 깨어나기 전" 으로
 * 마이크로태스크 한두 틱뿐이고, 그 위치는 호출 경로에 await 이 하나만 늘거나 줄어도 옮겨간다.
 * 특정 틱을 찍어 두면 호출부가 바뀌는 날 조용히 아무것도 검사하지 않는 테스트가 된다.
 */
async function peakConcurrency(gap: number, round: number): Promise<number> {
  invalidateWorkspacePr()
  let inFlight = 0
  let peak = 0
  const release: (() => void)[] = []
  github.getPrStatus.mockImplementation(() => {
    inFlight++
    peak = Math.max(peak, inFlight)
    return new Promise<PrStatus | null>((resolve) => {
      release.push(() => {
        inFlight--
        resolve(null)
      })
    })
  })

  // 워크스페이스 id 는 회차마다 새로 뽑는다 — 같은 id 는 폴백 캐시에 걸려 조회가 아예 안 난다.
  const ask = (name: string): Promise<PrStatus | null> =>
    getWorkspacePrStatus(workspace(`${round}-${name}`), 'feat/x')

  // a·b 가 자리를 채우고 c 가 줄을 선다.
  const running = [ask('a'), ask('b'), ask('c')]
  await tick(8)

  // a 를 놓아 주고, gap 틱 뒤에 새 호출을 넣는다.
  release.shift()?.()
  await tick(gap)
  running.push(ask('d'))

  for (let i = 0; i < 60; i++) {
    await tick(1)
    release.shift()?.()
  }
  await Promise.all(running)
  return peak
}

describe('개별 폴백 조회', () => {
  it('놓아 준 자리와 새 호출이 어느 틈에 겹치든 상한을 넘기지 않는다', async () => {
    const peaks: number[] = []
    for (let gap = 0; gap <= 8; gap++) peaks.push(await peakConcurrency(gap, gap))

    expect(Math.max(...peaks)).toBeLessThanOrEqual(2)
    // 상한까지는 실제로 쓴다 — 1 로 굳어 버리면 훑기가 그만큼 느려진다.
    expect(Math.max(...peaks)).toBe(2)
  })
})
