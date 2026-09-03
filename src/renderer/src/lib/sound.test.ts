import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * jsdom 에는 Web Audio 가 없다. 알림음 자체(주파수·엔벨로프)는 귀로 판정할 일이라 여기서
 * 검증하지 않고, **다 울린 뒤 출력 장치를 놓아주는가**만 본다 — 그게 유휴 배터리를 태우던
 * 부분이고, 잘못 고치면 연달아 울릴 때 뒤 음이 잘리는 쪽으로 조용히 망가진다.
 */

interface FakeOsc {
  onended: (() => void) | null
  stopAt: number
}

class FakeGain {
  gain = {
    setValueAtTime: () => {},
    linearRampToValueAtTime: () => {},
    exponentialRampToValueAtTime: () => {}
  }
  connect = (): unknown => ({})
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  state: 'running' | 'suspended' = 'running'
  currentTime = 0
  destination = {}
  oscillators: FakeOsc[] = []
  resumed = 0
  suspended = 0

  constructor() {
    FakeAudioContext.instances.push(this)
  }
  resume = async (): Promise<void> => {
    this.resumed++
    this.state = 'running'
  }
  suspend = async (): Promise<void> => {
    this.suspended++
    this.state = 'suspended'
  }
  createPeriodicWave = (): unknown => ({})
  createOscillator = (): unknown => {
    const osc: FakeOsc & Record<string, unknown> = {
      onended: null,
      stopAt: 0,
      setPeriodicWave: () => {},
      frequency: { value: 0 },
      connect: () => new FakeGain(),
      start: () => {},
      stop: (at: number) => {
        osc.stopAt = at
      }
    }
    this.oscillators.push(osc)
    return osc
  }
  createGain = (): unknown => new FakeGain()

  /** 예약된 마지막 음이 끝났다고 알린다(브라우저의 onended 를 대신한다). */
  finishLastTone(): void {
    this.oscillators[this.oscillators.length - 1]?.onended?.()
  }
}

async function loadSound(): Promise<{ playNotification: () => void }> {
  vi.resetModules()
  return import('./sound')
}

beforeEach(() => {
  FakeAudioContext.instances = []
  vi.stubGlobal('AudioContext', FakeAudioContext)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('알림음', () => {
  it('다 울리고 나면 컨텍스트를 재워 출력 장치를 놓아준다', async () => {
    const { playNotification } = await loadSound()
    playNotification()

    const ctx = FakeAudioContext.instances[0]
    expect(ctx.suspended).toBe(0) // 아직 울리는 중에는 붙잡고 있다.

    ctx.finishLastTone()
    expect(ctx.suspended).toBe(1)
    expect(ctx.state).toBe('suspended')
  })

  it('재운 뒤 다시 부르면 깨워서 울린다 — 컨텍스트를 새로 만들지 않는다', async () => {
    const { playNotification } = await loadSound()
    playNotification()
    const ctx = FakeAudioContext.instances[0]
    ctx.finishLastTone()

    playNotification()
    expect(FakeAudioContext.instances).toHaveLength(1)
    expect(ctx.resumed).toBe(1)
    expect(ctx.state).toBe('running')
  })

  it('앞 알림이 끝나기 전에 다음 알림이 오면 뒤 음을 자르지 않는다', async () => {
    const { playNotification } = await loadSound()
    playNotification()
    const ctx = FakeAudioContext.instances[0]
    const firstPlayLastTone = ctx.oscillators[ctx.oscillators.length - 1]

    playNotification() // 두 번째 재생이 겹쳐 시작된다.
    // 이제 첫 재생의 마지막 음이 뒤늦게 끝난다 — 여기서 재우면 두 번째 알림이 잘린다.
    firstPlayLastTone.onended?.()
    expect(ctx.suspended).toBe(0)
    expect(ctx.state).toBe('running')

    // 두 번째 재생이 끝나야 비로소 재운다.
    ctx.finishLastTone()
    expect(ctx.suspended).toBe(1)
  })
})
