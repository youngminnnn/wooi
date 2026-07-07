/**
 * 세션 응답 완료 알림음. 에셋 없이 Web Audio API 로 "ditto" 느낌의 2음 차임을 합성한다.
 *
 * "di-tto" 두 박을 같은 F#5 로 짧게 두 번 울린다 — 밝은 첫 음 뒤에 같은 음이
 * 메아리처럼 작게 이어져 "ditto = 반복" 을 표현한다.
 * 음색은 기본음 + 2·3배음을 더한 PeriodicWave 로 우드 말렛처럼 만든다.
 */
let ctx: AudioContext | null = null
let wave: PeriodicWave | null = null

// 마림바 음색: 기본음(1.0) + 2배음(0.18) + 3배음(0.08) 가산 합성.
function marimbaWave(ctx: AudioContext): PeriodicWave {
  const real = new Float32Array([0, 0, 0, 0])
  const imag = new Float32Array([0, 1.0, 0.18, 0.08])
  return ctx.createPeriodicWave(real, imag)
}

export function playNotification(): void {
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    wave ??= marimbaWave(ctx)
    const now = ctx.currentTime
    // di: 밝은 첫 음(F#5). tto: 같은 F#5 가 더 작게(echo) 이어진다.
    playTone(ctx, wave, 740, now, 0.18, 11, 0.2)
    playTone(ctx, wave, 740, now + 0.13, 0.34, 7, 0.14)
  } catch {
    // 오디오 불가 환경은 조용히 무시.
  }
}

// freq 의 한 음을 지수 감쇠(decay) 엔벨로프로 울린다. peak 는 최대 게인.
function playTone(
  ctx: AudioContext,
  wave: PeriodicWave,
  freq: number,
  start: number,
  dur: number,
  decay: number,
  peak: number
): void {
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
}
