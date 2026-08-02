import { describe, it, expect } from 'vitest'
import { featureTipDecision } from './featureNudge'
import { CURRENT_FEATURE_TIP } from './uiFlags'

describe('featureTipDecision', () => {
  it('설정을 받기 전에는 아무것도 하지 않는다', () => {
    expect(featureTipDecision(undefined, 0)).toBe('skip')
  })

  /** 업데이트로 기능이 생긴 기존 사용자 — 이 사람에게만 "새 기능" 이 성립한다. */
  it('온보딩을 마친 사용자가 아직 못 봤으면 띄운다', () => {
    expect(featureTipDecision(true, 0)).toBe('show')
  })

  /**
   * 새로 설치한 사용자에게 "새 기능" 은 말이 안 된다 — 처음부터 있던 기능이고 투어가 이미
   * 소개한다. 다만 봤다고 표시는 해 둬야 온보딩을 마친 뒤 뒤늦게 튀어나오지 않는다.
   */
  it('신규 설치는 띄우지 않되 봤다고 표시한다', () => {
    expect(featureTipDecision(false, 0)).toBe('mark-seen')
  })

  it('이미 본 안내는 다시 띄우지 않는다', () => {
    expect(featureTipDecision(true, CURRENT_FEATURE_TIP)).toBe('skip')
    expect(featureTipDecision(false, CURRENT_FEATURE_TIP)).toBe('skip')
  })

  /** 여러 버전을 건너뛰고 업데이트해도, 못 본 안내가 있으면 정확히 그때 뜬다. */
  it('안내 번호가 뒤처져 있으면 버전을 얼마나 건너뛰었든 띄운다', () => {
    expect(featureTipDecision(true, CURRENT_FEATURE_TIP - 1)).toBe('show')
  })

  /** 미래 번호(다운그레이드 등)에도 다시 띄우지 않는다. */
  it('저장된 번호가 더 크면 조용히 넘어간다', () => {
    expect(featureTipDecision(true, CURRENT_FEATURE_TIP + 5)).toBe('skip')
  })
})
