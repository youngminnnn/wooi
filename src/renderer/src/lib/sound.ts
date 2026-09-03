/**
 * 세션 응답 완료 알림음. 에셋 없이 Web Audio API 로 "wooi" 느낌의 2음 차임을 합성한다.
 *
 * "di-tto" 두 박을 같은 F#5 로 짧게 두 번 울린다 — 밝은 첫 음 뒤에 같은 음이
 * 메아리처럼 작게 이어져 "wooi = 반복" 을 표현한다.
 * 음색은 기본음 + 2·3배음을 더한 PeriodicWave 로 우드 말렛처럼 만든다.
 */
let ctx: AudioContext | null = null
let wave: PeriodicWave | null = null

/**
 * 이번에 예약한 재생의 일련번호. 마지막 음의 `onended` 가 이 값과 다르면 그 사이 새 알림이
 * 들어온 것이므로 재우지 않는다 — 안 그러면 연달아 두 번 울릴 때 뒤 음이 잘린다.
 */
let playToken = 0

// 마림바 음색: 기본음(1.0) + 2배음(0.18) + 3배음(0.08) 가산 합성.
function marimbaWave(ctx: AudioContext): PeriodicWave {
  const real = new Float32Array([0, 0, 0, 0])
  const imag = new Float32Array([0, 1.0, 0.18, 0.08])
  return ctx.createPeriodicWave(real, imag)
}

export function playNotification(): void {
  try {
    const audio = (ctx ??= new AudioContext())
    if (audio.state === 'suspended') void audio.resume()
    wave ??= marimbaWave(audio)
    const now = audio.currentTime
    const token = ++playToken
    // di: 밝은 첫 음(F#5). tto: 같은 F#5 가 더 작게(echo) 이어진다.
    playTone(audio, wave, 740, now, 0.18, 11, 0.2)
    const last = playTone(audio, wave, 740, now + 0.13, 0.34, 7, 0.14)
    // 다 울렸으면 곧바로 재운다. AudioContext 는 한 번 running 이 되면 소리를 내지 않는
    // 동안에도 출력 장치를 붙잡은 채 무음을 계속 렌더링한다 — 즉 알림음을 한 번 울린 뒤로는
    // 앱이 완전히 유휴여도 렌더러에 오디오 스레드가 영구히 남는다. suspend 는 그래프를 그대로
    // 둔 채 장치만 놓아주므로, 다음 알림은 위 resume 한 줄로 즉시 다시 울린다.
    // (close 를 쓰지 않는 이유 — 컨텍스트를 새로 만들면 자동재생 정책을 다시 통과해야 한다.)
    last.onended = () => {
      if (token === playToken) void audio.suspend()
    }
  } catch {
    // 오디오 불가 환경은 조용히 무시.
  }
}

/**
 * freq 의 한 음을 지수 감쇠(decay) 엔벨로프로 울린다. peak 는 최대 게인.
 * 울린 oscillator 를 돌려준다 — 호출한 쪽이 `onended` 로 재생 끝을 잡을 수 있게.
 */
function playTone(
  ctx: AudioContext,
  wave: PeriodicWave,
  freq: number,
  start: number,
  dur: number,
  decay: number,
  peak: number
): OscillatorNode {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.setPeriodicWave(wave)
  osc.frequency.value = freq

  const attack = 0.004
  const release = 0.004
  // 음 끝의 감쇠 도달값. exponentialRamp 는 0 에 닿지 못하므로 하한을 둔다.
  const endLevel = Math.max(peak * Math.exp(-decay * dur), 0.0001)
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.linearRampToValueAtTime(peak, start + attack)
  gain.gain.exponentialRampToValueAtTime(endLevel, start + dur)
  gain.gain.linearRampToValueAtTime(0.0001, start + dur + release)

  osc.connect(gain).connect(ctx.destination)
  osc.start(start)
  osc.stop(start + dur + release + 0.01)
  return osc
}
