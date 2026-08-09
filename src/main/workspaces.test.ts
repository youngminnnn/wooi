import { describe, expect, it } from 'vitest'
import { resolveWorkspaceAgentBackend } from './workspaces'

describe('resolveWorkspaceAgentBackend', () => {
  it('명시한 agent 가 부모보다 우선한다', () => {
    expect(resolveWorkspaceAgentBackend('codex', { agentBackend: 'claude' }, 'claude')).toBe(
      'codex'
    )
  })

  it('stacked workspace 는 agent 미지정 시 부모를 상속한다', () => {
    expect(resolveWorkspaceAgentBackend(undefined, { agentBackend: 'codex' }, 'claude')).toBe(
      'codex'
    )
  })

  it('스택 뿌리는 agent 미지정 시 전역 기본값을 쓴다', () => {
    expect(resolveWorkspaceAgentBackend(undefined, null, 'codex')).toBe('codex')
  })

  it('전역 기본값도 없으면 제품 기본값을 쓴다', () => {
    expect(resolveWorkspaceAgentBackend(undefined, null, undefined)).toBe('claude')
  })
})
