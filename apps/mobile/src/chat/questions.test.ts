import { describe, expect, it } from 'vitest'
import type { PermissionRequest } from '@shared/types'
import {
  OTHER,
  allAnswered,
  applyOther,
  applyToggle,
  buildAnswers,
  isQuestionRequest,
  parseQuestions,
  questionWorkspaceIds
} from './questions'

const request = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  requestId: 'r1',
  workspaceId: 'w1',
  toolName: 'AskUserQuestion',
  input: {
    questions: [
      {
        question: 'Which database?',
        header: 'Database',
        options: [
          { label: 'Postgres', description: 'Relational' },
          { label: 'SQLite', description: 'Embedded' }
        ]
      }
    ]
  },
  ...over
})

describe('isQuestionRequest', () => {
  it('AskUserQuestion 이면 질문 UI 로 보낸다', () => {
    expect(isQuestionRequest(request())).toBe(true)
  })

  // 답을 싣는 updatedInput 은 랩탑 allowlist 가 AskUserQuestion 에만 열어 둔다. kind 로 가르면
  // codex 의 McpElicitation(kind: 'question')까지 질문 UI 가 잡고, 답은 거절당한다.
  it('kind 가 question 이어도 다른 도구면 승인 카드로 남긴다', () => {
    const elicitation = request({ toolName: 'McpElicitation', kind: 'question' })
    expect(isQuestionRequest(elicitation)).toBe(false)
  })

  it('질문을 읽을 수 없으면 승인 카드로 되돌린다', () => {
    expect(isQuestionRequest(request({ input: { questions: 'nope' } }))).toBe(false)
    expect(isQuestionRequest(request({ input: {} }))).toBe(false)
    expect(isQuestionRequest(request({ input: { questions: [{ options: [] }] } }))).toBe(false)
  })
})

describe('questionWorkspaceIds', () => {
  it('질문을 기다리는 워크스페이스만 모은다', () => {
    const ids = questionWorkspaceIds([
      request(),
      request({ requestId: 'r2', workspaceId: 'w2', toolName: 'Bash', input: { command: 'ls' } })
    ])
    expect([...ids]).toEqual(['w1'])
  })

  // 와이어에서는 `unknown[]` 라(shared/remote) 모양을 믿을 수 없다. 구형 랩탑이 필드를 아예
  // 보내지 않는 경우(undefined)까지 여기서 흡수한다 — 목록이 죽으면 안 되는 자리다.
  it('읽을 수 없는 항목과 빈 목록을 흡수한다', () => {
    expect(questionWorkspaceIds(undefined).size).toBe(0)
    expect(questionWorkspaceIds([null, 'nope', { requestId: 'r1' }]).size).toBe(0)
  })
})

describe('parseQuestions', () => {
  it('릴레이를 건너온 망가진 항목은 버리고 읽을 수 있는 것만 남긴다', () => {
    const questions = parseQuestions({
      questions: [
        null,
        { question: '   ' },
        {
          question: 'Pick',
          options: [{ label: 'A' }, { description: 'no label' }, 'nope'],
          multiSelect: true
        }
      ]
    })
    expect(questions).toEqual([
      {
        question: 'Pick',
        header: undefined,
        options: [{ label: 'A', description: undefined }],
        multiSelect: true
      }
    ])
  })
})

describe('선택 상태', () => {
  it('단일 선택은 기존 답을 대체하고 복수 선택은 토글한다', () => {
    expect(applyToggle({ 0: ['A'] }, 0, 'B', false)).toEqual({ 0: ['B'] })
    expect(applyToggle({ 0: ['A'] }, 0, 'B', true)).toEqual({ 0: ['A', 'B'] })
    expect(applyToggle({ 0: ['A', 'B'] }, 0, 'A', true)).toEqual({ 0: ['B'] })
  })

  it('Other 는 입력이 있을 때만 선택되고 비우면 풀린다', () => {
    expect(applyOther({}, 0, 'Redis', false)).toEqual({ 0: [OTHER] })
    expect(applyOther({ 0: ['A'] }, 0, 'Redis', true)).toEqual({ 0: ['A', OTHER] })
    expect(applyOther({ 0: [OTHER] }, 0, '  ', false)).toEqual({ 0: [] })
  })
})

describe('buildAnswers', () => {
  const questions = parseQuestions({
    questions: [
      {
        question: 'Which database?',
        options: [{ label: 'Postgres' }, { label: 'SQLite' }],
        multiSelect: true
      },
      { question: 'Deploy now?', options: [{ label: 'Yes' }, { label: 'No' }] }
    ]
  })

  // 랩탑(그리고 codex 의 answersFor)이 읽는 계약이다 — 질문문이 키, 복수 선택은 ", " 로 잇는다.
  it('질문문을 키로, 복수 선택은 쉼표로 이어 답을 만든다', () => {
    const selection = { 0: ['Postgres', 'SQLite'], 1: ['Yes'] }
    expect(buildAnswers(questions, selection, {})).toEqual({
      'Which database?': 'Postgres, SQLite',
      'Deploy now?': 'Yes'
    })
  })

  it('Other 는 sentinel 대신 사용자가 적은 글을 싣는다', () => {
    const selection = { 0: ['Postgres', OTHER], 1: [OTHER] }
    expect(buildAnswers(questions, selection, { 0: ' Redis ', 1: 'Later' })).toEqual({
      'Which database?': 'Postgres, Redis',
      'Deploy now?': 'Later'
    })
  })

  // 빈 답으로 넘기면 모델이 "사용자가 답하지 않았다" 고 보고 그대로 진행한다.
  it('한 질문이라도 비면 제출할 수 없다', () => {
    expect(allAnswered(questions, { 0: ['Postgres'] }, {})).toBe(false)
    expect(allAnswered(questions, { 0: ['Postgres'], 1: [OTHER] }, { 1: '   ' })).toBe(false)
    expect(allAnswered(questions, { 0: ['Postgres'], 1: ['No'] }, {})).toBe(true)
    expect(allAnswered([], {}, {})).toBe(false)
  })
})
