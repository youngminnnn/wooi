import { describe, expect, it } from 'vitest'
import {
  clampSplitFraction,
  focusedPane,
  livePaneView,
  mainPane,
  openSplit,
  paneState,
  samePane,
  selectIntoPanes,
  splitPairing,
  withFocusedPaneClosed
} from './splitPanes'
import type { PaneState, PaneView } from './splitPanes'

/** 부모 → 자식 → 손자 한 줄, 그리고 스택 밖의 외톨이 하나. */
const WORKSPACES = [
  { id: 'root', parentWorkspaceId: null },
  { id: 'child', parentWorkspaceId: 'root' },
  { id: 'grandchild', parentWorkspaceId: 'child' },
  { id: 'loner', parentWorkspaceId: null }
]

const ws = (id: string): PaneView => ({ kind: 'workspace', workspaceId: id })
const review = (id: string): PaneView => ({ kind: 'review', reviewId: id })
const state = (
  main: PaneView | null,
  split: PaneView | null,
  focus: 'main' | 'split'
): PaneState => ({ main, split, focus })

describe('splitPairing — 무엇이 나란히 설 수 있는가', () => {
  it('같은 스택의 두 층은 성립한다(부모↔자식, 그리고 건너뛴 층도)', () => {
    expect(splitPairing(WORKSPACES, ws('root'), ws('child'))).toBe('stack')
    expect(splitPairing(WORKSPACES, ws('child'), ws('root'))).toBe('stack')
    expect(splitPairing(WORKSPACES, ws('root'), ws('grandchild'))).toBe('stack')
  })

  it('스택이 다른 두 워크스페이스는 성립하지 않는다', () => {
    expect(splitPairing(WORKSPACES, ws('root'), ws('loner'))).toBeNull()
  })

  it('리뷰는 어떤 대화와도 짝지을 수 있다 — 고칠 곳이 리뷰 대상과 같은 스택이라는 법이 없다', () => {
    expect(splitPairing(WORKSPACES, review('r1'), ws('loner'))).toBe('review')
    expect(splitPairing(WORKSPACES, ws('loner'), review('r1'))).toBe('review')
  })

  it('리뷰 두 개와 같은 것 두 번은 성립하지 않는다', () => {
    expect(splitPairing(WORKSPACES, review('r1'), review('r2'))).toBeNull()
    expect(splitPairing(WORKSPACES, ws('root'), ws('root'))).toBeNull()
    expect(splitPairing(WORKSPACES, null, ws('root'))).toBeNull()
  })
})

describe('selectIntoPanes — 고르면 어느 칸이 바뀌는가', () => {
  it('분할이 아니면 예전 그대로 주 칸을 갈아 끼운다', () => {
    expect(selectIntoPanes(WORKSPACES, state(ws('root'), null, 'main'), ws('loner'))).toEqual(
      state(ws('loner'), null, 'main')
    )
  })

  it('분할 중이면 포커스된 칸만 바뀐다 — 짝은 그대로 남는다', () => {
    const before = state(ws('root'), ws('child'), 'split')
    expect(selectIntoPanes(WORKSPACES, before, ws('grandchild'))).toEqual(
      state(ws('root'), ws('grandchild'), 'split')
    )
  })

  it('포커스가 주 칸이면 주 칸이 바뀌고 오른쪽은 버티고 있는다', () => {
    const before = state(ws('root'), ws('child'), 'main')
    expect(selectIntoPanes(WORKSPACES, before, ws('grandchild'))).toEqual(
      state(ws('grandchild'), ws('child'), 'main')
    )
  })

  it('양쪽이 같은 것을 비추게 되면 분할을 접는다', () => {
    const before = state(ws('root'), ws('child'), 'split')
    expect(selectIntoPanes(WORKSPACES, before, ws('root'))).toEqual(state(ws('root'), null, 'main'))
  })

  it('짝이 깨지는 것을 고르면 분할을 접고 고른 것만 남긴다', () => {
    const before = state(ws('root'), ws('child'), 'split')
    expect(selectIntoPanes(WORKSPACES, before, ws('loner'))).toEqual(
      state(ws('loner'), null, 'main')
    )
  })

  it('대화 옆의 리뷰 칸은 다른 리뷰로 갈아 끼울 수 있다 — 여전히 리뷰↔대화다', () => {
    const before = state(ws('root'), review('r1'), 'split')
    expect(selectIntoPanes(WORKSPACES, before, review('r2'))).toEqual(
      state(ws('root'), review('r2'), 'split')
    )
  })

  it('그래서 리뷰가 둘이 되는 순간에만 접힌다', () => {
    const before = state(review('r1'), ws('root'), 'split')
    expect(selectIntoPanes(WORKSPACES, before, review('r2'))).toEqual(
      state(review('r2'), null, 'main')
    )
  })
})

