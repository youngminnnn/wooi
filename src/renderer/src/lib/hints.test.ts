import { describe, expect, it } from 'vitest'
import { HINTS, MAX_HINTS_PER_SESSION, selectHint, type HintContext, type HintId } from './hints'

/** 어떤 힌트에도 걸리지 않는 "조용한" 기본 컨텍스트. 테스트마다 필요한 필드만 덮어쓴다. */
function baseCtx(overrides: Partial<HintContext> = {}): HintContext {
  return {
    totalWorkspaceCount: 1,
    visibleWorkspaceCount: 1,
    mouseSwitchCount: 0,
    anyOpenPr: false,
    selected: null,
    ...overrides
  }
}

const noneSeen = new Set<HintId>()
const noneShown = new Set<HintId>()

describe('selectHint — 트리거 표', () => {
  it('permission-mode: 선택된 워크스페이스에 승인 프롬프트가 떠 있으면 뜬다', () => {
    const ctx = baseCtx({
      selected: {
        ahead: 0,
        changedFiles: 0,
        hasPr: false,
        panelOpen: true,
        awaitingPermission: true
      }
    })
    expect(selectHint(ctx, { seen: noneSeen, shownThisSession: noneShown })?.id).toBe(
      'permission-mode'
    )
  })

  it('permission-mode: 워크스페이스를 선택하지 않았으면 안 뜬다', () => {
    const ctx = baseCtx({ selected: null })
    const hint = selectHint(ctx, { seen: noneSeen, shownThisSession: noneShown })
    expect(hint?.id).not.toBe('permission-mode')
  })

  it('work-panel: 변경 파일이 있고 패널이 닫혀 있으면 뜬다', () => {
    const ctx = baseCtx({
      selected: {
        ahead: 0,
        changedFiles: 3,
        hasPr: false,
        panelOpen: false,
        awaitingPermission: false
      }
    })
    expect(selectHint(ctx, { seen: noneSeen, shownThisSession: noneShown })?.id).toBe('work-panel')
  })

  it('work-panel: 패널이 이미 열려 있으면 안 뜬다', () => {
    const ctx = baseCtx({
      selected: {
        ahead: 0,
        changedFiles: 3,
        hasPr: false,
        panelOpen: true,
        awaitingPermission: false
      }
    })
    const hint = selectHint(ctx, { seen: noneSeen, shownThisSession: noneShown })
    expect(hint?.id).not.toBe('work-panel')
  })

  it('open-pr: base 보다 앞섰고 PR 이 없으면 뜬다', () => {
    const ctx = baseCtx({
      selected: {
        ahead: 2,
        changedFiles: 0,
        hasPr: false,
        panelOpen: true,
        awaitingPermission: false
      }
    })
    expect(selectHint(ctx, { seen: noneSeen, shownThisSession: noneShown })?.id).toBe('open-pr')
  })

  it('open-pr: 이미 PR 이 있으면 안 뜬다', () => {
    const ctx = baseCtx({
      selected: {
        ahead: 2,
        changedFiles: 0,
        hasPr: true,
        panelOpen: true,
        awaitingPermission: false
      }
    })
    const hint = selectHint(ctx, { seen: noneSeen, shownThisSession: noneShown })
    expect(hint?.id).not.toBe('open-pr')
  })

  it('quick-switch: 목록이 9개를 넘으면 뜬다', () => {
    const ctx = baseCtx({ visibleWorkspaceCount: 10 })
    expect(selectHint(ctx, { seen: noneSeen, shownThisSession: noneShown })?.id).toBe(
      'quick-switch'
    )
  })

  it('keyboard-switch: 마우스 전환이 임계치를 넘고 목록이 9개 이하면 뜬다', () => {
    const ctx = baseCtx({ visibleWorkspaceCount: 5, mouseSwitchCount: 3 })
    expect(selectHint(ctx, { seen: noneSeen, shownThisSession: noneShown })?.id).toBe(
      'keyboard-switch'
    )
  })

  it('quick-switch 와 keyboard-switch 가 동시에 참이면 quick-switch 가 이긴다', () => {
    const ctx = baseCtx({ visibleWorkspaceCount: 10, mouseSwitchCount: 5 })
    expect(selectHint(ctx, { seen: noneSeen, shownThisSession: noneShown })?.id).toBe(
      'quick-switch'
    )
  })

  it('review-pr: 어딘가에 열린 PR 이 있으면 뜬다', () => {
    const ctx = baseCtx({ anyOpenPr: true })
    expect(selectHint(ctx, { seen: noneSeen, shownThisSession: noneShown })?.id).toBe('review-pr')
  })

  it('shortcuts: 워크스페이스를 3개 이상 만든 적 있으면 뜬다', () => {
    const ctx = baseCtx({ totalWorkspaceCount: 3 })
    expect(selectHint(ctx, { seen: noneSeen, shownThisSession: noneShown })?.id).toBe('shortcuts')
  })
})

