import type { RequestPermissionRequest, SessionUpdate } from '@agentclientprotocol/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { detectCopilot } from '../copilot/executable'
import {
  activityFromAcpUpdate,
  decideAcpPermission,
  resultFromAcpStop,
  runAcpSubAgent
} from './runAcp'

vi.mock('../copilot/executable', () => ({ detectCopilot: vi.fn() }))

const permission = (kind: 'read' | 'edit'): RequestPermissionRequest =>
  ({
    sessionId: 's1',
    toolCall: {
      toolCallId: 't1',
      name: 'replace_file',
      title: 'Replace file',
      kind,
      rawInput: { path: 'src/a.ts' }
    },
    options: [
      { optionId: 'always', name: 'Always', kind: 'allow_always' },
      { optionId: 'once', name: 'Once', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
    ]
  }) as RequestPermissionRequest

describe('Copilot ACP 매핑', () => {
  beforeEach(() => vi.mocked(detectCopilot).mockReset())

  it('도구 이름을 활동으로 옮기고, 메시지 청크는 활동으로 올리지 않는다', () => {
    // 청크는 토큰 단위라 그대로 올리면 사이드바를 청크마다 다시 방송하게 된다 — 모았다가
    // 도구 호출 경계에서 호출부가 한 줄로 내보낸다(runAcp.ts).
    const textUpdate = {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello ' }
    } as SessionUpdate
    const toolUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      name: 'read_file',
      title: 'Read file',
      kind: 'read',
      rawInput: { path: 'src/a.ts' }
    } as SessionUpdate
    expect(activityFromAcpUpdate(textUpdate)).toBeNull()
    expect(activityFromAcpUpdate(toolUpdate)).toMatchObject({ kind: 'tool', toolName: 'read_file' })
  })

  // 실측: Copilot 은 name 없이 title 만, 때로는 kind 만 보낸다. 'other' 를 그대로 쓰면
  // 사이드바에 "other" 라는 줄이 뜬다.
  it('name 이 없으면 title 로, 둘 다 없으면 사람이 읽는 이름으로 떨어진다', () => {
    const titled = {
      sessionUpdate: 'tool_call',
      toolCallId: 't2',
      title: 'Create file',
      kind: 'edit'
    } as SessionUpdate
    const bare = { sessionUpdate: 'tool_call', toolCallId: 't3', kind: 'other' } as SessionUpdate
    expect(activityFromAcpUpdate(titled)).toMatchObject({ toolName: 'Create file' })
    expect(activityFromAcpUpdate(bare)?.toolName).toBe('GitHub Copilot CLI tool')
  })

  it('승인을 canUseTool 에 묻고 allow_once 옵션을 우선한다', async () => {
    const canUseTool = vi.fn(async (_name, input) => ({
      behavior: 'allow' as const,
      updatedInput: input
    }))
    await expect(
      decideAcpPermission({ permissionMode: 'default', canUseTool }, permission('read'))
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
    expect(canUseTool).toHaveBeenCalledWith(
      'replace_file',
      { path: 'src/a.ts' },
      { title: 'Replace file' }
    )
  })

  it('readOnly 의 쓰기 요청은 사용자에게 묻지 않고 거절한다', async () => {
    const canUseTool = vi.fn()
    await expect(
      decideAcpPermission({ permissionMode: 'readOnly', canUseTool }, permission('edit'))
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } })
    expect(canUseTool).not.toHaveBeenCalled()
  })

  it('중단 stop 은 모은 텍스트를 실패 없이 돌려준다', () => {
    expect(resultFromAcpStop('partial', 's1', 'cancelled', true)).toEqual({
      text: 'partial',
      sessionId: 's1',
      error: null
    })
  })

  it('CLI 가 없으면 빈 텍스트와 설치 안내를 돌려준다', async () => {
    vi.mocked(detectCopilot).mockResolvedValue({
      path: null,
      usable: false,
      reason: 'GitHub Copilot CLI is not installed. Install with npm.'
    })
    const result = await runAcpSubAgent({
      backend: 'copilot',
      cwd: '/tmp',
      repoPath: null,
      model: null,
      effort: null,
      permissionMode: 'default',
      prompt: 'work',
      abort: new AbortController(),
      onActivity: vi.fn()
    })
    expect(result.text).toBe('')
    expect(result.error).toMatch(/not installed/i)
  })

  // spawn 실패는 비동기 'error' 이벤트라 리스너가 없으면 메인 프로세스의 uncaught exception 이
  // 된다 — 도구 결과가 아니라 앱이 죽는다. detectCopilot 의 경로는 캐시된 값이라 그 사이 CLI 가
  // 지워질 수 있으므로 닿을 수 있는 경로다. 여기서 "에러 문장으로 끝난다"를 못 박는다.
  it('실행 파일이 사라졌으면 앱을 죽이지 않고 에러 문장으로 끝낸다', async () => {
    vi.mocked(detectCopilot).mockResolvedValue({
      path: '/definitely/not/here/copilot',
      usable: true
    })
    const result = await runAcpSubAgent({
      backend: 'copilot',
      cwd: '/tmp',
      repoPath: null,
      model: null,
      effort: null,
      permissionMode: 'default',
      prompt: 'work',
      abort: new AbortController(),
      onActivity: vi.fn()
    })
    expect(result.text).toBe('')
    expect(result.error).toBeTruthy()
  }, 15_000)
})
