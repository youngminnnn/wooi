import type { PermissionRequest } from './types'
import { isQuestionPermission } from './types'

/**
 * 에이전트가 **지금 무엇을 묻고 있는지** 한 줄로 줄인다.
 *
 * 왜 있나: 워크스페이스 목록에서 승인 대기는 방패 아이콘 하나로만 보였다. 무엇을 묻는지 알려면
 * 워크스페이스를 열어야 했고, 여럿이 동시에 물으면 우선순위를 정하려고 전부 한 번씩 열어야 했다.
 * 한 줄만 보이면 "yes 만 치면 되는 것" 과 "앉아서 봐야 하는 설계 결정" 이 즉시 갈린다.
 *
 * 새 데이터를 만들지 않는다 — QuestionPrompt·PermissionPrompt·PlanPrompt 가 이미 렌더하는
 * 그 `PermissionRequest` 를 목록까지 흘려보내는 것이 전부다. 그래서 입력 대기일 때만 값이 있고,
 * 나머지 상태에서는 부를 일이 없다(호출하는 쪽이 pending 요청을 찾았을 때만 부른다).
 */

/** 한 줄 요약의 최대 길이(문자). 넘으면 잘리고 말줄임표가 붙는다. */
export const ASK_SUMMARY_MAX_LENGTH = 100

/** 잘렸음을 나타내는 표시. */
export const ASK_SUMMARY_ELLIPSIS = '…'

/**
 * 권한 요청 입력에서 사람이 읽을 텍스트를 찾을 때 훑는 키(우선순위 순).
 * 프롬프트 패널(`summarizePermission`)과 목록 요약이 같은 값을 집도록 한 곳에 둔다.
 */
export const PERMISSION_INPUT_TEXT_KEYS = [
  'command',
  'file_path',
  'path',
  'url',
  'pattern',
  'query',
  'description'
] as const

/**
 * 정규식을 돌리기 전에 원본을 이만큼만 잘라 본다. 계획(plan)은 수 KB 짜리 마크다운이고
 * 붙여넣기 한 명령은 더 길 수 있는데, 어차피 앞부분만 남길 것이라 전체를 훑을 이유가 없다.
 */
const SCAN_LIMIT = ASK_SUMMARY_MAX_LENGTH * 8 + 64

/** 마크다운 제목·목록·인용 표시. 계획의 첫 줄이 "## Plan" 이면 그 장식은 정보가 아니다. */
const LEADING_MARKDOWN = /^\s*(?:[#>]+|[-*+]|\d+[.)])\s*/

/**
 * 잘린 자리가 서로게이트 쌍 한가운데면 남은 반쪽이 깨진 글자로 보인다. 이모지·한자 확장 영역이
 * 여기 걸리므로 홀로 남은 상위 서로게이트는 버린다.
 */
function sliceKeepingSurrogates(value: string, max: number): string {
  const cut = value.slice(0, max)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

/** 여러 줄·연속 공백을 한 줄로 접고, 길면 잘라 말줄임표를 붙인다. */
export function clampToLine(value: string, max: number = ASK_SUMMARY_MAX_LENGTH): string {
  if (max <= 0) return ''
  const line = value.slice(0, SCAN_LIMIT).replace(/\s+/g, ' ').trim()
  if (line.length <= max) return line
  return sliceKeepingSurrogates(line, max).trimEnd() + ASK_SUMMARY_ELLIPSIS
}

/** 입력 객체에서 알려진 키를 우선순위대로 훑어 첫 문자열을 집는다. 없으면 빈 문자열. */
function inputText(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>
  for (const key of PERMISSION_INPUT_TEXT_KEYS) {
    const value = obj[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

/** 질문 요청에서 첫 질문 문장을 집는다(없으면 헤더). */
function questionText(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const questions = (input as Record<string, unknown>).questions
  if (!Array.isArray(questions) || questions.length === 0) return ''
  const first = questions[0]
  if (!first || typeof first !== 'object') return ''
  const { question, header } = first as Record<string, unknown>
  if (typeof question === 'string' && question.trim()) return question
  if (typeof header === 'string' && header.trim()) return header
  return ''
}

/** 계획에서 장식을 걷어낸 첫 줄을 집는다. */
function planText(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const plan = (input as Record<string, unknown>).plan
  if (typeof plan !== 'string') return ''
  for (const raw of plan.slice(0, SCAN_LIMIT).split('\n')) {
    const line = raw.replace(LEADING_MARKDOWN, '').trim()
    if (line) return line
  }
  return ''
}

/**
 * 입력 대기 중인 요청 하나를 목록에 띄울 한 줄로 줄인다.
 *
 * 갈림은 화면(ChatView)이 세 프롬프트 컴포넌트를 고르는 규칙과 같다 — 질문이면 질문 문장,
 * 계획이면 계획의 첫 줄, 나머지는 백엔드가 만들어 준 문장(`title`)을 쓰고 그것이 없을 때만
 * 도구 이름과 입력에서 만든다.
 */
export function askSummary(request: PermissionRequest): string {
  if (isQuestionPermission(request)) {
    return clampToLine(questionText(request.input) || request.title || 'Has a question for you')
  }
  if (request.kind === 'plan') {
    const plan = planText(request.input)
    return clampToLine(plan ? `Plan: ${plan}` : 'Wants to run a plan by you')
  }
  if (request.title) return clampToLine(request.title)
  const label = request.displayName ?? request.toolName
  const detail = inputText(request.input) || request.decisionReason || ''
  return clampToLine(detail ? `${label}: ${detail}` : label)
}
