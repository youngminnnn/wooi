import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('상태 방송 출구', () => {
  it('ipc.ts 는 상태를 dispatch 로만 내보낸다', () => {
    // 원격 미러는 main 엔트리의 dispatch 에만 붙어 있다. ipc.ts 가 창에 직접 보내면
    // 그 방송은 폰을 지나치고, 이름 바꾸기·음소거·권한 모드처럼 IPC 핸들러만 바꾸는
    // 것들이 폰에 영영 반영되지 않는다 — 실제로 그렇게 새 이름이 폰에 오지 않았다.
    const source = readFileSync(join(import.meta.dirname, 'ipc.ts'), 'utf-8')
    const lines = source.split('\n').filter((line) => line.includes('IPC.evtState'))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line).toContain('dispatch(IPC.evtState')
  })
})
