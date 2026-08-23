import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import { fakeApi } from './fakeApi'

Object.defineProperty(window, 'api', { configurable: true, value: fakeApi.api })

if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })
  })
}

// jsdom 은 스크롤을 구현하지 않아 scrollIntoView 자체가 없다. 대화를 하나라도 그리는 테스트는
// MessageList 의 "새 내용을 따라 내려간다" 효과에서 그대로 터진다 — matchMedia 와 같은 종류의
// 환경 구멍이라 같은 자리에서 메운다.
if (!Element.prototype.scrollIntoView) {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => {}
  })
}

afterEach(() => {
  cleanup()
  fakeApi.reset()
  localStorage.clear()
})
