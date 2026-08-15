import type { RequestPermissionRequest, SessionUpdate } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'
import {
  commandsFrom,
  permissionRequestFrom,
  toolItemId,
  toolNameOf,
  toolOutputText,
  toolResultItem,
  toolUseItem,
  touchesWorkingTree,
  unknownUpdateName
} from './mapping'

/**
 * 페이로드는 전부 `copilot --acp --stdio` (CLI v1.0.80) 에서 실제로 받은 것이다 — 특히
 * "Copilot 은 `name` 을 안 보내고 `title` 만 보낸다", "편집 승인 요청의 diff 는 `rawInput.diff`
 * 에 git 통합 diff 로 온다" 두 가지는 실물을 보지 않으면 알 수 없다.
 */

const shellCall = {
  sessionUpdate: 'tool_call',
  toolCallId: 'toolu_015W',
  title: 'List files in current directory',
  kind: 'execute',
  status: 'pending',
  rawInput: { command: 'ls', description: 'List files in current directory' }
} as SessionUpdate

const editCall = {
  sessionUpdate: 'tool_call',
  toolCallId: 'toolu_01DC',
  title: 'Editing /tmp/acp-perm/a.txt',
  kind: 'edit',
  status: 'pending',
  content: [
    { type: 'diff', path: '/tmp/acp-perm/a.txt', oldText: 'helloZZZ', newText: 'helloYYY' }
  ],
  locations: [{ path: '/tmp/acp-perm/a.txt' }],
  rawInput: { path: '/tmp/acp-perm/a.txt', old_str: 'helloZZZ', new_str: 'helloYYY' }
} as SessionUpdate

const shellDone = {
  sessionUpdate: 'tool_call_update',
  toolCallId: 'toolu_015W',
  status: 'completed',
  kind: 'execute',
  content: [
    {
      type: 'content',
      content: { type: 'text', text: 'a.txt\nb.txt\n<shellId: 0 completed with exit code 0>' }
    }
  ],
  rawOutput: { content: 'a.txt\nb.txt\n<shellId: 0 completed with exit code 0>' }
} as SessionUpdate

describe('toolNameOf', () => {
  // 실측: Copilot 은 name 을 보내지 않는다. title 을 못 쓰면 사이드바에 'other' 가 그대로 뜬다.
  it('name 이 없으면 title 이 정본이다', () => {
    expect(toolNameOf({ title: 'Editing a.txt', kind: 'edit' })).toBe('Editing a.txt')
  })

  it('이름도 제목도 없으면 kind 로, kind 가 other 면 백엔드 이름으로 떨어진다', () => {
    expect(toolNameOf({ kind: 'read' })).toBe('read')
    expect(toolNameOf({ kind: 'other' })).toBe('GitHub Copilot CLI tool')
    expect(toolNameOf({})).toBe('GitHub Copilot CLI tool')
  })
})

describe('toolUseItem', () => {
  it('tool_call 을 tool_use 아이템으로 옮긴다', () => {
    const item = toolUseItem(shellCall as never, 1000)
    expect(item).toMatchObject({
      id: toolItemId('toolu_015W'),
      type: 'tool_use',
      toolId: 'toolu_015W',
      name: 'List files in current directory',
      input: { command: 'ls', description: 'List files in current directory' },
      ts: 1000
    })
  })

  // diff 는 실행 **전에만** 만들 수 있어 아이템에 함께 저장한다 — 대화를 다시 열어도 그때
  // 무엇이 바뀌었는지 보이게 하려는 것이다.
  it('편집 호출은 통합 diff 를 함께 싣는다', () => {
    const item = toolUseItem(editCall as never, 1000)
    const diff = (item as { diff?: string }).diff ?? ''
    expect(diff).toContain('/tmp/acp-perm/a.txt')
    expect(diff).toContain('-helloZZZ')
    expect(diff).toContain('+helloYYY')
  })

  it('편집이 아닌 호출에는 diff 를 붙이지 않는다', () => {
    expect(toolUseItem(shellCall as never, 1000)).not.toHaveProperty('diff')
  })
})

describe('toolResultItem', () => {
  it('아직 도는 중이면 결과를 만들지 않는다', () => {
    expect(toolResultItem({ ...shellCall, status: 'in_progress' } as never, 1)).toBeNull()
  })

  it('완료되면 출력과 함께 tool_result 를 만든다', () => {
    expect(toolResultItem(shellDone as never, 2000)).toMatchObject({
      type: 'tool_result',
      toolId: 'toolu_015W',
      isError: false,
      ts: 2000
    })
  })

  it('실패는 isError 로 구분한다', () => {
    const item = toolResultItem({ ...shellDone, status: 'failed' } as never, 1)
    expect(item).toMatchObject({ isError: true })
  })

  // 실측: 읽기 도구는 content 없이 rawOutput 만 보내는 호출이 있다.
  it('content 가 없으면 rawOutput.content 로 떨어진다', () => {
    expect(
      toolOutputText({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't',
        status: 'completed',
        rawOutput: { content: 'helloZZZ\n' }
      } as never)
    ).toBe('helloZZZ\n')
  })
})

