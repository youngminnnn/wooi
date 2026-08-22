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

afterEach(() => {
  cleanup()
  fakeApi.reset()
  localStorage.clear()
})
