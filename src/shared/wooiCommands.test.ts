import { describe, expect, it } from 'vitest'
import { agentToolsFor, AGENT_TOOLS } from '../main/agent/tools/catalog'
import { AGENT_BACKEND_IDS } from './types'
import {
  expandWooiCommand,
  matchWooiCommand,
  parseWooiCommandArgs,
  wooiCommandName,
  wooiCommandsFor,
  WOOI_COMMANDS
} from './wooiCommands'

describe('catalog', () => {
  it('covers every Wooi tool exactly once', () => {
    // 커맨드는 도구의 사람 쪽 입구다. 도구가 늘었는데 커맨드를 잊으면 이 테스트가 잡는다.
    expect(WOOI_COMMANDS.map((c) => c.tool).sort()).toEqual(AGENT_TOOLS.map((t) => t.name).sort())
  })

  it('covers the delegate tools too, and only in team mode', () => {
    // team 모드에서만 존재하는 도구다. 커맨드도 그때만 생겨야 한다 — 쓸 수 없는 명령이
    // 자동완성에 뜨면 사용자는 왜 안 되는지 알 길이 없다.
    expect(
      wooiCommandsFor()
        .map((c) => c.tool)
        .sort()
    ).toEqual(WOOI_COMMANDS.map((c) => c.tool).sort())
    expect(
      wooiCommandsFor(AGENT_BACKEND_IDS)
        .map((c) => c.tool)
        .sort()
    ).toEqual(
      agentToolsFor(AGENT_BACKEND_IDS)
        .map((t) => t.name)
        .sort()
    )
  })

  it('delegates through the agent, never directly', () => {
    // 서브에이전트는 빈 맥락으로 시작하므로 브리프를 모델이 써야 한다. direct 로 새면
    // 사용자가 친 한 줄만 받은 맥락 없는 서브에이전트가 된다.
    for (const spec of wooiCommandsFor(AGENT_BACKEND_IDS).filter(
      (c) => !WOOI_COMMANDS.includes(c)
    )) {
      expect(spec.mode, spec.name).toBe('agent')
    }
  })

  it('has unique command names', () => {
    expect(new Set(WOOI_COMMANDS.map((c) => c.name)).size).toBe(WOOI_COMMANDS.length)
  })

  it('leaves a $ARGUMENTS slot in every prompt that takes arguments', () => {
    for (const spec of wooiCommandsFor(AGENT_BACKEND_IDS).filter((c) => c.argumentHint)) {
      expect(spec.prompt, spec.name).toContain('$ARGUMENTS')
    }
  })
})

describe('matchWooiCommand', () => {
  it('splits the command from the rest', () => {
    expect(matchWooiCommand('/wooi:pr')).toMatchObject({ spec: { name: 'pr' }, rest: '' })
    expect(matchWooiCommand('/wooi:run  dev server ')).toMatchObject({
      spec: { name: 'run' },
      rest: 'dev server'
    })
  })

  it('matches delegate commands only when they are available', () => {
    expect(matchWooiCommand('/wooi:claude review auth')).toBeNull()
    expect(matchWooiCommand('/wooi:claude review auth', AGENT_BACKEND_IDS)).toMatchObject({
      spec: { name: 'claude', tool: 'claude_subagent' },
      rest: 'review auth'
    })
    expect(matchWooiCommand('/wooi:codex', ['codex'])).toMatchObject({ spec: { name: 'codex' } })
    expect(matchWooiCommand('/wooi:claude', ['codex'])).toBeNull()
  })

  it('ignores anything that is not one of ours', () => {
    expect(matchWooiCommand('/pr')).toBeNull()
    expect(matchWooiCommand('/wooi:nope')).toBeNull()
    // 접두사가 있어야 사용자의 개인 명령을 삼키지 않는다.
    expect(matchWooiCommand('/wooiprs')).toBeNull()
    expect(matchWooiCommand('tell me about /wooi:pr')).toBeNull()
  })

  it('names commands with the namespace', () => {
    expect(wooiCommandName(WOOI_COMMANDS[0])).toBe(`wooi:${WOOI_COMMANDS[0].name}`)
  })
})

describe('expandWooiCommand', () => {
  it('substitutes the user text', () => {
    const spec = WOOI_COMMANDS.find((c) => c.name === 'pr')!
    expect(expandWooiCommand(spec, 'as a draft')).toContain('as a draft')
    expect(expandWooiCommand(spec, '')).not.toContain('$ARGUMENTS')
  })
})

describe('parseWooiCommandArgs', () => {
  it('takes no arguments where the tool takes none', () => {
    expect(parseWooiCommandArgs('children', '')).toEqual({ args: {} })
    expect(parseWooiCommandArgs('peers', '')).toEqual({ args: {} })
  })

  it('splits paths for /wooi:related and omits them when empty', () => {
    expect(parseWooiCommandArgs('related', 'src/a.ts  src/b.ts')).toEqual({
      args: { paths: ['src/a.ts', 'src/b.ts'] }
    })
    expect(parseWooiCommandArgs('related', '')).toEqual({ args: {} })
  })

  it('splits child ids for /wooi:await and defaults to every child when empty', () => {
    expect(parseWooiCommandArgs('await', 'child-1 child-2')).toEqual({
      args: { workspaceIds: ['child-1', 'child-2'] }
    })
    expect(parseWooiCommandArgs('await', '')).toEqual({ args: {} })
  })

  it('validates the issue limit', () => {
    expect(parseWooiCommandArgs('issues', '5')).toEqual({ args: { limit: 5 } })
    expect(parseWooiCommandArgs('issues', '')).toEqual({ args: {} })
    expect(parseWooiCommandArgs('issues', '0')).toHaveProperty('error')
    expect(parseWooiCommandArgs('issues', '101')).toHaveProperty('error')
    expect(parseWooiCommandArgs('issues', 'many')).toHaveProperty('error')
  })

  it('requires a script name', () => {
    expect(parseWooiCommandArgs('run', 'dev')).toEqual({ args: { name: 'dev' } })
    expect(parseWooiCommandArgs('run', '')).toHaveProperty('error')
    expect(parseWooiCommandArgs('stop', '')).toHaveProperty('error')
  })

  it('reads a trailing line count for /wooi:logs, but keeps names that contain spaces', () => {
    expect(parseWooiCommandArgs('logs', 'dev 50')).toEqual({
      args: { name: 'dev', tailLines: 50 }
    })
    expect(parseWooiCommandArgs('logs', 'type check')).toEqual({ args: { name: 'type check' } })
    // 이름 자체가 숫자면 줄 수로 오인하지 않는다 — 조각이 하나뿐이면 전부 이름이다.
    expect(parseWooiCommandArgs('logs', '2')).toEqual({ args: { name: '2' } })
    expect(parseWooiCommandArgs('logs', '')).toHaveProperty('error')
  })

  it('requires a workspace id to archive', () => {
    expect(parseWooiCommandArgs('archive', 'ws_1')).toEqual({ args: { workspaceId: 'ws_1' } })
    expect(parseWooiCommandArgs('archive', '')).toHaveProperty('error')
  })

  it('refuses commands it does not own', () => {
    expect(parseWooiCommandArgs('pr', '')).toHaveProperty('error')
  })
})
