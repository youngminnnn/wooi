import type { ChatItem } from '@shared/types'

/**
 * 에이전트의 할 일(task) 목록을 대화 흐름 안의 체크리스트로 보여 주기 위한 재구성 로직.
 *
 * Claude Code CLI 는 할 일 목록을 도구 호출 행이 아니라 전용 체크리스트로 그린다. wooi 도
 * 같은 경험을 주려는 것인데, 이 SDK 버전(claude-agent-sdk 0.3.x / CLI 2.1.x)의 할 일 도구는
 * 목록 전체를 한 번에 받는 스냅샷형(TodoWrite)이 아니라, 한 항목씩 쌓아 올리는 증분형이다:
 *
 *   TaskCreate {subject, description, activeForm?}  → 항목 1개 추가(항상 pending)
 *   TaskUpdate {taskId, status?, subject?, …}       → 항목 1개 갱신(status:'deleted' 면 제거)
 *   TaskList / TaskGet                              → 읽기 전용 조회
 *
 * 게다가 새 항목의 ID 는 입력이 아니라 **결과 문자열**로만 돌아온다
 * ("Task #3 created successfully: …"). 따라서 한 항목만 봐서는 목록을 그릴 수 없고,
 * 트랜스크립트를 처음부터 되짚어(replay) 목록 상태를 누적해야 한다 — 이 모듈이 그 일을 한다.
 *
 * 되짚기는 이미 저장된 tool_use/tool_result 만 읽으므로 메인 프로세스·IPC·저장 포맷을 건드리지
 * 않는다. 덕분에 예전에 저장된 대화도 다시 열면 그대로 체크리스트로 보인다.
 */

/** 체크리스트에 그리는 항목 상태(도구가 정의하는 값 그대로). */
export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export interface TaskEntry {
  /** 도구가 부여한 번호("1", "2", …). 생성 결과가 아직/영영 안 온 항목은 빈 문자열. */
  id: string
  /** 명령형 제목(예: "Run tests"). */
  subject: string
  status: TaskStatus
  /** 진행 중일 때 보여 주는 현재진행형 라벨(예: "Running tests"). */
  activeForm?: string
}

/**
 * 목록 전체를 한 번에 주는 스냅샷형 도구.
 *
 * Claude 의 할 일 도구는 항목을 하나씩 쌓는 증분형이라 이 모듈이 트랜스크립트를 되짚어 목록을
 * 복원하지만, Codex 의 플랜(`turn/plan/updated`)은 매번 **전체 목록**을 준다. 그래서 매핑 계층이
 * 이 이름으로 실어 보내고(main 의 codex/mapping.ts), 여기서는 목록을 통째로 교체한다 —
 * 체크리스트 렌더러 자체는 두 백엔드가 그대로 공유한다.
 */
const SNAPSHOT_TOOLS = new Set(['TaskSnapshot'])

/** 목록을 바꾸는 도구. 이 중 하나라도 있어야 구간이 체크리스트로 승격된다. */
const MUTATING_TOOLS = new Set(['TaskCreate', 'TaskUpdate', ...SNAPSHOT_TOOLS])
/**
 * 목록을 읽기만 하는 도구. 체크리스트가 같은 정보를 더 잘 보여 주므로 구간에 섞여 있으면 함께
 * 감춘다. 구간을 끊지 않게 두는 것이 중요하다 — 도구 설명이 "TaskUpdate 전에 TaskGet 으로
 * 최신 상태를 읽으라"고 안내하므로 생성·갱신 사이에 자주 끼어든다.
 */
const READONLY_TOOLS = new Set(['TaskList', 'TaskGet'])

/**
 * 이름이 Task 로 시작하지만 할 일 목록과 무관한 도구들(백그라운드 에이전트 제어)을 쓸어 담지
 * 않도록, 관련 도구는 화이트리스트로만 판별한다.
 */
function isTaskListTool(name: string): boolean {
  return MUTATING_TOOLS.has(name) || READONLY_TOOLS.has(name)
}

/** 생성 결과 문자열에서 도구가 부여한 항목 번호를 뽑는다("Task #3 created successfully: …"). */
const CREATED_ID = /Task #(\d+)/

