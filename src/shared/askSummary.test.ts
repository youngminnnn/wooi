import { describe, expect, it } from 'vitest'
import type { PermissionRequest } from './types'
import { ASK_SUMMARY_MAX_LENGTH, askSummary, clampToLine } from './askSummary'

const base: PermissionRequest = {
  requestId: 'r1',
  workspaceId: 'w1',
  toolName: 'Bash',
  input: {}
}

describe('clampToLine', () => {
  it('여러 줄을 한 줄로 접는다', () => {
    expect(clampToLine('first\n\n  second\tthird ')).toBe('first second third')
  })

  it('최대 길이를 넘으면 자르고 말줄임표를 붙인다', () => {
    const out = clampToLine('a'.repeat(200))
    expect(out).toBe('a'.repeat(ASK_SUMMARY_MAX_LENGTH) + '…')
    expect(out.length).toBe(ASK_SUMMARY_MAX_LENGTH + 1)
  })

  it('딱 최대 길이면 자르지 않는다', () => {
    const exact = 'b'.repeat(ASK_SUMMARY_MAX_LENGTH)
    expect(clampToLine(exact)).toBe(exact)
  })

  it('자른 자리의 공백은 말줄임표 앞에 남기지 않는다', () => {
    expect(clampToLine('ab cd', 3)).toBe('ab…')
  })

  it('서로게이트 쌍 한가운데서 자르지 않는다', () => {
    // '🙂' 는 UTF-16 두 칸이라 max=3 이면 두 번째 이모지의 앞쪽 반쪽에서 잘린다.
    const out = clampToLine('🙂🙂🙂', 3)
    expect(out).toBe('🙂…')
    expect(out).not.toContain('�')
  })

  it('최대 길이가 0 이하면 빈 문자열', () => {
    expect(clampToLine('anything', 0)).toBe('')
  })
})

describe('askSummary', () => {
  it('질문은 첫 질문 문장을 쓴다', () => {
    expect(
      askSummary({
        ...base,
        toolName: 'AskUserQuestion',
        input: { questions: [{ header: 'Auth', question: 'Which auth method should we use?' }] }
      })
    ).toBe('Which auth method should we use?')
  })

  it('질문 문장이 비면 헤더로 물러선다', () => {
    expect(
      askSummary({
        ...base,
        toolName: 'AskUserQuestion',
        input: { questions: [{ header: 'Library', question: '  ' }] }
      })
    ).toBe('Library')
  })

  it('질문 내용을 못 찾으면 일반 문구를 쓴다', () => {
    expect(askSummary({ ...base, toolName: 'AskUserQuestion', input: {} })).toBe(
      'Has a question for you'
    )
  })

  it('계획은 장식을 걷어낸 첫 줄을 쓴다', () => {
    expect(
      askSummary({
        ...base,
        toolName: 'ExitPlanMode',
        kind: 'plan',
        input: { plan: '\n## Plan\n\n- Rewrite the parser\n- Then the printer' }
      })
    ).toBe('Plan: Plan')
  })

  it('계획의 첫 줄이 목록이면 그 항목을 쓴다', () => {
    expect(
      askSummary({
        ...base,
        kind: 'plan',
        input: { plan: '1. Move the store to main\n2. Delete the old bridge' }
      })
    ).toBe('Plan: Move the store to main')
  })

  it('계획 본문이 없으면 일반 문구를 쓴다', () => {
    expect(askSummary({ ...base, kind: 'plan', input: {} })).toBe('Wants to run a plan by you')
  })

  it('권한은 백엔드가 만든 문장을 우선한다', () => {
    expect(
      askSummary({
        ...base,
        title: 'Claude wants to read src/main/index.ts',
        input: { file_path: 'src/main/index.ts' }
      })
    ).toBe('Claude wants to read src/main/index.ts')
  })

  it('문장이 없으면 도구 이름과 입력으로 만든다', () => {
    expect(
      askSummary({ ...base, displayName: 'Run command', input: { command: 'rm -rf build' } })
    ).toBe('Run command: rm -rf build')
  })

  it('표시 이름이 없으면 도구 이름을 쓴다', () => {
    expect(
      askSummary({ ...base, toolName: 'WebFetch', input: { url: 'https://example.com' } })
    ).toBe('WebFetch: https://example.com')
  })

  it('입력에서 집을 것이 없으면 결정 이유로 물러선다', () => {
    expect(
      askSummary({ ...base, toolName: 'Write', input: {}, decisionReason: 'Outside the worktree' })
    ).toBe('Write: Outside the worktree')
  })

  it('집을 것이 아무것도 없으면 도구 이름만 남는다', () => {
    expect(askSummary({ ...base, toolName: 'Write', input: {} })).toBe('Write')
  })

  it('긴 명령도 한 줄로 잘린다', () => {
    const out = askSummary({ ...base, input: { command: 'echo ' + 'x'.repeat(500) } })
    expect(out.length).toBe(ASK_SUMMARY_MAX_LENGTH + 1)
    expect(out).not.toContain('\n')
  })
})
