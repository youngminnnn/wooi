/**
 * ⌘Z — 방금 만든 워크스페이스 되돌리기의 판단 규칙.
 *
 * 생성 되돌리기는 "⌘N 을 잘못 눌렀다" 를 취소하는 장치다. 그래서 두 가지를 함께 지킨다:
 *
 * 1. **아직 손대지 않은 워크스페이스만 조용히 사라진다.** 세션이 붙었거나 파일이 바뀌었거나
 *    커밋·PR 이 생겼다면 그건 더 이상 실수로 만든 빈 워크스페이스가 아니므로, 일반 삭제와
 *    같은 확인을 거치게 한다(무엇을 잃는지 보여 준 뒤 지운다).
 * 2. **한참 뒤의 ⌘Z 는 되돌리기가 아니다.** 시간이 지난 뒤 워크스페이스가 소리 없이 사라지면
 *    실행취소가 아니라 사고다 — 창(window)을 넘기면 아무 일도 하지 않는다.
 */

/** 생성 되돌리기가 유효한 시간. */
export const UNDO_CREATE_WINDOW_MS = 5 * 60_000

/** ⌘Z 로 되돌릴 수 있는 직전 워크스페이스 생성. 한 단계만 기억한다. */
export interface UndoableCreate {
  workspaceId: string
  /** 생성 시각(epoch ms). */
  at: number
}

export type UndoCreateVerdict =
  /** 손댄 적 없는 워크스페이스 — 묻지 않고 지운다. */
  | 'undo'
  /** 이미 쓴 흔적이 있다 — 일반 삭제와 같은 확인을 거친다. */
  | 'confirm'
  /** 되돌릴 것이 없다(이미 사라졌거나 시간이 지났다). */
  | 'nothing'

export function undoCreateVerdict(
  undoable: UndoableCreate | null,
  workspace:
    | {
        archived: boolean
        sessionId: string | null
        status: string
        prNumber: number | null
      }
    | undefined,
  git: { changedFiles: number; ahead: number } | null | undefined,
  now: number
): UndoCreateVerdict {
  if (!undoable || !workspace || workspace.archived) return 'nothing'
  if (now - undoable.at > UNDO_CREATE_WINDOW_MS) return 'nothing'
  const untouched =
    !workspace.sessionId &&
    workspace.status === 'idle' &&
    workspace.prNumber === null &&
    !git?.changedFiles &&
    !git?.ahead
  return untouched ? 'undo' : 'confirm'
}
