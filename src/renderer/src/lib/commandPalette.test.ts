import { describe, expect, it } from 'vitest'
import {
  actionDisabledReason,
  buildActionItems,
  buildCommandItems,
  buildSettingItems,
  flattenSections,
  paletteSections,
  parsePaletteQuery,
  runsImmediately,
  scoreItem,
  type PaletteContext,
  type PaletteItem
} from './commandPalette'
import { SHORTCUT_GROUPS } from './shortcutCatalog'
import { SETTINGS_PAGES } from './settingsNavigation'
import { WOOI_COMMANDS } from '@shared/wooiCommands'

/** 워크스페이스가 하나 열려 있고 무엇이든 할 수 있는 평범한 상태. */
const READY: PaletteContext = {
  hasRepos: true,
  selectedWorkspaceId: 'ws-1',
  worktreeTools: true,
  composerReachable: true,
  activeReviewId: null,
  activeFanoutGroupId: null,
  pendingPermissionCount: 2,
  selectionIsStacked: true,
  rebaseBlockedReason: null
}

const EMPTY: PaletteContext = {
  hasRepos: false,
  selectedWorkspaceId: null,
  worktreeTools: false,
  composerReachable: false,
  activeReviewId: null,
  activeFanoutGroupId: null,
  pendingPermissionCount: 0,
  selectionIsStacked: false,
  rebaseBlockedReason: null
}

function item(over: Partial<PaletteItem> = {}): PaletteItem {
  return {
    key: 'k',
    kind: 'action',
    label: 'label',
    haystack: 'label',
    effect: { type: 'action', action: 'open-settings' },
    ...over
  }
}

describe('buildActionItems', () => {
  /**
   * 이 테스트가 이 파일의 존재 이유다. 단축키를 하나 더했을 때 도움말에는 뜨는데 팔레트에는
   * 없는 상태가 되면, 두 화면이 서로 다른 앱을 설명하기 시작한다. 그것이 조용히 일어나지
   * 않게 여기서 막는다.
   */
  it('ShortcutsHelp 의 모든 항목이 인덱스에 들어온다', () => {
    const items = buildActionItems(READY)
    const labels = new Set(items.map((i) => i.label))
    const keys = new Set(items.map((i) => i.key))
    // 같은 동작이 두 그룹에 서로 다른 문장으로 적혀 있으면(⇧⌘O·⇧⌘⌫) 한 행으로 합쳐진다.
    // 그때 라벨은 하나만 남으므로, 담겼는지는 **동작 이름 또는 라벨** 중 하나로 확인한다.
    const missing = SHORTCUT_GROUPS.flatMap((g) => g.items).filter(
      (i) => !labels.has(i.label) && !(i.action && keys.has(`action:${i.action}`))
    )
    expect(missing).toEqual([])
  })

  it('합쳐진 항목도 동작 이름으로는 반드시 남는다', () => {
    const keys = new Set(buildActionItems(READY).map((i) => i.key))
    expect(keys.has('action:open-file')).toBe(true)
    expect(keys.has('action:archive-workspace')).toBe(true)
  })

  it('같은 동작이 여러 그룹에 나와도 한 번만 담는다', () => {
    // ⇧⌘O 는 Workspace tools 와 File viewer 양쪽에, ⇧⌘R 은 Session 과 PR review 양쪽에 있다.
    const items = buildActionItems(READY)
    const keys = items.map((i) => i.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.filter((k) => k === 'action:open-file')).toHaveLength(1)
    expect(keys.filter((k) => k === 'action:review-pull-request')).toHaveLength(1)
  })

  it('실행할 수 없는 항목도 빼지 않고 이유를 붙여 남긴다', () => {
    const items = buildActionItems(EMPTY)
    const archive = items.find((i) => i.key === 'action:archive-workspace')
    expect(archive?.disabledReason).toBe('Select a workspace first.')
    // 목록에서 사라지지는 않는다 — 없는 기능과 지금 안 되는 기능은 다른 사실이다.
    expect(archive?.effect).toEqual({ type: 'action', action: 'archive-workspace' })
  })

  it('동작이 없는 참조 행은 글쇠를 이유로 알려 준다', () => {
    const items = buildActionItems(READY)
    const newLine = items.find((i) => i.label === 'New line')
    expect(newLine?.effect).toBeNull()
    expect(newLine?.disabledReason).toContain('⇧⏎')
  })

  it('구분 기호는 이유 문장에서 빠진다', () => {
    const prevNext = buildActionItems(READY).find((i) => i.label === 'Previous / next workspace')
    expect(prevNext?.disabledReason).toBe('Press ⌘↑ ⌘↓ where it applies.')
  })
})

