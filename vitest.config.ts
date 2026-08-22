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
    // 워커 상한을 코어의 절반으로 묶는다. projects 로 나누면 vitest 가 프로젝트마다 워커를
    // 잡아 코어 수를 초과 구독하고, 그러면 처리량에 기대는 테스트(logger 의 회전 상한 검사는
    // 20,000 줄을 쓰고 5 초 예산 안에 끝나야 한다)가 부하에 밀려 타임아웃한다.
    // 게이트가 간헐적으로 빨개지면 아무도 믿지 않으므로, 속도보다 재현성을 택한다.
    maxWorkers: '50%',
    projects: [
      {
        resolve: {
          alias: {
            '@shared': resolve('src/shared'),
            '@': resolve('src/renderer/src')
          }
        },
        test: {
          name: 'node',
          include: [
            'src/{main,shared}/**/*.{test,spec}.{ts,tsx}',
            'scripts/**/*.{test,spec}.{ts,tsx}'
          ],
          environment: 'node'
        }
      },
      {
        resolve: {
          alias: {
            '@shared': resolve('src/shared'),
            '@': resolve('src/renderer/src')
          }
        },
        test: {
          name: 'renderer',
          include: ['src/renderer/**/*.{test,spec}.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['src/renderer/src/test/setup.ts']
        }
      }
    ]
  }
})