export interface TaskCards {
  /**
   * 체크리스트를 그릴 항목 id → 그 시점의 목록 스냅샷.
   * 목록을 바꾼 연속 구간마다 한 장씩, 구간의 마지막 항목 자리에 붙인다.
   */
  cardByItemId: Map<string, TaskEntry[]>
  /** 체크리스트로 대체되어 화면에서 감출 항목 id(도구 호출 행과 그 결과). */
  hiddenItemIds: Set<string>
}

const EMPTY_CARDS: TaskCards = { cardByItemId: new Map(), hiddenItemIds: new Set() }

/**
 * 트랜스크립트를 되짚어 체크리스트 카드들을 만든다.
 *
 * 할 일 도구가 연속으로 불린 구간을 하나로 묶어, 그 구간이 끝난 뒤의 목록 상태를 카드 한 장으로
 * 보여 준다 — TaskCreate 3번이면 카드 3장이 아니라 3줄짜리 카드 1장이다. 구간 안의 나머지
 * 도구 행과 결과("Task #1 created successfully…" 같은 모델용 확인 문구)는 감춘다.
 */
export function buildTaskCards(items: readonly ChatItem[]): TaskCards {
  // 대다수 대화에는 할 일 도구가 없다 — 그때는 Map/Set 을 새로 만들지 않고 상수를 재사용해,
  // 매 렌더마다 참조가 바뀌어 하위 memo 가 깨지는 일을 막는다.
  if (!items.some((it) => it.type === 'tool_use' && isTaskListTool(it.name))) return EMPTY_CARDS

  const cardByItemId = new Map<string, TaskEntry[]>()
  const hiddenItemIds = new Set<string>()

  /** 화면 순서를 유지하는 목록 본체. TaskEntry 는 갱신 시 제자리에서 고쳐 쓴다. */
  const order: TaskEntry[] = []
  const byId = new Map<string, TaskEntry>()
  /** 아직 결과(=번호)를 못 받은 TaskCreate. 도구 호출 id 로 결과와 짝짓는다. */
  const draftByToolId = new Map<string, TaskEntry>()
  /** 이 구간에 속한 tool_result 인지 판별하기 위한, 할 일 도구 호출 id 모음. */
  const taskToolIds = new Set<string>()

  // 현재 진행 중인 연속 구간.
  let runItemIds: string[] = []
  let runMutated = false

  const flushRun = (): void => {
    // 조회만 한 구간은 체크리스트로 승격하지 않는다 — 감추기만 하면 정보가 사라진다.
    if (runMutated && runItemIds.length > 0) {
      const anchor = runItemIds[runItemIds.length - 1]
      // 스냅샷은 깊은 복사다. 이후 구간에서 같은 TaskEntry 를 제자리 수정해도
      // 앞서 만든 카드가 따라 바뀌면 안 된다.
      cardByItemId.set(
        anchor,
        order.map((t) => ({ ...t }))
      )
      for (const id of runItemIds) if (id !== anchor) hiddenItemIds.add(id)
    }
    runItemIds = []
    runMutated = false
  }

  for (const item of items) {
    if (item.type === 'tool_use' && isTaskListTool(item.name)) {
      taskToolIds.add(item.toolId)
      runItemIds.push(item.id)
      if (SNAPSHOT_TOOLS.has(item.name)) {
        // 스냅샷은 목록을 통째로 대체한다. 증분형에서 쓰던 색인(번호 ↔ 항목)은 의미가 없어지므로
        // 함께 비운다 — 남겨 두면 이후 TaskUpdate 가 사라진 항목을 고치려 들 수 있다.
        const snapshot = tasksFromSnapshot(item.input)
        if (snapshot) {
          order.length = 0
          order.push(...snapshot)
          byId.clear()
          draftByToolId.clear()
          runMutated = true
        }
      } else if (item.name === 'TaskCreate') {
        // 번호는 결과로 와야 알 수 있지만, 카드는 지금 바로 보여 준다(실행 중 라이브 갱신).
        const draft = draftFromCreate(item.input)
        if (draft) {
          order.push(draft)
          draftByToolId.set(item.toolId, draft)
          runMutated = true
        }
      } else if (item.name === 'TaskUpdate') {
        if (applyUpdate(item.input, order, byId)) runMutated = true
      }
      continue
    }

    if (item.type === 'tool_result' && taskToolIds.has(item.toolId)) {
      runItemIds.push(item.id)
      const draft = draftByToolId.get(item.toolId)
      if (draft) {
        draftByToolId.delete(item.toolId)
        if (item.isError) {
          // 생성이 실패했으면 낙관적으로 넣어 둔 항목을 되돌린다.
          const idx = order.indexOf(draft)
          if (idx >= 0) order.splice(idx, 1)
        } else {
          const matched = CREATED_ID.exec(item.text)
          // 번호를 못 읽으면 항목은 남기되 색인하지 않는다 — 이후 갱신은 못 따라가지만,
          // 목록에서 통째로 사라지는 것보다는 낫다.
          if (matched) {
            draft.id = matched[1]
            byId.set(matched[1], draft)
          }
        }
      }
      continue
    }

    flushRun()
  }
  flushRun()

  return { cardByItemId, hiddenItemIds }
}