describe('actionDisabledReason', () => {
  it('열린 워크스페이스가 없어도 되는 동작이 있다', () => {
    expect(actionDisabledReason('search-conversations', EMPTY)).toBeUndefined()
    expect(actionDisabledReason('open-settings', EMPTY)).toBeUndefined()
    expect(actionDisabledReason('reopen-archived', EMPTY)).toBeUndefined()
  })

  it('리포가 없으면 만들기·리뷰가 막힌다', () => {
    expect(actionDisabledReason('new-workspace', EMPTY)).toBe('Add a repository first.')
    expect(actionDisabledReason('review-pull-request', EMPTY)).toBe('Add a repository first.')
    expect(actionDisabledReason('new-workspace', READY)).toBeUndefined()
  })

  it('아카이브 미리보기에서는 worktree 도구가 막힌다', () => {
    const archived: PaletteContext = { ...READY, worktreeTools: false }
    expect(actionDisabledReason('open-in-editor', archived)).toMatch(/archived/)
    expect(actionDisabledReason('toggle-dev-script', archived)).toMatch(/archived/)
    // worktree 가 필요 없는 것들은 그대로 살아 있다.
    expect(actionDisabledReason('toggle-work-panel', archived)).toBeUndefined()
  })

  it('리뷰가 열려 있으면 아카이브는 그 리뷰를 겨냥한다', () => {
    const review: PaletteContext = {
      ...EMPTY,
      activeReviewId: 'r1',
      hasRepos: true
    }
    expect(actionDisabledReason('archive-workspace', review)).toBeUndefined()
    // 영구 삭제는 대상이 화면에 없으므로 받지 않는다.
    expect(actionDisabledReason('delete-workspace', review)).toBe('Close the review first.')
  })

  it('팬아웃 비교 화면에서는 헤더 도구가 막힌다', () => {
    const fanout: PaletteContext = { ...READY, activeFanoutGroupId: 'g1' }
    expect(actionDisabledReason('open-in-editor', fanout)).toMatch(/fan-out/)
  })

  it('승인할 권한이 없으면 일괄 승인이 막힌다', () => {
    expect(actionDisabledReason('approve-all-permissions', READY)).toBeUndefined()
    expect(
      actionDisabledReason('approve-all-permissions', { ...READY, pendingPermissionCount: 0 })
    ).toBe('Nothing is waiting for permission.')
  })

  it('rebase 는 게이트가 막으면 그 문장을 그대로 이유로 쓴다', () => {
    expect(actionDisabledReason('rebase-onto-base', READY)).toBeUndefined()
    // 문장을 여기서 새로 쓰지 않는다 — rebaseGate 가 만든 것을 그대로 통과시킨다.
    expect(
      actionDisabledReason('rebase-onto-base', {
        ...READY,
        rebaseBlockedReason: 'Already up to date with main.'
      })
    ).toBe('Already up to date with main.')
  })

  it('rebase 는 워크스페이스·worktree 조건이 게이트보다 먼저다', () => {
    // 대상이 없으면 게이트를 물어볼 것도 없다.
    expect(actionDisabledReason('rebase-onto-base', EMPTY)).toBe('Select a workspace first.')
    expect(actionDisabledReason('rebase-onto-base', { ...READY, worktreeTools: false })).toMatch(
      /archived/
    )
  })

  it('스택이 아니면 스택 화면이 막힌다', () => {
    expect(actionDisabledReason('open-stack-view', READY)).toBeUndefined()
    expect(actionDisabledReason('open-stack-view', { ...READY, selectionIsStacked: false })).toBe(
      'This workspace is not stacked on anything.'
    )
    expect(actionDisabledReason('open-stack-view', EMPTY)).toBe('Select a workspace first.')
  })

  it('아카이브 미리보기에서도 스택 화면은 열린다', () => {
    // 스택 화면이 그리는 것은 worktree 가 아니라 브랜치 관계다.
    expect(
      actionDisabledReason('open-stack-view', { ...READY, worktreeTools: false })
    ).toBeUndefined()
  })

  it('대화가 가려져 있으면 입력창 포커스가 막힌다', () => {
    expect(actionDisabledReason('focus-composer', { ...READY, composerReachable: false })).toBe(
      'The conversation is covered right now.'
    )
  })
})

