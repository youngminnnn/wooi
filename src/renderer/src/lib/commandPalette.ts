/**
 * ⌘K 팔레트가 검색하는 **항목 인덱스와 순위**. React 도 store 도 모르는 순수 함수만 둔다.
 *
 * Wooi 는 기능이 많은데 그 전부를 한곳에서 찾을 방법이 없었다 — 단축키는 도움말 모달에,
 * `/wooi:*` 는 입력창 자동완성에, 설정은 설정 모달 검색창에 흩어져 있고, ⌘K 는 워크스페이스만
 * 찾았다. 여기서 하는 일은 **그 세 목록을 새로 쓰지 않고 그대로 모으는 것**이다. 어느 하나라도
 * 여기에 베껴 적으면 그 순간부터 두 벌이 갈라진다.
 *
 * 실행할 수 없는 항목을 목록에서 빼지 않는다. 워크스페이스를 안 골랐다고 "아카이브"를 지워
 * 버리면, 사용자는 그 기능이 없는 앱을 보게 된다 — 있는데 지금은 안 된다는 것과 아예 없다는
 * 것은 다른 사실이다. 비활성으로 두고 왜 안 되는지 한 줄을 옆에 적는다.
 */

import { SHORTCUT_GROUPS, type PaletteActionId } from './shortcutCatalog'
import { SETTINGS_PAGES, type SettingsPage } from './settingsNavigation'
import { WOOI_COMMANDS, wooiCommandName, type WooiCommandSpec } from '@shared/wooiCommands'

/** 항목의 종류. 팔레트는 이 순서대로 섹션을 그린다(동점일 때). */
export type PaletteKind = 'workspace' | 'action' | 'command' | 'setting'

export const SECTION_TITLES: Record<PaletteKind, string> = {
  workspace: 'Workspaces',
  action: 'Actions',
  command: 'Commands',
  setting: 'Settings'
}

/** 섹션끼리 점수가 같을 때의 순서. 워크스페이스가 먼저다 — ⌘K 의 원래 용도가 이동이다. */
const KIND_ORDER: PaletteKind[] = ['workspace', 'action', 'command', 'setting']

/**
 * 항목을 고르면 무엇이 일어나는가. 팔레트 컴포넌트가 이 값을 보고 분기한다.
 *
 * `fill-composer` 가 따로 있는 이유: `agent` 모드 `/wooi:*` 는 산문 인자를 요구한다. 인자 없이
 * 대신 실행해 주면 에이전트가 빈 `$ARGUMENTS` 로 턴을 태우게 되므로, 팔레트는 **입력창에
 * 채워 넣기만 하고** 무엇을 쓸지는 사용자에게 남긴다. 필수 인자가 있는 `direct` 커맨드도 같다.
 */
export type PaletteEffect =
  | { type: 'action'; action: PaletteActionId }
  | { type: 'select-workspace'; workspaceId: string | null }
  | { type: 'repo-settings'; repoId: string }
  | { type: 'open-settings'; page: SettingsPage }
  | { type: 'run-command'; command: WooiCommandSpec }
  | { type: 'fill-composer'; text: string }

export interface PaletteItem {
  /** React key 겸 커서 식별자. 종류가 다르면 같은 id 가 나올 수 있어 접두사를 붙인다. */
  key: string
  kind: PaletteKind
  label: string
  /** 라벨 왼쪽에 붙는 작은 글자(레포명 등). */
  prefix?: string
  /** 라벨 아래 줄(브랜치·인자 힌트 등). */
  detail?: string
  /** 오른쪽에 그릴 글쇠. `SHORTCUT_GROUPS` 의 keys 를 그대로 쓴다. */
  keys?: string[]
  /** 검색 대상. 소문자로 만들어 둔다. */
  haystack: string
  effect: PaletteEffect | null
  /** null 이 아니면 비활성 — 이 문장을 이유로 보여 준다. */
  disabledReason?: string
}