describe('touchesWorkingTree', () => {
  it('파일을 바꿀 수 있는 도구만 Changes 패널을 깨운다', () => {
    expect(touchesWorkingTree('edit')).toBe(true)
    expect(touchesWorkingTree('execute')).toBe(true)
    expect(touchesWorkingTree('delete')).toBe(true)
    expect(touchesWorkingTree('read')).toBe(false)
    expect(touchesWorkingTree('search')).toBe(false)
  })
})

describe('permissionRequestFrom', () => {
  const options = [
    { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' as const },
    { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' as const },
    { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' as const }
  ]

  it('셸 실행은 command 카드로 그린다', () => {
    const params = {
      sessionId: 's',
      toolCall: {
        toolCallId: 'toolu_015W',
        kind: 'execute',
        status: 'pending',
        title: 'List files in current directory',
        rawInput: { command: 'ls', commands: ['ls'] }
      },
      options
    } as RequestPermissionRequest

    const request = permissionRequestFrom(params, 'req-1', 'ws-1')
    expect(request).toMatchObject({
      requestId: 'req-1',
      workspaceId: 'ws-1',
      kind: 'command',
      input: { command: 'ls', commands: ['ls'] }
    })
  })

  // 실측: 편집 승인 요청의 title 은 'Edit file' 처럼 일반적이고, 구체적인 이름은 앞서 온
  // tool_call 에만 있다. 그래서 세션이 toolCallId 로 짝지어 넘긴다.
  it('편집은 diff 를 싣고, 앞서 받은 이름이 있으면 그것을 쓴다', () => {
    const params = {
      sessionId: 's',
      toolCall: {
        toolCallId: 'toolu_01KS',
        kind: 'edit',
        status: 'pending',
        title: 'Edit file',
        locations: [{ path: '/tmp/acp-perm/a.txt' }],
        rawInput: {
          fileName: '/tmp/acp-perm/a.txt',
          diff: '\ndiff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n'
        }
      },
      options
    } as RequestPermissionRequest

    const request = permissionRequestFrom(params, 'req-2', 'ws-1', 'Editing /tmp/acp-perm/a.txt')
    expect(request.kind).toBe('fileChange')
    expect(request.diff).toContain('diff --git')
    expect(request.toolName).toBe('Editing /tmp/acp-perm/a.txt')
    expect(request.displayName).toBe('Edit file')
  })

  it('실측한 세 선택지를 그대로 옮기고, always 만 세션 기억으로 표시한다', () => {
    const params = {
      sessionId: 's',
      toolCall: { toolCallId: 't', kind: 'edit', status: 'pending', title: 'Edit file' },
      options
    } as RequestPermissionRequest

    expect(permissionRequestFrom(params, 'req-3', 'ws-1').options).toEqual([
      { id: 'allow_once', label: 'Allow once', behavior: 'allow' },
      {
        id: 'allow_always',
        label: 'Always allow',
        behavior: 'allow',
        rememberForSession: true,
        rememberScope: 'session'
      },
      { id: 'reject_once', label: 'Deny', behavior: 'deny' }
    ])
  })
})

describe('commandsFrom', () => {
  it('이름·설명·인자 힌트를 자동완성 모양으로 옮긴다', () => {
    expect(
      commandsFrom({
        availableCommands: [
          { name: 'add-dir', description: 'Add a directory', input: { hint: 'directory' } },
          { name: 'context', description: 'Show context window token usage' }
        ]
      } as never)
    ).toEqual([
      { name: 'add-dir', description: 'Add a directory', argumentHint: 'directory' },
      { name: 'context', description: 'Show context window token usage' }
    ])
  })
})

describe('unknownUpdateName', () => {
  it('우리가 소비하는 업데이트는 조용히 지나간다', () => {
    for (const kind of [
      'agent_message_chunk',
      'tool_call',
      'tool_call_update',
      'usage_update',
      'available_commands_update',
      'plan'
    ]) {
      expect(unknownUpdateName({ sessionUpdate: kind } as never)).toBeNull()
    }
  })

  // 매핑하지 못한 입력을 조용히 버리면 사용자는 대화에 구멍이 났다는 사실조차 모른다.
  it('처음 보는 종류는 이름을 붙여 카드로 알릴 수 있게 한다', () => {
    expect(unknownUpdateName({ sessionUpdate: 'brand_new_thing' } as never)).toBe(
      'session update "brand_new_thing"'
    )
  })
})