describe('openSplit — ⌘+클릭', () => {
  it('성립하는 짝이면 오른쪽에 세우고 포커스를 준다', () => {
    expect(openSplit(WORKSPACES, state(ws('root'), null, 'main'), ws('child'))).toEqual(
      state(ws('root'), ws('child'), 'split')
    )
  })

  it('성립하지 않으면 아무것도 하지 않는다', () => {
    const before = state(ws('root'), null, 'main')
    expect(openSplit(WORKSPACES, before, ws('loner'))).toBe(before)
    expect(openSplit(WORKSPACES, state(null, null, 'main'), ws('child'))).toEqual(
      state(null, null, 'main')
    )
  })

  it('이미 분할 중이면 오른쪽 칸을 갈아 끼운다', () => {
    expect(openSplit(WORKSPACES, state(ws('root'), ws('child'), 'main'), ws('grandchild'))).toEqual(
      state(ws('root'), ws('grandchild'), 'split')
    )
  })
})

describe('withFocusedPaneClosed — 닫으면 무엇이 남는가', () => {
  it('오른쪽을 닫으면 사라지고 주 칸이 남는다', () => {
    expect(withFocusedPaneClosed(state(ws('root'), ws('child'), 'split'))).toEqual(
      state(ws('root'), null, 'main')
    )
  })

  it('왼쪽을 닫으면 오른쪽이 그 자리로 올라온다 — 남긴 칸이 화면에 남아야 한다', () => {
    expect(withFocusedPaneClosed(state(ws('root'), ws('child'), 'main'))).toEqual(
      state(ws('child'), null, 'main')
    )
  })

  it('분할이 아니면 아무 일도 없다', () => {
    const before = state(ws('root'), null, 'main')
    expect(withFocusedPaneClosed(before)).toBe(before)
  })
})

describe('focusedPane — 단축키의 대상', () => {
  it('분할이 아니면 언제나 주 칸이다', () => {
    expect(focusedPane(state(ws('root'), null, 'split'))).toEqual(ws('root'))
  })

  it('분할 중에는 포커스를 따라간다', () => {
    expect(focusedPane(state(review('r1'), ws('child'), 'split'))).toEqual(ws('child'))
    expect(focusedPane(state(review('r1'), ws('child'), 'main'))).toEqual(review('r1'))
  })
})

describe('mainPane / paneState — 스토어 축 읽기', () => {
  it('리뷰가 열려 있으면 주 칸은 리뷰다(선택은 그대로 남아 있어도)', () => {
    expect(mainPane({ activeReviewId: 'r1', selectedWorkspaceId: 'root' })).toEqual(review('r1'))
    expect(mainPane({ activeReviewId: null, selectedWorkspaceId: 'root' })).toEqual(ws('root'))
    expect(mainPane({ activeReviewId: null, selectedWorkspaceId: null })).toBeNull()
  })

  it('스토어 상태를 그대로 옮긴다', () => {
    expect(
      paneState({
        activeReviewId: null,
        selectedWorkspaceId: 'root',
        splitPane: ws('child'),
        splitFocus: 'split'
      })
    ).toEqual(state(ws('root'), ws('child'), 'split'))
  })
})

describe('livePaneView — 사라진 것을 가리키는 칸', () => {
  const app = {
    workspaces: [
      { id: 'root', archived: false },
      { id: 'gone', archived: true }
    ],
    reviews: [
      { id: 'r1', archived: false },
      { id: 'r-old', archived: true }
    ]
  }

  it('살아 있으면 그대로 둔다', () => {
    expect(livePaneView(app, ws('root'))).toEqual(ws('root'))
    expect(livePaneView(app, review('r1'))).toEqual(review('r1'))
  })

  it('아카이브·삭제된 것을 가리키면 접는다', () => {
    expect(livePaneView(app, ws('gone'))).toBeNull()
    expect(livePaneView(app, ws('never-existed'))).toBeNull()
    expect(livePaneView(app, review('r-old'))).toBeNull()
  })

  it('아직 앱 상태가 없으면 판단을 미룬다', () => {
    expect(livePaneView(null, ws('root'))).toEqual(ws('root'))
    expect(livePaneView(app, null)).toBeNull()
  })
})

describe('보조', () => {
  it('samePane 은 종류까지 본다', () => {
    expect(samePane(ws('a'), ws('a'))).toBe(true)
    expect(samePane(ws('a'), review('a'))).toBe(false)
    expect(samePane(null, null)).toBe(false)
  })

  it('분할 비율은 어느 쪽도 읽을 수 없을 만큼 좁아지지 않는다', () => {
    expect(clampSplitFraction(0.5)).toBe(0.5)
    expect(clampSplitFraction(0.01)).toBe(0.25)
    expect(clampSplitFraction(0.99)).toBe(0.75)
    expect(clampSplitFraction(Number.NaN)).toBe(0.5)
  })
})