/** 항목이 지금 실행 가능한지 판단하는 데 필요한 앱 상태. store 를 그대로 넘기지 않는다. */
export interface PaletteContext {
  hasRepos: boolean
  selectedWorkspaceId: string | null
  /** worktree 가 있어야 성립하는 도구가 가능한가(아카이브 미리보기면 false). */
  worktreeTools: boolean
  /** 메시지 입력창에 지금 닿을 수 있는가(리뷰·팬아웃·파일 뷰어에 가려지지 않았는가). */
  composerReachable: boolean
  activeReviewId: string | null
  activeFanoutGroupId: string | null
  pendingPermissionCount: number
  /** 고른 워크스페이스가 스택에 속해 있는가(혼자면 펼칠 지도가 없다). */
  selectionIsStacked: boolean
  /**
   * rebase 가 막혀 있다면 그 이유. 문장은 [[lib/rebaseGate]] 가 만든 것을 그대로 받는다 —
   * 충돌·이미 최신·스택 동기화 대기처럼 조건이 여럿이고, 그 판정은 헤더의 Rebase 칩과
   * 단축키가 이미 공유하고 있다. 여기서 다시 쓰면 셋이 갈라진다.
   */
  rebaseBlockedReason: string | null
}

const NO_WORKSPACE = 'Select a workspace first.'
const ARCHIVED = 'This workspace is archived — its worktree is gone.'
const NO_REPO = 'Add a repository first.'
const HIDDEN_BY_OVERLAY = 'The conversation is covered right now.'

/**
 * 동작이 지금 가능한지, 아니면 왜 불가능한지.
 *
 * 판정 근거는 전역 keydown 이 쓰는 것과 같다(`workspaceSurfaces`·`activeReviewId` 등). 팔레트만
 * 다른 규칙을 쓰면 "팔레트에서는 눌리는데 단축키는 안 먹는" 상태가 생긴다.
 */
export function actionDisabledReason(
  action: PaletteActionId,
  ctx: PaletteContext
): string | undefined {
  switch (action) {
    // 어디서든 된다.
    case 'open-shortcuts':
    case 'search-conversations':
    case 'next-unread':
    case 'next-needs-input':
    case 'undo-workspace-action':
    case 'reopen-archived':
    case 'open-settings':
      return undefined

    case 'new-workspace':
    case 'new-workspace-choose-agent':
    case 'review-pull-request':
      return ctx.hasRepos ? undefined : NO_REPO

    case 'approve-all-permissions':
      return ctx.pendingPermissionCount > 0 ? undefined : 'Nothing is waiting for permission.'

    // 리뷰가 열려 있으면 아카이브의 대상은 뒤에 가려진 워크스페이스가 아니라 그 리뷰다.
    case 'archive-workspace':
      if (ctx.activeReviewId) return undefined
      if (!ctx.selectedWorkspaceId) return NO_WORKSPACE
      return ctx.worktreeTools ? undefined : ARCHIVED

    // 팬아웃 비교 화면 위에서는 대상 워크스페이스가 화면에 없다 — 무엇을 건드렸는지 알 수 없다.
    case 'toggle-dev-script':
    case 'toggle-scripts-panel':
    case 'open-in-editor':
    case 'reveal-in-finder':
    case 'export-conversation':
    case 'open-file':
    case 'delete-workspace':
    case 'rebase-onto-base':
      if (ctx.activeFanoutGroupId) return 'Leave the fan-out comparison first.'
      if (action === 'delete-workspace' && ctx.activeReviewId) return 'Close the review first.'
      if (!ctx.selectedWorkspaceId) return NO_WORKSPACE
      if (!ctx.worktreeTools) return ARCHIVED
      // worktree 가 있어도 rebase 는 더 막힐 수 있다 — 게이트가 이유까지 들고 있다.
      return action === 'rebase-onto-base' ? (ctx.rebaseBlockedReason ?? undefined) : undefined

    case 'cycle-permission-mode':
    case 'toggle-tool-results':
    case 'toggle-work-panel':
      return ctx.selectedWorkspaceId ? undefined : NO_WORKSPACE

    // 아카이브 미리보기여도 된다 — 스택 화면은 worktree 가 아니라 브랜치 관계를 그린다.
    case 'open-stack-view':
      if (!ctx.selectedWorkspaceId) return NO_WORKSPACE
      return ctx.selectionIsStacked ? undefined : 'This workspace is not stacked on anything.'

    case 'focus-composer':
      if (!ctx.selectedWorkspaceId) return NO_WORKSPACE
      if (!ctx.worktreeTools) return ARCHIVED
      return ctx.composerReachable ? undefined : HIDDEN_BY_OVERLAY
  }
}

/**
 * `/wooi:*` 를 팔레트에서 곧장 돌려도 되는가.
 *
 * 인자 힌트가 없는 `direct` 커맨드만이다. 인자를 받는 커맨드는 힌트를 보고 사용자가 써야 하고,
 * `agent` 커맨드는 산문 인자가 있어야 뜻이 생긴다 — 둘 다 입력창에 채워 넣는다.
 */
