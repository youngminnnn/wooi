import { describe, expect, it } from 'vitest'
import {
  HINTS,
  MAX_HINTS_PER_SESSION,
  selectHint,
  type HintContext,
  type HintId,
  type HintSelectedWorkspaceContext
} from './hints'

/** 어떤 힌트에도 걸리지 않는 "조용한" 기본 컨텍스트. 테스트마다 필요한 필드만 덮어쓴다. */
function baseCtx(overrides: Partial<HintContext> = {}): HintContext {
  return {
    totalWorkspaceCount: 1,
    visibleWorkspaceCount: 1,
    mouseSwitchCount: 0,
    anyOpenPr: false,
    otherRunningCount: 0,
    fanoutGroupCount: 0,
    selected: null,
    ...overrides
  }
}

/**
 * 선택된 워크스페이스의 "조용한" 기본값. 리포에 혼자 있고, 아무 위에도 쌓여 있지 않고, 아무것도
 * 쌓여 있지 않다 — 그래서 stack-work 는 기본적으로 꺼져 있고, 켜려면 형제를 명시해야 한다.
 */
function sel(overrides: Partial<HintSelectedWorkspaceContext> = {}): HintSelectedWorkspaceContext {
  return {
    ahead: 0,
    changedFiles: 0,
    hasPr: false,
    panelOpen: true,
    awaitingPermission: false,
    repoSiblingCount: 0,
    isStackRoot: true,
    hasStackedChildren: false,
    ...overrides
  }
}

const noneSeen = new Set<HintId>()
const noneShown = new Set<HintId>()

/** 이 컨텍스트에서 뽑히는 힌트 id(없으면 null). 테스트마다 반복되는 호출을 줄인다. */
function pick(ctx: HintContext, seen: ReadonlySet<HintId> = noneSeen): HintId | null {
  return selectHint(ctx, { seen, shownThisSession: noneShown })?.id ?? null
}

describe('selectHint — 트리거 표', () => {
  it('permission-mode: 선택된 워크스페이스에 승인 프롬프트가 떠 있으면 뜬다', () => {
    expect(pick(baseCtx({ selected: sel({ awaitingPermission: true }) }))).toBe('permission-mode')
  })

  it('permission-mode: 워크스페이스를 선택하지 않았으면 안 뜬다', () => {
    expect(pick(baseCtx({ selected: null }))).not.toBe('permission-mode')
  })

  it('work-panel: 변경 파일이 있고 패널이 닫혀 있으면 뜬다', () => {
    expect(pick(baseCtx({ selected: sel({ changedFiles: 3, panelOpen: false }) }))).toBe(
      'work-panel'
    )
  })

  it('work-panel: 패널이 이미 열려 있으면 안 뜬다', () => {
    expect(pick(baseCtx({ selected: sel({ changedFiles: 3, panelOpen: true }) }))).not.toBe(
      'work-panel'
    )
  })

  it('open-pr: base 보다 앞섰고 PR 이 없으면 뜬다', () => {
    expect(pick(baseCtx({ selected: sel({ ahead: 2 }) }))).toBe('open-pr')
  })

  it('open-pr: 이미 PR 이 있으면 안 뜬다', () => {
    expect(pick(baseCtx({ selected: sel({ ahead: 2, hasPr: true }) }))).not.toBe('open-pr')
  })

  it('quick-switch: 목록이 9개를 넘으면 뜬다', () => {
    expect(pick(baseCtx({ visibleWorkspaceCount: 10 }))).toBe('quick-switch')
  })

  it('keyboard-switch: 마우스 전환이 임계치를 넘고 목록이 9개 이하면 뜬다', () => {
    expect(pick(baseCtx({ visibleWorkspaceCount: 5, mouseSwitchCount: 3 }))).toBe('keyboard-switch')
  })

  it('quick-switch 와 keyboard-switch 가 동시에 참이면 quick-switch 가 이긴다', () => {
    expect(pick(baseCtx({ visibleWorkspaceCount: 10, mouseSwitchCount: 5 }))).toBe('quick-switch')
  })

  it('review-pr: 어딘가에 열린 PR 이 있으면 뜬다', () => {
    expect(pick(baseCtx({ anyOpenPr: true }))).toBe('review-pr')
  })

  it('shortcuts: 워크스페이스를 3개 이상 만든 적 있으면 뜬다', () => {
    // fan-out 도 3개부터 참이 되므로(그리고 더 앞선다) 여기서는 이미 fan-out 을 써 본 사용자로 둔다.
    expect(pick(baseCtx({ totalWorkspaceCount: 3, fanoutGroupCount: 1 }))).toBe('shortcuts')
  })
})