describe('buildCommandItems', () => {
  it('모든 /wooi:* 커맨드가 인덱스에 들어온다', () => {
    expect(buildCommandItems(READY)).toHaveLength(WOOI_COMMANDS.length)
  })

  /**
   * agent 모드는 산문 인자를 요구한다 — 팔레트가 빈 `$ARGUMENTS` 로 대신 실행하면 에이전트가
   * 아무 맥락 없이 턴을 태운다. 인자를 받는 direct 커맨드도 같은 이유로 입력창에 채워만 둔다.
   */
  it('agent 모드는 실행하지 않고 입력창에 채워 넣기만 한다', () => {
    for (const spec of WOOI_COMMANDS.filter((c) => c.mode === 'agent')) {
      const found = buildCommandItems(READY).find((i) => i.key === `command:${spec.name}`)
      expect(found?.effect).toEqual({ type: 'fill-composer', text: `/wooi:${spec.name} ` })
    }
  })

  it('인자가 필요한 direct 커맨드도 채워 넣기만 한다', () => {
    const run = buildCommandItems(READY).find((i) => i.key === 'command:run')
    expect(runsImmediately(WOOI_COMMANDS.find((c) => c.name === 'run')!)).toBe(false)
    expect(run?.effect).toEqual({ type: 'fill-composer', text: '/wooi:run ' })
  })

  it('인자 없는 direct 커맨드만 곧장 실행한다', () => {
    const peers = buildCommandItems(READY).find((i) => i.key === 'command:peers')
    expect(peers?.effect?.type).toBe('run-command')
  })

  it('열린 대화가 없으면 커맨드는 비활성이다', () => {
    for (const found of buildCommandItems(EMPTY)) {
      expect(found.disabledReason).toBe('Select a workspace first.')
    }
  })
})

describe('buildSettingItems', () => {
  it('설정 페이지가 모두 들어오고 키워드로 찾힌다', () => {
    const items = buildSettingItems()
    expect(items).toHaveLength(SETTINGS_PAGES.length)
    // 'stdio' 는 MCP 페이지의 키워드다 — 라벨에는 없다. 부분 수열 그물에는 다른 쪽도 걸리므로
    // "걸렸는가" 가 아니라 "제일 위인가" 로 확인한다. 사용자가 보는 것도 그쪽이다.
    const best = items
      .map((i) => ({ i, score: scoreItem(i, 'stdio') }))
      .filter((x) => x.score !== null)
      .sort((a, b) => b.score! - a.score!)[0]
    expect(best.i.effect).toEqual({ type: 'open-settings', page: 'mcp' })
  })
})

