import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * 폰 쪽 **순수 로직**만 노드에서 돌린다. 화면과 네이티브 모듈은 대상이 아니다 —
 * 그건 실기기에서 확인한다.
 *
 * 여기 있는 것들이 이 프로젝트에서 실제로 사고를 낸 자리다: Postgres bytea 표현,
 * 랩탑과 폰이 **똑같이 만들어 내야 하는** 암호 계약. E2E 라 어긋나면 증상이
 * "복호화 실패" 하나뿐이라, 어긋난 지점을 테스트가 아니면 짚을 수 없다.
 */
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(import.meta.dirname, '../../src/shared') }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
