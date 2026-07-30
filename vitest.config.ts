import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@': resolve('src/renderer/src')
    }
  },
  test: {
    // 순수 로직 유닛 테스트. Electron/DOM 의존 없는 모듈부터 커버한다.
    // scripts/ 는 CI·husky 가 공유하는 게이트 스크립트라 함께 커버한다.
    include: ['src/**/*.{test,spec}.ts', 'scripts/**/*.{test,spec}.ts'],
    environment: 'node'
  }
})