describe('parsePaletteQuery', () => {
  it('접두사로 종류를 좁힌다', () => {
    expect(parsePaletteQuery('> archive')).toEqual({ kind: 'action', text: 'archive' })
    expect(parsePaletteQuery('@login')).toEqual({ kind: 'workspace', text: 'login' })
    expect(parsePaletteQuery('#theme')).toEqual({ kind: 'setting', text: 'theme' })
    expect(parsePaletteQuery('/wooi:pr')).toEqual({ kind: 'command', text: 'wooi:pr' })
  })

  it('접두사가 없으면 모든 종류를 본다', () => {
    expect(parsePaletteQuery('  Archive ')).toEqual({ kind: null, text: 'archive' })
  })
})

describe('scoreItem', () => {
  it('앞에서 걸린 것이 뒤에서 걸린 것보다 높다', () => {
    const head = item({ haystack: 'archive workspace' })
    const middle = item({ haystack: 'reopen the archive' })
    const scattered = item({ haystack: 'a really cool huge interesting verbose entry' })
    expect(scoreItem(head, 'archive')!).toBeGreaterThan(scoreItem(middle, 'archive')!)
    expect(scoreItem(middle, 'archive')!).toBeGreaterThan(scoreItem(scattered, 'archive')!)
  })

  it('단어 경계 매치가 단어 중간 매치보다 높다', () => {
    const boundary = item({ haystack: 'new workspace in the focused repository' })
    const inside = item({ haystack: 'reworkspaced' })
    expect(scoreItem(boundary, 'workspace')!).toBeGreaterThan(scoreItem(inside, 'workspace')!)
  })

  it('띄엄띄엄 쳐도 걸린다', () => {
    expect(scoreItem(item({ haystack: 'fix-login' }), 'fxlgn')).not.toBeNull()
    expect(scoreItem(item({ haystack: 'fix-login' }), 'zzz')).toBeNull()
  })

  it('정규식 특수문자를 그대로 찾는다', () => {
    expect(scoreItem(item({ haystack: 'settings — mcp (a+b)' }), '(a+b)')).not.toBeNull()
  })

  it('빈 질의는 모두 통과시킨다', () => {
    expect(scoreItem(item({ haystack: 'anything' }), '')).toBe(0)
  })
})

describe('paletteSections', () => {
  const items: PaletteItem[] = [
    item({ key: 'w1', kind: 'workspace', label: 'zeta', haystack: 'zeta' }),
    item({ key: 'w2', kind: 'workspace', label: 'alpha', haystack: 'alpha' }),
    item({ key: 'a1', kind: 'action', label: 'Archive workspace', haystack: 'archive workspace' }),
    item({
      key: 's1',
      kind: 'setting',
      label: 'Settings — General',
      haystack: 'settings general archive'
    })
  ]

  it('빈 질의에서는 워크스페이스가 맨 위다', () => {
    const sections = paletteSections(items, '')
    expect(sections[0].kind).toBe('workspace')
    // 사이드바 순서를 그대로 지킨다 — ⌘1–9 번호 배지와 어긋나면 안 된다.
    expect(sections[0].items.map((i) => i.label)).toEqual(['zeta', 'alpha'])
  })

  it('질의가 있으면 가장 잘 맞은 섹션이 위로 온다', () => {
    const sections = paletteSections(items, 'archive')
    expect(sections[0].kind).toBe('action')
    expect(sections.some((s) => s.kind === 'workspace')).toBe(false)
  })

  it('접두사는 그 종류만 남긴다', () => {
    const sections = paletteSections(items, '@alpha')
    expect(sections).toHaveLength(1)
    expect(sections[0].kind).toBe('workspace')
    expect(flattenSections(sections).map((i) => i.label)).toEqual(['alpha'])
  })

  it('맞는 것이 없으면 빈 목록이다', () => {
    expect(flattenSections(paletteSections(items, 'qqqq'))).toEqual([])
  })

  it('평평하게 편 순서가 섹션을 그리는 순서와 같다', () => {
    const sections = paletteSections(items, '')
    expect(flattenSections(sections)).toEqual(sections.flatMap((s) => s.items))
  })
})
