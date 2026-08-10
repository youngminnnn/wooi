import { describe, it, expect } from 'vitest'
import { CLAUDE_META, CODEX_META } from './backend'
import { INTERACTIVE_COMMANDS, normalizePermissionMode, nextPermissionMode } from '@shared/types'
import type { AgentBackendMeta } from '@shared/types'

/**
 * 백엔드 메타는 **UI 의 유일한 근거**다 — 여기가 틀리면 입력창이 지원하지 않는 명령을 띄우거나,
 * 권한 모드 순환이 엉뚱한 값으로 넘어간다. 두 백엔드에 같은 불변식을 걸어 둔다.
 */

const BACKENDS: AgentBackendMeta[] = [CLAUDE_META, CODEX_META]

describe.each(BACKENDS.map((m) => [m.label, m] as const))('%s 메타', (_label, meta) => {
  it('기본 권한 모드가 자기 목록 안에 있다', () => {
    expect(meta.permissionModes.some((m) => m.id === meta.defaultPermissionMode)).toBe(true)
  })

  it('권한 모드 id 가 중복되지 않는다(순환이 멈추지 않도록)', () => {
    const ids = meta.permissionModes.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('모든 모드에 라벨과 설명이 있다', () => {
    for (const mode of meta.permissionModes) {
      expect(mode.label.length).toBeGreaterThan(0)
      expect(mode.description.length).toBeGreaterThan(0)
    }
  })

  it('shift+tab 순환이 모든 모드를 한 바퀴 돈다', () => {
    const modes = meta.permissionModes
    let current = modes[0].id
    const seen = [current]
    for (let i = 1; i < modes.length; i++) {
      current = nextPermissionMode(modes, current)
      seen.push(current)
    }
    expect(new Set(seen).size).toBe(modes.length)
    // 한 바퀴 돌면 처음으로 돌아온다.
    expect(nextPermissionMode(modes, current)).toBe(modes[0].id)
  })

  it('다른 백엔드의 모드는 자기 기본 모드로 보정한다', () => {
    // 전역 기본값 이관·마이그레이션으로 남의 모드가 흘러들 수 있다.
    expect(normalizePermissionMode(meta, 'somethingElse' as never)).toBe(meta.defaultPermissionMode)
    expect(normalizePermissionMode(meta, null)).toBe(meta.defaultPermissionMode)
  })

  // 이 목록에 없는 종류를 넣으면 입력창이 명령을 가로챈 뒤 백엔드가 거절해 에러 토스트가 뜬다.
  it('선언한 인터랙티브 명령이 전부 실제로 존재하는 종류다', () => {
    const known = new Set(INTERACTIVE_COMMANDS.map((c) => c.kind))
    for (const kind of meta.capabilities.interactiveCommands) {
      expect(known.has(kind)).toBe(true)
    }
  })

  it('effort 선택지가 비어 있지 않다', () => {
    expect(meta.efforts.length).toBeGreaterThan(0)
  })
})

describe('백엔드 간 관계', () => {
  it('Codex 기본 Auto 모드를 입력창 하단에도 표시한다', () => {
    const mode = CODEX_META.permissionModes.find((item) => item.id === 'default')

    expect(mode).toMatchObject({
      label: 'Auto',
      footer: { symbol: '⏵⏵', text: 'auto mode on' }
    })
  })

  it('식별자가 서로 다르다', () => {
    expect(CLAUDE_META.id).not.toBe(CODEX_META.id)
  })

  // Codex 는 rewind·서브에이전트 개념이 없다. 켜 두면 오케스트레이터가 통과시켜 런타임에 터진다.
  it('Codex 는 지원하지 않는 기능을 켜 두지 않는다', () => {
    expect(CODEX_META.capabilities.rewind).toBe(false)
    expect(CODEX_META.capabilities.sideQuestion).toBe(false)
    expect(CODEX_META.capabilities.interactiveCommands).not.toContain('rewind')
    expect(CODEX_META.capabilities.interactiveCommands).not.toContain('agents')
  })

  // 두 백엔드 모두 같은 UI 를 쓰지만, Codex 는 Fast service tier 로 전달한다.
  it('fast mode 는 Claude 와 Codex 모두 지원한다', () => {
    expect(CLAUDE_META.capabilities.fastMode).toBe(true)
    expect(CODEX_META.capabilities.fastMode).toBe(true)
  })

  // 두 백엔드 모두 계정 사용량을 알려 준다 — 상태줄·Overview 가 백엔드와 무관하게 동작해야 한다.
  it('둘 다 플랜 사용량을 보고한다', () => {
    expect(CLAUDE_META.capabilities.rateLimits).toBe(true)
    expect(CODEX_META.capabilities.rateLimits).toBe(true)
  })

  it('Codex 만 턴 중 steering 을 지원한다', () => {
    expect(CODEX_META.capabilities.steering).toBe(true)
    expect(CLAUDE_META.capabilities.steering).toBe(false)
  })
})
