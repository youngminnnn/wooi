import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REMOTE_PROTOCOL_VERSION, REMOTE_IPC, REMOTE_MAX_PROMPT_BYTES } from './remote'

describe('RN 공유 모듈의 무의존 제약', () => {
  /**
   * React Native(Metro)가 경로 별칭만으로 그대로 소비하는 기반 파일이다.
   * import 가 하나라도 생기면 — 특히 node: 접두 모듈이나 electron 이 — 모바일 번들이 깨진다.
   * 그 사실이 다른 곳에 적혀 있기만 하면 언젠가 깨지므로 여기서 강제한다.
   */
  const tierAFiles = ['types.ts', 'remote.ts', 'brandMarks.ts', 'toolDisplay.ts']
  const tierBFiles = ['toolSummary.ts', 'toolGroups.ts']
  const dependencyLine =
    /^\s*(?:import\s+(?!\()|export\s+.*\sfrom\s|.*\brequire\s*\(|.*\bimport\s*\()/

  for (const file of tierAFiles) {
    it(`${file} 은 어떤 것도 import 하지 않는다`, () => {
      const source = readFileSync(join(import.meta.dirname, file), 'utf-8')
      // 타입 전용 import 도 금지한다 — Metro 는 이 파일을 그대로 번들에 넣고,
      // babel 이 타입을 지우기 전에 resolver 가 경로를 먼저 본다.
      // 인라인 import('…') 타입은 이전 정규식을 빠져나갔으므로 별도로 함께 잡는다.
      const offenders = source.split('\n').filter((line) => dependencyLine.test(line))
      expect(offenders).toEqual([])
    })
  }

  for (const file of tierBFiles) {
    it(`${file} 은 tier A 형제만 상대 경로로 type import 한다`, () => {
      const source = readFileSync(join(import.meta.dirname, file), 'utf-8')
      const allowed = new RegExp(
        `^\\s*import type \\{[^}]+\\} from '\\.\\/(?:${tierAFiles.map((name) => name.slice(0, -3)).join('|')})'\\s*$`
      )
      const offenders = source
        .split('\n')
        .filter((line) => dependencyLine.test(line) && !allowed.test(line))
      expect(offenders).toEqual([])
    })
  }
})

describe('프로토콜 상수', () => {
  it('버전 상수가 있다', () => {
    expect(REMOTE_PROTOCOL_VERSION).toBeGreaterThanOrEqual(1)
  })

  it('브리지 자체 명령은 remote: 네임스페이스를 쓴다', () => {
    for (const channel of Object.values(REMOTE_IPC)) {
      expect(channel).toMatch(/^remote:/)
    }
  })

  it('프롬프트 상한이 명령 봉투 한도 안에 있다', () => {
    // commands.payload_ct 의 DB 제약이 64KiB 다(0001_init.sql). 그 절반이면 봉투·인코딩
    // 오버헤드를 얹어도 남는다 — 넘기면 폰이 보낸 프롬프트가 insert 단계에서 튕긴다.
    expect(REMOTE_MAX_PROMPT_BYTES).toBeLessThanOrEqual(32 * 1024)
  })
})