export function runsImmediately(spec: WooiCommandSpec): boolean {
  return spec.mode === 'direct' && !spec.argumentHint
}

/** 단축키 카탈로그 → 팔레트 항목. 같은 동작이 여러 그룹에 나오면 처음 것만 남긴다. */
export function buildActionItems(ctx: PaletteContext): PaletteItem[] {
  const seen = new Set<PaletteActionId>()
  const items: PaletteItem[] = []
  for (const group of SHORTCUT_GROUPS) {
    for (const item of group.items) {
      const reason = item.action
        ? actionDisabledReason(item.action, ctx)
        : // 참조 행 — 팔레트가 대신 눌러 줄 수 있는 종류의 키가 아니다.
          `Press ${item.keys.filter((k) => k !== '/' && k !== '–').join(' ')} where it applies.`
      if (item.action) {
        if (seen.has(item.action)) continue
        seen.add(item.action)
      }
      items.push({
        key: item.action ? `action:${item.action}` : `key:${group.title}:${item.label}`,
        kind: 'action',
        label: item.label,
        keys: item.keys,
        haystack: `${item.label} ${group.title}`.toLowerCase(),
        effect: item.action ? { type: 'action', action: item.action } : null,
        disabledReason: reason
      })
    }
  }
  return items
}

/** `/wooi:*` 카탈로그 → 팔레트 항목. */
export function buildCommandItems(ctx: PaletteContext): PaletteItem[] {
  return WOOI_COMMANDS.map((spec) => {
    const name = `/${wooiCommandName(spec)}`
    const immediate = runsImmediately(spec)
    return {
      key: `command:${spec.name}`,
      kind: 'command' as const,
      label: name,
      detail: immediate
        ? spec.description
        : `${spec.description} — fills the message input${spec.argumentHint ? ` (${spec.argumentHint})` : ''}`,
      haystack: `${name} ${spec.description} ${spec.argumentHint ?? ''}`.toLowerCase(),
      effect: immediate
        ? { type: 'run-command' as const, command: spec }
        : { type: 'fill-composer' as const, text: `${name} ` },
      // 둘 다 열린 대화가 있어야 한다 — 실행은 세션에서 돌고, 채워 넣을 입력창도 거기 있다.
      disabledReason: !ctx.selectedWorkspaceId
        ? NO_WORKSPACE
        : !ctx.worktreeTools
          ? ARCHIVED
          : ctx.composerReachable
            ? undefined
            : HIDDEN_BY_OVERLAY
    }
  })
}

/** 설정 페이지 → 팔레트 항목. 키워드는 설정 모달 검색이 쓰는 것과 같은 문자열이다. */
export function buildSettingItems(): PaletteItem[] {
  return SETTINGS_PAGES.map((page) => ({
    key: `setting:${page.id}`,
    kind: 'setting' as const,
    label: `Settings — ${page.label}`,
    haystack: `settings ${page.label} ${page.keywords}`.toLowerCase(),
    effect: { type: 'open-settings' as const, page: page.id }
  }))
}

/** 접두사로 종류를 좁힌다. `>` 동작, `@` 워크스페이스, `/` 커맨드, `#` 설정. */
export const PALETTE_PREFIXES: { prefix: string; kind: PaletteKind }[] = [
  { prefix: '>', kind: 'action' },
  { prefix: '@', kind: 'workspace' },
  { prefix: '#', kind: 'setting' },
  { prefix: '/', kind: 'command' }
]

export interface ParsedQuery {
  /** null 이면 모든 종류를 본다. */
  kind: PaletteKind | null
  /** 접두사를 뗀 나머지(소문자, 앞뒤 공백 제거). */
  text: string
}

/**
 * `/` 는 접두사이면서 `/wooi:pr` 처럼 항목 이름의 일부이기도 하다. 떼어 내도 나머지가 그대로
 * 커맨드 검색어로 쓰이므로 어느 쪽으로 읽어도 결과가 같다 — 굳이 갈라 놓지 않는다.
 */
export function parsePaletteQuery(raw: string): ParsedQuery {
  const trimmed = raw.trim()
  for (const { prefix, kind } of PALETTE_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      return { kind, text: trimmed.slice(prefix.length).trim().toLowerCase() }
    }
  }
  return { kind: null, text: trimmed.toLowerCase() }
}