// ── Wooi 고유 개념 세 가지 ──────────────────────────────────────────────
//
// 이 셋만 다른 앱에 없는 개념(수직 의존·워크스페이스 간 메시지·같은 프롬프트 병렬)을 가르친다.
// 트리거가 실제 상황에 붙어 있는지, 그리고 **이미 그 개념을 쓰고 있는 사람에게는 침묵하는지**가
// 요점이다 — 후자가 없으면 그냥 상시 광고가 된다.

describe('selectHint — stack-work(스택)', () => {
  it('같은 리포에 다른 워크스페이스가 있고 이쪽에 아직 안 내려간 일이 있으면 뜬다', () => {
    expect(pick(baseCtx({ selected: sel({ ahead: 2, repoSiblingCount: 1 }) }))).toBe('stack-work')
  })

  it('커밋 전이어도(변경 파일만 있어도) 뜬다', () => {
    const ctx = baseCtx({
      selected: sel({ changedFiles: 4, panelOpen: true, repoSiblingCount: 1 })
    })
    expect(pick(ctx)).toBe('stack-work')
  })

  it('리포에 이 워크스페이스뿐이면 안 뜬다 — 쌓을 상대가 없다', () => {
    expect(pick(baseCtx({ selected: sel({ ahead: 2, repoSiblingCount: 0 }) }))).toBe('open-pr')
  })

  it('아직 아무 일도 안 한 워크스페이스에는 안 뜬다', () => {
    expect(pick(baseCtx({ selected: sel({ repoSiblingCount: 3 }) }))).toBeNull()
  })

  it('이미 다른 워크스페이스 위에 쌓여 있으면 안 뜬다 — 개념을 이미 쓰고 있다', () => {
    const ctx = baseCtx({
      selected: sel({ ahead: 2, repoSiblingCount: 1, isStackRoot: false })
    })
    expect(pick(ctx)).not.toBe('stack-work')
  })

  it('이 위에 이미 뭔가 쌓여 있으면 안 뜬다 — 역시 이미 쓰고 있다', () => {
    const ctx = baseCtx({
      selected: sel({ ahead: 2, repoSiblingCount: 1, hasStackedChildren: true })
    })
    expect(pick(ctx)).not.toBe('stack-work')
  })
})

describe('selectHint — peer-message(워크스페이스 간 메시지)', () => {
  it('다른 워크스페이스가 지금 돌고 있으면 뜬다', () => {
    expect(pick(baseCtx({ selected: sel(), otherRunningCount: 1 }))).toBe('peer-message')
  })

  it('돌고 있는 게 없으면 안 뜬다', () => {
    expect(pick(baseCtx({ selected: sel(), otherRunningCount: 0 }))).toBeNull()
  })

  it('워크스페이스를 안 열고 있으면(Overview) 안 뜬다 — /wooi:send 를 칠 입력창이 없다', () => {
    expect(pick(baseCtx({ selected: null, otherRunningCount: 2 }))).toBeNull()
  })
})

describe('selectHint — fan-out', () => {
  it('워크스페이스를 3개 이상 만들었는데 fan-out 을 한 번도 안 써 봤으면 뜬다', () => {
    expect(pick(baseCtx({ totalWorkspaceCount: 3 }))).toBe('fan-out')
  })

  it('이미 써 본 사람에게는 안 뜬다', () => {
    expect(pick(baseCtx({ totalWorkspaceCount: 8, fanoutGroupCount: 2 }))).toBe('shortcuts')
  })

  it('아직 워크스페이스가 몇 개 없으면 안 뜬다', () => {
    expect(pick(baseCtx({ totalWorkspaceCount: 2 }))).toBeNull()
  })
})

// ── 우선순위 사다리 ─────────────────────────────────────────────────────
//
// 세션당 상한이 2 라 우선순위는 곧 경쟁 규칙이다. 힌트를 더할 때 기존 힌트를 조용히 밀어내는
// 일이 없도록, 사다리 전체와 "새 힌트가 앞지르는 유일한 지점"을 여기에 못박아 둔다.

