import type { PermissionRequest } from '@shared/types'

/**
 * AskUserQuestion(과 codex 의 `tool/requestUserInput`) 프롬프트의 **순수 로직**.
 *
 * AskUserQuestion 은 행위 승인이 아니라 모델이 사용자에게 답을 요청하는 도구다. Allow/Deny 로
 * 받으면 answers 가 빈 채로 넘어가 모델이 "사용자가 답하지 않았다" 고 보고 그냥 진행한다 —
 * 그래서 폰도 데스크톱 QuestionPrompt 와 **같은 규약**으로 답을 만들어 돌려줘야 한다:
 * `updatedInput.answers[질문문] = 고른 라벨(복수 선택은 ", " 로 연결)`.
 *
 * 화면과 갈라 둔 이유는 이 규약이 랩탑 쪽 파서와 맞아야 하는 계약이라서다. 어긋나면 증상이
 * "모델이 답을 못 받았다" 하나뿐이라 화면만 보고는 어긋난 지점을 짚을 수 없다.
 */

export interface QuestionOption {
  label: string
  description?: string
}

export interface Question {
  question: string
  header?: string
  options: QuestionOption[]
  multiSelect?: boolean
}

/**
 * 사용자가 직접 적은 "Other" 를 선택 배열 안에서 가리키는 sentinel. Other 는 모델이 준
 * 옵션이 아니라 항상 제공되는 자유 입력이라, 실제 라벨과 한 배열에 섞여도 부딪히지 않도록
 * 라벨로는 나올 수 없는 값을 쓴다(데스크톱 QuestionPrompt 와 같은 방식).
 */
export const OTHER = '__wooi_other__'

/** 질문 인덱스별로 고른 라벨 목록. 옵션 라벨 또는 OTHER sentinel 이 들어간다. */
export type Selection = Record<number, string[]>

/** 질문 인덱스별 Other 자유 입력 텍스트. */
export type OtherText = Record<number, string>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 도구 입력에서 질문 목록을 꺼낸다. 릴레이를 건너온 값이라 모양을 믿지 않는다 —
 * 읽을 수 없는 항목은 버리고, 하나도 남지 않으면 빈 배열이다(호출자는 일반 승인 카드로 되돌린다).
 */
export function parseQuestions(input: Record<string, unknown>): Question[] {
  const raw = input.questions
  if (!Array.isArray(raw)) return []
  const questions: Question[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const question = typeof entry.question === 'string' ? entry.question.trim() : ''
    if (question.length === 0) continue
    const options: QuestionOption[] = []
    if (Array.isArray(entry.options)) {
      for (const option of entry.options) {
        if (!isRecord(option)) continue
        const label = typeof option.label === 'string' ? option.label : ''
        if (label.length === 0) continue
        options.push({
          label,
          description: typeof option.description === 'string' ? option.description : undefined
        })
      }
    }
    questions.push({
      question,
      header: typeof entry.header === 'string' && entry.header.length > 0 ? entry.header : undefined,
      options,
      multiSelect: entry.multiSelect === true
    })
  }
  return questions
}

/**
 * 이 요청을 질문 UI 로 그려야 하는지.
 *
 * `kind === 'question'` 이 아니라 **도구 이름**으로 가른다. 답을 실어 보내는 통로인
 * `updatedInput` 은 랩탑 allowlist 가 AskUserQuestion 에만 열어 두기 때문이다
 * ([[main/remote/allowlist]]) — codex 의 McpElicitation 도 kind 는 'question' 이지만
 * 답을 보내면 거절당하므로 여기서 질문 UI 를 주면 안 된다. 데스크톱 ChatView 의 분기와도 같다.
 */
export function isQuestionRequest(request: PermissionRequest): boolean {
  return request.toolName === 'AskUserQuestion' && parseQuestions(request.input).length > 0
}

/** 옵션 하나를 켜고 끈다. 단일 선택이면 켜기만 하고 기존 선택을 대체한다(라디오와 같다). */
export function applyToggle(
  prev: Selection,
  qi: number,
  value: string,
  multi: boolean
): Selection {
  const current = prev[qi] ?? []
  if (!multi) return { ...prev, [qi]: [value] }
  return {
    ...prev,
    [qi]: current.includes(value)
      ? current.filter((item) => item !== value)
      : [...current, value]
  }
}

/** Other 자유 입력이 바뀌었을 때의 선택 상태. 비우면 Other 선택도 함께 풀린다. */
export function applyOther(
  prev: Selection,
  qi: number,
  text: string,
  multi: boolean
): Selection {
  const current = prev[qi] ?? []
  const has = current.includes(OTHER)
  if (text.trim().length > 0 && !has) {
    return { ...prev, [qi]: multi ? [...current, OTHER] : [OTHER] }
  }
  if (text.trim().length === 0 && has) {
    return { ...prev, [qi]: current.filter((item) => item !== OTHER) }
  }
  return prev
}

/** 한 질문의 최종 답 문자열. 고른 라벨(Other 는 입력 텍스트)을 ", " 로 잇는다. */
export function answerFor(selection: Selection, other: OtherText, qi: number): string {
  return (selection[qi] ?? [])
    .map((value) => (value === OTHER ? (other[qi] ?? '').trim() : value))
    .filter((value) => value.length > 0)
    .join(', ')
}

export function isAnswered(selection: Selection, other: OtherText, qi: number): boolean {
  return answerFor(selection, other, qi).length > 0
}

/** 모든 질문에 답했는지. 빈 답으로 보내면 모델이 그냥 진행하므로 제출 조건이다. */
export function allAnswered(
  questions: Question[],
  selection: Selection,
  other: OtherText
): boolean {
  return questions.length > 0 && questions.every((_, qi) => isAnswered(selection, other, qi))
}

/** 도구가 기대하는 answers 맵(질문문 → 답). */
export function buildAnswers(
  questions: Question[],
  selection: Selection,
  other: OtherText
): Record<string, string> {
  const answers: Record<string, string> = {}
  questions.forEach((question, qi) => {
    answers[question.question] = answerFor(selection, other, qi)
  })
  return answers
}
