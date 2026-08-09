import { describe, expect, it, vi } from 'vitest'
import { resolveWorkspaceAgentBackend, runArchiveScript } from './workspaces'
import type { RunOnceResult } from './scripts'

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

/**
 * 아카이브 스크립트 실패는 아카이브를 멈추지 않는다 — 멈추면 worktree 만 남아 상태가 더
 * 나빠진다. 대신 실패를 **위로 올려야** 하고, 그 결과를 여기서 잃으면 사용자는 정리되지 않은
 * 컨테이너를 한참 뒤에나 발견한다.
 */
describe('runArchiveScript', () => {
  const scripts = (result: RunOnceResult): { runOnce: () => Promise<RunOnceResult> } => ({
    runOnce: vi.fn().mockResolvedValue(result)
  })

  it('성공하면 알릴 것이 없다', async () => {
    const deps = scripts({ code: 0, timedOut: false, output: 'done\n' })

    await expect(runArchiveScript(deps, 'docker compose down', '/tmp/wt')).resolves.toBeUndefined()
  })

  it('빈 명령은 아예 실행하지 않는다', async () => {
    const deps = scripts({ code: 0, timedOut: false, output: '' })

    await expect(runArchiveScript(deps, '   ', '/tmp/wt')).resolves.toBeUndefined()
    expect(deps.runOnce).not.toHaveBeenCalled()
  })

  it('실패하면 명령·코드·출력을 그대로 실어 올린다', async () => {
    const deps = scripts({ code: 1, timedOut: false, output: 'boom\n' })

    await expect(runArchiveScript(deps, 'exit 1', '/tmp/wt')).resolves.toEqual({
      command: 'exit 1',
      code: 1,
      timedOut: false,
      output: 'boom\n'
    })
  })

  // 타임아웃은 코드가 없어 "성공도 실패도 아닌" 모양이 된다 — 실패로 취급하지 않으면 조용히 샌다.
  it('타임아웃도 실패로 올린다', async () => {
    const deps = scripts({ code: null, timedOut: true, output: '' })

    await expect(runArchiveScript(deps, 'sleep 999', '/tmp/wt')).resolves.toMatchObject({
      code: null,
      timedOut: true
    })
  })
})
