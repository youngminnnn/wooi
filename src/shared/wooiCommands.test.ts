import { describe, expect, it } from 'vitest'
import { AGENT_TOOLS } from '../main/agent/tools/catalog'
import {
  expandWooiCommand,
  matchWooiCommand,
  parseWooiCommandArgs,
  wooiCommandName,
  WOOI_COMMANDS
} from './wooiCommands'

describe('catalog', () => {
  it('covers every Wooi tool exactly once', () => {
    // 커맨드는 도구의 사람 쪽 입구다. 도구가 늘었는데 커맨드를 잊으면 이 테스트가 잡는다.
    expect(WOOI_COMMANDS.map((c) => c.tool).sort()).toEqual(AGENT_TOOLS.map((t) => t.name).sort())
  })

  it('has unique command names', () => {
    expect(new Set(WOOI_COMMANDS.map((c) => c.name)).size).toBe(WOOI_COMMANDS.length)
  })

  it('leaves a $ARGUMENTS slot in every prompt that takes arguments', () => {
    for (const spec of WOOI_COMMANDS.filter((c) => c.argumentHint)) {
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
