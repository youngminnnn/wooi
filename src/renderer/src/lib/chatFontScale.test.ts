import { describe, expect, it } from 'vitest'
import {
  CHAT_FONT_SCALE_STEP,
  chatFontScaleActionForEvent,
  clampChatFontScale,
  decreaseChatFontScale,
  DEFAULT_CHAT_FONT_SCALE,
  increaseChatFontScale,
  MAX_CHAT_FONT_SCALE,
  MIN_CHAT_FONT_SCALE
} from './chatFontScale'

describe('clampChatFontScale', () => {
  it('읽을 수 있는 범위 밖은 잘라 낸다', () => {
    expect(clampChatFontScale(0.1)).toBe(MIN_CHAT_FONT_SCALE)
    expect(clampChatFontScale(9)).toBe(MAX_CHAT_FONT_SCALE)
  })

  it('숫자가 아니면 기본 배율로 돌아간다 — 남의 손이 탄 localStorage 도 여기로 온다', () => {
    expect(clampChatFontScale(Number.NaN)).toBe(DEFAULT_CHAT_FONT_SCALE)
    expect(clampChatFontScale(Number.POSITIVE_INFINITY)).toBe(DEFAULT_CHAT_FONT_SCALE)
  })

  it('부동소수 드리프트를 걷어 낸다', () => {
    expect(clampChatFontScale(0.7999999999999999)).toBe(0.8)
    expect(clampChatFontScale(1.2000000000000002)).toBe(1.2)
  })
})

describe('increase/decreaseChatFontScale', () => {
  it('한 스텝씩 움직인다', () => {
    expect(increaseChatFontScale(1)).toBe(1 + CHAT_FONT_SCALE_STEP)
    expect(decreaseChatFontScale(1)).toBeCloseTo(1 - CHAT_FONT_SCALE_STEP, 10)
  })

  it('경계 밖으로 나가지 않는다', () => {
    expect(increaseChatFontScale(MAX_CHAT_FONT_SCALE)).toBe(MAX_CHAT_FONT_SCALE)
    expect(decreaseChatFontScale(MIN_CHAT_FONT_SCALE)).toBe(MIN_CHAT_FONT_SCALE)
  })

  it('바닥까지 내렸다가 다시 올려도 깔끔한 십분위에 떨어진다', () => {
    let scale = DEFAULT_CHAT_FONT_SCALE
    for (let i = 0; i < 12; i++) scale = decreaseChatFontScale(scale)
    expect(scale).toBe(MIN_CHAT_FONT_SCALE)
    for (let i = 0; i < 12; i++) scale = increaseChatFontScale(scale)
    expect(scale).toBe(MAX_CHAT_FONT_SCALE)
    // 왕복해도 0.7999999 같은 잔재가 남지 않는다.
    for (let i = 0; i < 6; i++) scale = decreaseChatFontScale(scale)
    expect(scale).toBe(1)
  })
})

describe('chatFontScaleActionForEvent', () => {
  const key = (
    k: string,
    mods: { metaKey?: boolean; ctrlKey?: boolean } = {}
  ): Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey'> => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    ...mods
  })

  it('맥에서는 ⌘ 단독일 때만 받는다', () => {
    expect(chatFontScaleActionForEvent(key('=', { metaKey: true }), true)).toBe('increase')
    expect(chatFontScaleActionForEvent(key('-', { metaKey: true }), true)).toBe('decrease')
    expect(chatFontScaleActionForEvent(key('0', { metaKey: true }), true)).toBe('reset')
  })

  it('⌘⌃ 조합은 다른 단축키의 몫이라 넘기지 않는다', () => {
    expect(chatFontScaleActionForEvent(key('=', { metaKey: true, ctrlKey: true }), true)).toBeNull()
    expect(chatFontScaleActionForEvent(key('0', { metaKey: true, ctrlKey: true }), true)).toBeNull()
  })

  it('맥이 아니면 ⌃ 가 primary 다', () => {
    expect(chatFontScaleActionForEvent(key('=', { ctrlKey: true }), false)).toBe('increase')
    expect(chatFontScaleActionForEvent(key('=', { metaKey: true }), false)).toBeNull()
    expect(
      chatFontScaleActionForEvent(key('=', { ctrlKey: true, metaKey: true }), false)
    ).toBeNull()
  })

  it('배열에 따라 달라지는 짝도 같이 받는다 — + 는 ⇧= 다', () => {
    expect(chatFontScaleActionForEvent(key('+', { metaKey: true }), true)).toBe('increase')
    expect(chatFontScaleActionForEvent(key('_', { metaKey: true }), true)).toBe('decrease')
  })

  it('세 조합 말고는 건드리지 않는다', () => {
    for (const k of ['1', '9', 'k', 'l', 'ArrowUp', '=', '-', '0']) {
      const e = key(k, k === '=' || k === '-' || k === '0' ? {} : { metaKey: true })
      expect(chatFontScaleActionForEvent(e, true)).toBeNull()
    }
  })
})