/**
 * 질의가 대상의 부분 수열(subsequence)로 등장하는지. "fxlgn" → "fix-login" 처럼 띄엄띄엄 쳐도
 * 걸리게 해서, 긴 브랜치명·긴 라벨을 몇 글자로 좁힐 수 있게 한다.
 */
function fuzzyMatch(haystack: string, query: string): boolean {
  let i = 0
  for (const ch of haystack) {
    if (ch === query[i]) i++
    if (i === query.length) return true
  }
  return query.length === 0
}

/**
 * 점수. 높을수록 위다. 매치가 없으면 null.
 *
 * 단계가 넷인 이유: 사람은 보통 항목 이름의 **앞부터** 친다. 앞에서 걸린 것을 먼저 보여 주지
 * 않으면, 정확히 이름을 치고도 부분 수열로 우연히 걸린 남의 브랜치 뒤에 서게 된다.
 */
export function scoreItem(item: PaletteItem, query: string): number | null {
  if (!query) return 0
  const hay = item.haystack
  if (hay.startsWith(query)) return 100
  // 단어 경계에서 시작하는 매치("workspace" 로 "New workspace" 를 찾는 경우).
  if (new RegExp(`\\b${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(hay)) return 80
  if (hay.includes(query)) return 60
  // 마지막 그물: 공백을 걷어 낸 부분 수열. 질의도 같이 걷어 내야 "fx lgn" 이 걸린다.
  const squashedQuery = query.replace(/\s+/g, '')
  if (squashedQuery && fuzzyMatch(hay.replace(/\s+/g, ''), squashedQuery)) return 20
  return null
}

export interface PaletteSection {
  kind: PaletteKind
  title: string
  items: PaletteItem[]
}

/**
 * 항목 목록 → 화면에 그릴 섹션들.
 *
 * 섹션 순서는 그 안의 **최고 점수**가 정한다. 종류별 순서를 고정해 두면 "archive" 를 쳤을 때
 * 이름에 archive 가 든 워크스페이스가 없어도 Actions 가 한참 아래에 깔린다. 동점(=빈 질의)이면
 * `KIND_ORDER` 로 갈라 워크스페이스가 맨 위에 온다 — ⌘K 를 이동에 쓰던 손을 흔들지 않는다.
 *
 * 워크스페이스 섹션 **안의** 순서는 건드리지 않는다. 사이드바와 같은 위→아래 순서라야 ⌘1–9
 * 번호 배지와 눈으로 익힌 위치 감각이 어긋나지 않는다(호출자가 그 순서대로 넘긴다).
 */
export function paletteSections(
  items: PaletteItem[],
  rawQuery: string,
  kindFilter: PaletteKind | null = null
): PaletteSection[] {
  const { kind, text } = parsePaletteQuery(rawQuery)
  const only = kindFilter ?? kind

  const byKind = new Map<PaletteKind, { item: PaletteItem; score: number }[]>()
  for (const item of items) {
    if (only && item.kind !== only) continue
    const score = scoreItem(item, text)
    if (score === null) continue
    const bucket = byKind.get(item.kind)
    if (bucket) bucket.push({ item, score })
    else byKind.set(item.kind, [{ item, score }])
  }

  const sections: PaletteSection[] = []
  for (const [k, scored] of byKind) {
    // 워크스페이스는 넘어온 순서를 지킨다. 나머지는 점수 순으로 세우되 동점이면 원래 순서다.
    const ordered =
      k === 'workspace'
        ? scored
        : [...scored].sort(
            (a, b) => b.score - a.score || items.indexOf(a.item) - items.indexOf(b.item)
          )
    sections.push({
      kind: k,
      title: SECTION_TITLES[k],
      items: ordered.map((s) => s.item)
    })
  }

  const best = new Map<PaletteKind, number>()
  for (const [k, scored] of byKind) best.set(k, Math.max(...scored.map((s) => s.score)))
  sections.sort(
    (a, b) =>
      (best.get(b.kind) ?? 0) - (best.get(a.kind) ?? 0) ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
  )
  return sections
}

/** 섹션들을 위→아래 한 줄로 편다. 커서 이동은 이 평평한 목록 위에서 일어난다. */
export function flattenSections(sections: PaletteSection[]): PaletteItem[] {
  return sections.flatMap((s) => s.items)
}
