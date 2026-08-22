import { describe, expect, it } from 'vitest'
import { delegateWooiCommands, expandWooiCommand } from '@shared/wooiCommands'
import { parseSubtaskCommand, subtaskPrompt, subtaskUnavailableReason } from './subtaskCommand'

describe('parseSubtaskCommand', () => {
  it('작업 인자를 읽는다', () => {
    expect(parseSubtaskCommand('/subtask fix the flaky login test')).toEqual({
      task: 'fix the flaky login test'
    })
  })

  it('빈 인자도 명령으로 구분한다', () => {
    expect(parseSubtaskCommand('/subtask')).toEqual({ task: '' })
    expect(parseSubtaskCommand('/subtask   ')).not.toBeNull()
    expect(parseSubtaskCommand('/subtask   ')).toEqual({ task: '' })
  })

  it('비슷한 명령과 문장 중간의 명령은 무시한다', () => {
    expect(parseSubtaskCommand('/subtasks x')).toBeNull()
    expect(parseSubtaskCommand('please /subtask x')).toBeNull()
  })

  it('여러 줄 작업을 보존한다', () => {
    expect(parseSubtaskCommand('/subtask do a\ndo b')?.task).toBe('do a\ndo b')
  })
})

describe('subtaskUnavailableReason', () => {
  it('팀에서 위임할 수 있으면 쓸 수 있다', () => {
    expect(subtaskUnavailableReason({ multiAgent: true, canDelegate: true })).toBeNull()
  })

  it('Solo 워크스페이스에는 팀 전환 방법을 안내한다', () => {
    expect(subtaskUnavailableReason({ multiAgent: false, canDelegate: true })).toContain(
      '/wooi:team'
    )
  })

  it('위임 불가 사유가 Solo 사유보다 우선한다', () => {
    expect(subtaskUnavailableReason({ multiAgent: false, canDelegate: false })).toBe(
      'This agent cannot run subagents, so /subtask is not available here.'
    )
  })
})

describe('subtaskPrompt', () => {
  it('Codex 위임 도구와 작업을 담고 치환 토큰을 남기지 않는다', () => {
    const prompt = subtaskPrompt('codex', 'ship it')
    expect(prompt).toContain('mcp__wooi__codex_subagent')
    expect(prompt).toContain('ship it')
    expect(prompt).not.toContain('$ARGUMENTS')
  })

  it('Claude 위임 도구를 담는다', () => {
    expect(subtaskPrompt('claude', 'ship it')).toContain('mcp__wooi__claude_subagent')
  })

  it('백엔드 고유 위임 명령과 동일한 프롬프트를 만든다', () => {
    expect(subtaskPrompt('codex', 'ship it')).toBe(
      expandWooiCommand(delegateWooiCommands(['codex'])[0], 'ship it')
    )
  })
})
