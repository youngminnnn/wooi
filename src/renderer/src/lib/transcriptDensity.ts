import { isFileEditTool } from '@shared/toolGroups'
import type { ChatItem, TranscriptDensity } from '@shared/types'

/**
 * 대화를 얼마나 촘촘히 볼지. ⌃O 로 순환하고, 워크스페이스마다 따로 기억한다.
 *
 * 세 단계의 뜻은 Claude Code 데스크톱과 같다 — 사용자가 두 앱을 오가므로 여기서만 다른 이름을
 * 붙이면 그때마다 다시 배워야 한다.
 *
 * 워크스페이스별인 것이 요점이다. 훑기 모드의 쓸모 자체가 "이건 훑고 저건 자세히 본다" 이므로
 * 앱 전역 값으로 두면 병렬로 돌리는 워크스페이스마다 매번 다시 맞춰야 한다.
 *
 * 전역에 있는 것은 **시작점 하나**뿐이다(`settings.defaultTranscriptDensity`) — 늘 Summary 로
 * 보는 사람이 워크스페이스를 만들 때마다 ⌃O 를 누르지 않게. 워크스페이스에서 고른 값은 언제나
 * 그 시작점을 덮는다.
 *
 * 저장 위치가 localStorage 인 이유는 [[uiFlags]]·[[chatFontScale]] 와 같다 — 이건 이 기기에서
 * 지금 화면을 어떻게 보고 있는지일 뿐, main 이 알아야 할 도메인 상태가 아니다.
 */
export type { TranscriptDensity }

/** 성긴 것부터 촘촘한 것 순서. ⌃O 순환도 이 순서를 그대로 돈다. */
export const TRANSCRIPT_DENSITIES = ['summary', 'normal', 'verbose'] as const

/**
 * 아무것도 정해지지 않았을 때의 밀도.
 *
 * 실제로 적용되는 기본값은 전역 설정(`settings.defaultTranscriptDensity`)이고, 이 상수는 설정이
 * 아직 로드되기 전에 쓰는 폴백이자 그 설정의 출고값이다 — 두 값을 맞춰 둔다.
 */
export const DEFAULT_TRANSCRIPT_DENSITY: TranscriptDensity = 'normal'

export const TRANSCRIPT_DENSITY_LABEL: Record<TranscriptDensity, string> = {
  summary: 'Summary',
  normal: 'Normal',
  verbose: 'Verbose'
}

export const TRANSCRIPT_DENSITY_HINT: Record<TranscriptDensity, string> = {
  summary: 'Final replies and file changes only',
  normal: 'Tool calls folded to a summary line',
  verbose: 'Every tool call, file read, and step'
}

export function isTranscriptDensity(value: unknown): value is TranscriptDensity {
  return (TRANSCRIPT_DENSITIES as readonly unknown[]).includes(value)
}

/**
 * ⌃O 한 번. 늘 촘촘해지는 쪽으로 가고 끝에서 처음으로 돌아온다.
 *
 * 기본값(Normal)에서 처음 누르면 Verbose 다 — ⌃O 가 오래도록 "전부 펼치기" 였으므로, 그
 * 손버릇을 그대로 두고 그 다음 누름에 훑기 모드를 얹는다.
 */
export function nextTranscriptDensity(density: TranscriptDensity): TranscriptDensity {
  const i = TRANSCRIPT_DENSITIES.indexOf(density)
  return TRANSCRIPT_DENSITIES[(i + 1) % TRANSCRIPT_DENSITIES.length]
}

/**
 * 대화에 놓이는 것들을 밀도가 구분하는 만큼만 나눈 갈래.
 *
 * 도구 카드의 생김새(Wooi/터미널)나 접힘 층(개별 결과·연속 호출 묶음)은 여기서 다시 정하지
 * 않는다 — 이미 `components/tools/` 가 하는 일이고, 밀도는 그 정책에 얹히는 파라미터다.
 */
export type TranscriptEntryKind =
  /** 사용자·에이전트 말풍선, 오류, 시스템 알림, 턴 결과 — 대화 그 자체라 어느 밀도에서도 남는다. */
  | 'message'
  /** 사고 과정. */
  | 'thinking'
  /** 파일을 바꾸지 않는 도구 호출과 그 결과. */
  | 'toolCall'
  /** 파일을 바꾸는 도구 호출 — Summary 가 남기는 "실제로 바꾼 것". */
  | 'fileChange'
  /** 연속 조회 호출을 한 줄로 접은 묶음. */
  | 'toolGroup'
  /** 할 일 체크리스트 카드. */
  | 'todoList'
  /** 에이전트가 돌린 명령. */
  | 'agentBash'
  /** 사용자가 `!` 로 직접 돌린 명령 — 사용자의 턴이라 말풍선과 같이 다룬다. */
  | 'userBash'
  /** 서브에이전트 진행 카드. */
  | 'subagent'