/** TaskCreate 입력에서 새 항목을 만든다(도구 규약상 항상 pending 으로 시작한다). */
/**
 * 스냅샷형 도구 입력을 목록으로 바꾼다. 모양이 어긋나면 null 을 돌려 이전 목록을 유지한다 —
 * 파싱 실패로 화면의 체크리스트가 통째로 사라지는 것보다 낫다.
 */
function tasksFromSnapshot(input: unknown): TaskEntry[] | null {
  if (!input || typeof input !== 'object') return null
  const { tasks } = input as Record<string, unknown>
  if (!Array.isArray(tasks)) return null

  const entries: TaskEntry[] = []
  for (const raw of tasks) {
    if (!raw || typeof raw !== 'object') continue
    const { subject, status } = raw as Record<string, unknown>
    if (typeof subject !== 'string' || !subject) continue
    entries.push({
      // 스냅샷에는 도구가 부여한 번호가 없다. 증분형 갱신의 대상이 되지 않으므로 빈 값으로 둔다.
      id: '',
      subject,
      status: status === 'in_progress' || status === 'completed' ? status : 'pending'
    })
  }
  return entries
}

function draftFromCreate(input: unknown): TaskEntry | null {
  if (!input || typeof input !== 'object') return null
  const { subject, activeForm } = input as Record<string, unknown>
  if (typeof subject !== 'string' || !subject) return null
  return {
    id: '',
    subject,
    status: 'pending',
    ...(typeof activeForm === 'string' && activeForm ? { activeForm } : {})
  }
}

/** TaskUpdate 입력을 목록에 반영한다. 실제로 뭔가 바뀌었으면 true. */
function applyUpdate(input: unknown, order: TaskEntry[], byId: Map<string, TaskEntry>): boolean {
  if (!input || typeof input !== 'object') return false
  const { taskId, status, subject, activeForm } = input as Record<string, unknown>
  if (typeof taskId !== 'string' && typeof taskId !== 'number') return false

  const target = byId.get(String(taskId))
  // 모르는 번호(생성 결과를 못 읽었거나 이미 지운 항목)면 조용히 무시한다.
  if (!target) return false

  if (status === 'deleted') {
    const idx = order.indexOf(target)
    if (idx >= 0) order.splice(idx, 1)
    byId.delete(String(taskId))
    return true
  }

  let changed = false
  if (status === 'pending' || status === 'in_progress' || status === 'completed') {
    target.status = status
    changed = true
  }
  if (typeof subject === 'string' && subject) {
    target.subject = subject
    changed = true
  }
  if (typeof activeForm === 'string' && activeForm) {
    target.activeForm = activeForm
    changed = true
  }
  return changed
}

/** 진행 중 항목은 현재진행형(activeForm) 라벨을, 나머지는 명령형 제목을 쓴다. */
export function taskLabel(task: TaskEntry): string {
  return task.status === 'in_progress' && task.activeForm ? task.activeForm : task.subject
}