describe('selectHint — 우선순위 사다리', () => {
  it('사다리 순서는 설계한 그대로다', () => {
    const ladder = [...HINTS].sort((a, b) => a.priority - b.priority).map((h) => h.id)
    expect(ladder).toEqual([
      'permission-mode',
      'work-panel',
      'stack-work',
      'open-pr',
      'quick-switch',
      'keyboard-switch',
      'peer-message',
      'review-pr',
      'fan-out',
      'shortcuts'
    ])
  })

  it('우선순위 값이 서로 겹치지 않는다 — 같으면 배열 순서라는 숨은 규칙이 생긴다', () => {
    expect(new Set(HINTS.map((h) => h.priority)).size).toBe(HINTS.length)
  })

  it('새 힌트 셋 중 기존 힌트를 앞지르는 것은 stack-work 하나뿐이다', () => {
    const at = (id: HintId): number => HINTS.find((h) => h.id === id)!.priority
    // stack-work 만 예외적으로 open-pr 앞에 선다 — 스택은 화면 어디에도 단서가 없고,
    // open-pr 은 "Create PR" 칩이 눈에 보이기 때문이다.
    expect(at('stack-work')).toBeLessThan(at('open-pr'))
    expect(at('stack-work')).toBeGreaterThan(at('work-panel'))
    // 나머지 둘은 기존 힌트 사이에 끼워 넣기만 한다.
    expect(at('peer-message')).toBeGreaterThan(at('keyboard-switch'))
    expect(at('peer-message')).toBeLessThan(at('review-pr'))
    expect(at('fan-out')).toBeGreaterThan(at('review-pr'))
    expect(at('fan-out')).toBeLessThan(at('shortcuts'))
  })

  it('막고 있는 승인 프롬프트·안 보이는 변경 파일은 여전히 stack-work 를 이긴다', () => {
    const stacky = sel({ ahead: 2, repoSiblingCount: 1 })
    expect(pick(baseCtx({ selected: { ...stacky, awaitingPermission: true } }))).toBe(
      'permission-mode'
    )
    expect(pick(baseCtx({ selected: { ...stacky, changedFiles: 3, panelOpen: false } }))).toBe(
      'work-panel'
    )
  })

  it('stack-work 를 닫고 나면 open-pr 이 그 세션의 두 번째 자리를 얻는다', () => {
    const ctx = baseCtx({ selected: sel({ ahead: 2, repoSiblingCount: 1 }) })
    expect(pick(ctx)).toBe('stack-work')
    // 사용자가 X 로 닫았고(seen), 그게 이번 세션의 첫 소개였다.
    const after = selectHint(ctx, {
      seen: new Set<HintId>(['stack-work']),
      shownThisSession: new Set<HintId>(['stack-work'])
    })
    expect(after?.id).toBe('open-pr')
  })
})

describe('selectHint — 동시에 여러 개가 참이면 하나만', () => {
  it('permission-mode 와 shortcuts 조건이 동시에 참이어도 우선순위가 낮은 쪽 하나만 돌려준다', () => {
    const ctx = baseCtx({
      totalWorkspaceCount: 3,
      selected: sel({ awaitingPermission: true })
    })
    expect(pick(ctx)).toBe('permission-mode')
  })

  it('모든 조건이 동시에 참이어도 정확히 하나만 뽑힌다', () => {
    const ctx: HintContext = {
      totalWorkspaceCount: 5,
      visibleWorkspaceCount: 20,
      mouseSwitchCount: 10,
      anyOpenPr: true,
      otherRunningCount: 2,
      fanoutGroupCount: 0,
      selected: {
        ahead: 5,
        changedFiles: 5,
        hasPr: false,
        panelOpen: false,
        awaitingPermission: true,
        repoSiblingCount: 4,
        isStackRoot: true,
        hasStackedChildren: false
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
    const ctx = baseCtx({ selected: sel({ awaitingPermission: true }) })
    expect(pick(ctx, new Set<HintId>(['permission-mode']))).not.toBe('permission-mode')
  })
})

describe('selectHint — 세션당 상한', () => {
  it('상한은 2 다 — 힌트를 더한다고 올리지 않는다', () => {
    // 힌트가 열 개가 돼도 한 세션에 새로 소개하는 것은 둘까지다. 이 값을 올리는 것이 아니라
    // 우선순위로 경쟁시키는 것이 이 레지스트리의 설계다(HINTS 위 사다리 표).
    expect(MAX_HINTS_PER_SESSION).toBe(2)
    expect(HINTS.length).toBeGreaterThan(MAX_HINTS_PER_SESSION)
  })

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