/** 파일을 바꾸는 도구 호출인가. 기록에 diff 가 없더라도 이름으로 알아본다. */
function changesFiles(item: Extract<ChatItem, { type: 'tool_use' }>): boolean {
  return !!item.diff || isFileEditTool(item.name)
}

/**
 * 화면에 실제로 놓이는 것 하나를 갈래로 옮긴다. 체크리스트·묶음은 여러 항목을 대표하므로
 * 원본 항목 종류보다 먼저 판정한다(MessageList 의 렌더 순서와 같다).
 */
export function transcriptEntryKind(
  item: ChatItem,
  place: { todoCard?: boolean; toolGroupHead?: boolean } = {}
): TranscriptEntryKind {
  if (place.todoCard) return 'todoList'
  if (place.toolGroupHead) return 'toolGroup'
  switch (item.type) {
    case 'thinking':
      return 'thinking'
    case 'tool_use':
      return changesFiles(item) ? 'fileChange' : 'toolCall'
    case 'tool_result':
      return 'toolCall'
    case 'bash':
      return item.agent ? 'agentBash' : 'userBash'
    case 'task':
      return 'subagent'
    default:
      return 'message'
  }
}

/** Summary 가 남기는 갈래 — 에이전트의 최종 응답과 실제로 바꾼 내용, 그리고 사용자가 한 일. */
const SUMMARY_KINDS: ReadonlySet<TranscriptEntryKind> = new Set<TranscriptEntryKind>([
  'message',
  'fileChange',
  'userBash'
])

/** 이 밀도에서 이 갈래를 그리는가. Summary 만 걸러 내고, Normal·Verbose 는 전부 그린다. */
export function showsEntry(density: TranscriptDensity, kind: TranscriptEntryKind): boolean {
  return density === 'summary' ? SUMMARY_KINDS.has(kind) : true
}

/**
 * 도구 출력(개별 결과·묶음·bash 출력)을 처음부터 펼쳐 둘지.
 *
 * Verbose 에서만 참이다 — 접힘 자체를 없애는 게 아니라 기본 상태만 바꾸므로, 사용자가 카드 하나를
 * 손으로 접는 일은 어느 밀도에서든 그대로 된다.
 */
export function expandsToolOutput(density: TranscriptDensity): boolean {
  return density === 'verbose'
}

/**
 * 파일 변경 카드에 인라인 diff 까지 붙일지.
 *
 * Summary 는 "무엇이 바뀌었는지"의 목록이다. diff 원문까지 펴 두면 훑기가 아니라 가장 긴 화면이
 * 되므로 카드의 +N −M 만 남기고, 필요하면 카드를 눌러 편다.
 */
export function showsInlineDiff(density: TranscriptDensity): boolean {
  return density !== 'summary'
}

const STORAGE_PREFIX = 'wooi.transcriptDensity.'

/**
 * 기억해 둔 워크스페이스별 밀도를 한 번에 읽는다(스토어 초기값 — `readRememberedSidebarWidth`
 * 와 같은 자리). 매 렌더마다 localStorage 를 두드리지 않으려고 시작에 한 번만 훑는다.
 */
export function readRememberedTranscriptDensities(): Record<string, TranscriptDensity> {
  const out: Record<string, TranscriptDensity> = {}
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(STORAGE_PREFIX)) continue
      const value = localStorage.getItem(key)
      if (isTranscriptDensity(value)) out[key.slice(STORAGE_PREFIX.length)] = value
    }
  } catch {
    /* 기억 실패는 기본 밀도로 폴백한다. */
  }
  return out
}

/**
 * 기본값은 지운다 — 손대지 않은 워크스페이스가 저장소에 쌓이지 않게.
 *
 * `fallback` 은 지금 유효한 전역 기본값이다. 상수가 아니라 인자인 것이 요점이다: 기본값과 같은
 * 밀도를 "고른" 워크스페이스를 저장해 두면 나중에 전역 설정을 바꿔도 그 워크스페이스만 옛 값에
 * 남는다. 지워 두면 설정을 따라온다.
 */
export function rememberTranscriptDensity(
  workspaceId: string,
  density: TranscriptDensity,
  fallback: TranscriptDensity
): void {
  try {
    if (density === fallback) localStorage.removeItem(STORAGE_PREFIX + workspaceId)
    else localStorage.setItem(STORAGE_PREFIX + workspaceId, density)
  } catch {
    /* 기억하지 못해도 이번 실행 동안은 밀도가 유지된다. */
  }
}
