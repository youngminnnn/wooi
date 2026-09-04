import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { app, workspace } from './test/fixtures'
import { fakeApi, startStoreSubscriptions, useStore } from './test/harness'

/**
 * 주기 폴링의 **배선**을 고정한다. 판정 규칙 자체는 [[lib/pollingGate]] 의 표가 덮으므로,
 * 여기서 보는 것은 그 규칙이 실제 타이머에 연결돼 있는가다 — 벽시계로는 검증할 수 없는 부분이다.
 * (샌드박스로 재 봤더니 창이 12분 내내 포커스를 유지하지 않아 "자리 비움" 구간을 만들 수 없었다.
 * 게다가 창을 강제로 앞에 가져오면 그 포커스 이벤트가 유휴 타이머를 리셋해 버린다.)
 *
 * 이 파일이 지키는 계약은 셋이다:
 * - 창이 앞에 있고 사람이 있으면 5분마다 `git fetch` 가 나간다.
 * - 창은 앞에 있는데 5분간 입력이 없으면 그 fetch 가 멈춘다 ← 배터리를 태우던 구간.
 * - 입력이 돌아오면 다음 틱을 기다리지 않고 곧바로 따라잡는다.
 */

const MINUTE = 60_000
/** store.ts 의 REMOTE_FETCH_INTERVAL_MS · PR_POLL_INTERVAL_MS 와 같은 값. */
const REMOTE_FETCH_INTERVAL_MS = 5 * MINUTE
const PR_POLL_INTERVAL_MS = 45_000

/** 이 창에 입력이 들어온 것으로 친다(store 가 window 에 건 리스너를 그대로 탄다). */
function noteUserInput(): void {
  window.dispatchEvent(new Event('pointermove'))
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

function fetchCount(): number {
  return fakeApi.called('git.fetch').length
}

beforeAll(async () => {
  // init() 이 타이머를 만들기 **전에** 가짜 시계를 깔아야 그 타이머가 잡힌다.
  vi.useFakeTimers()
  await startStoreSubscriptions()
})

afterAll(() => {
  vi.useRealTimers()
})

beforeEach(() => {
  // 폴링은 워크스페이스가 있어야 무언가를 한다(리포 목록을 워크스페이스에서 뽑는다).
  useStore.setState({ app: app([workspace()]) })
  setVisibility('visible')
  fakeApi.reset()
})

describe('유휴 폴링 게이트 배선', () => {
  it('사람이 있으면 5분마다 git fetch 가 나간다', async () => {
    noteUserInput()
    fakeApi.reset() // 입력 재개가 부른 따라잡기를 세지 않는다.

    await vi.advanceTimersByTimeAsync(4 * MINUTE)
    noteUserInput() // 아직 자리에 있다.
    fakeApi.reset()

    await vi.advanceTimersByTimeAsync(MINUTE) // 여기서 5분 틱이 걸린다.
    expect(fetchCount()).toBe(1)
  })

  it('창은 앞에 있는데 5분간 입력이 없으면 fetch 가 멈춘다', async () => {
    noteUserInput()
    fakeApi.reset()

    // 입력 없이 15분 — 틱은 세 번 걸리지만 전부 게이트에 걸려야 한다.
    await vi.advanceTimersByTimeAsync(3 * REMOTE_FETCH_INTERVAL_MS)
    expect(fetchCount()).toBe(0)
  })

  it('입력이 돌아오면 다음 틱을 기다리지 않고 곧바로 따라잡는다', async () => {
    await vi.advanceTimersByTimeAsync(2 * REMOTE_FETCH_INTERVAL_MS) // 자리를 비운다.
    fakeApi.reset()
    expect(fetchCount()).toBe(0)

    noteUserInput()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchCount()).toBe(1)
  })

  it('창이 가려지면 포커스가 남아 있어도 멈춘다', async () => {
    noteUserInput()
    setVisibility('hidden')
    fakeApi.reset()

    await vi.advanceTimersByTimeAsync(REMOTE_FETCH_INTERVAL_MS)
    expect(fetchCount()).toBe(0)
  })

  it('45초 PR 틱은 git fetch 를 부르지 않는다 — 네트워크 협상은 5분 틱의 몫이다', async () => {
    noteUserInput()
    fakeApi.reset()

    await vi.advanceTimersByTimeAsync(PR_POLL_INTERVAL_MS)
    expect(fakeApi.called('pr.status').length).toBeGreaterThan(0)
    expect(fetchCount()).toBe(0)
  })
})