describe('selectHint — 동시에 여러 개가 참이면 하나만', () => {
  it('permission-mode 와 shortcuts 조건이 동시에 참이어도 우선순위가 낮은 쪽 하나만 돌려준다', () => {
    const ctx = baseCtx({
      totalWorkspaceCount: 3,
      selected: {
        ahead: 0,
        changedFiles: 0,
        hasPr: false,
        panelOpen: true,
        awaitingPermission: true
      }
    })
    const hint = selectHint(ctx, { seen: noneSeen, shownThisSession: noneShown })
    expect(hint?.id).toBe('permission-mode')
  })

  it('모든 조건이 동시에 참이어도 정확히 하나만 뽑힌다', () => {
    const ctx: HintContext = {
      totalWorkspaceCount: 5,
      visibleWorkspaceCount: 20,
      mouseSwitchCount: 10,
      anyOpenPr: true,
      selected: {
        ahead: 5,
        changedFiles: 5,
        hasPr: false,
        panelOpen: false,
        awaitingPermission: true
      }
    }
    const results = HINTS.filter((h) => h.when(ctx))
    // 표에 정의된 힌트 전부가 동시에 참이 될 수 있음을 픽스처가 실제로 커버하는지 확인한다.
    expect(results.length).toBe(HINTS.length)

    const hint = selectHint(ctx, { seen: noneSeen, shownThisSession: noneShown })
    expect(hint).not.toBeNull()
    expect(hint!.id).toBe('permission-mode')
  })

  it('seen 에 들어 있으면 조건이 참이어도 후보에서 빠진다', () => {
    const ctx = baseCtx({
      selected: {
        ahead: 0,
        changedFiles: 0,
        hasPr: false,
        panelOpen: true,
        awaitingPermission: true
      }
    })
    const seen = new Set<HintId>(['permission-mode'])
    const hint = selectHint(ctx, { seen, shownThisSession: noneShown })
    expect(hint?.id).not.toBe('permission-mode')
  })
})

describe('selectHint — 세션당 상한', () => {
  it(`이번 세션에 아직 하나도 안 떴으면 ${MAX_HINTS_PER_SESSION}개까지는 새로 뜬다`, () => {
    const ctx = baseCtx({ anyOpenPr: true })
    const hint = selectHint(ctx, { seen: noneSeen, shownThisSession: noneShown })
    expect(hint).not.toBeNull()
  })

  it(`이번 세션에 이미 ${MAX_HINTS_PER_SESSION}개를 소개했으면 새 힌트는 더 뜨지 않는다`, () => {
    const ctx = baseCtx({ anyOpenPr: true })
    const shownThisSession = new Set<HintId>(['quick-switch', 'work-panel'])
    expect(shownThisSession.size).toBe(MAX_HINTS_PER_SESSION)
    const hint = selectHint(ctx, { seen: noneSeen, shownThisSession })
    expect(hint).toBeNull()
  })

  it('상한에 걸려도 이미 이번 세션에 뜬 힌트는 계속 후보로 남는다(꺼졌다 켜지지 않는다)', () => {
    const ctx = baseCtx({ anyOpenPr: true })
    const shownThisSession = new Set<HintId>(['review-pr', 'work-panel'])
    const hint = selectHint(ctx, { seen: noneSeen, shownThisSession })
    expect(hint?.id).toBe('review-pr')
  })
})
