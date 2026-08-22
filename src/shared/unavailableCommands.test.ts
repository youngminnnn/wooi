import { describe, expect, it } from 'vitest'
import {
  isHiddenSdkCommand,
  matchUnavailableCommand,
  RESERVED_COMMANDS,
  UNAVAILABLE_COMMANDS
} from './unavailableCommands'

describe('matchUnavailableCommand', () => {
  it('matches /theme with the Wooi settings guidance', () => {
    const command = matchUnavailableCommand('/theme')
    expect(command?.names).toContain('theme')
    expect(command?.message).toContain("Wooi's settings")
  })

  it('ignores arguments after the command', () => {
    expect(matchUnavailableCommand('/cd ~/other/dir')?.names).toContain('cd')
  })

  it('matches aliases to the same group', () => {
    expect(matchUnavailableCommand('/rc')).toBe(matchUnavailableCommand('/remote-control'))
  })

  it('matches aliases from cloud offload and background groups', () => {
    expect(matchUnavailableCommand('/tp')).toBe(matchUnavailableCommand('/teleport'))
    expect(matchUnavailableCommand('/bg')).toBe(matchUnavailableCommand('/background'))
  })

  it('ignores plain messages, available commands, and multiline prompts', () => {
    expect(matchUnavailableCommand('hello')).toBeNull()
    expect(matchUnavailableCommand('/compact')).toBeNull()
    expect(matchUnavailableCommand('hello\n/theme')).toBeNull()
  })

  it('matches names exactly rather than by prefix', () => {
    expect(matchUnavailableCommand('/themes')).toBeNull()
    expect(matchUnavailableCommand('/th')).toBeNull()
  })

  it('lets a known user-defined command with the same name pass through', () => {
    expect(matchUnavailableCommand('/focus', ['focus', 'compact'])).toBeNull()
  })

  it('keeps the gate enabled when only unrelated commands are known', () => {
    expect(matchUnavailableCommand('/focus', ['compact'])?.names).toContain('focus')
  })

  it('does not let known rescue a hidden name omitted from the filtered SDK list', () => {
    expect(matchUnavailableCommand('/color', ['compact'])?.names).toContain('color')
  })

  it('does not treat an empty known list as knowing every command', () => {
    expect(matchUnavailableCommand('/theme', [])?.names).toContain('theme')
  })

  it('checks the parsed command name against known names instead of the raw text', () => {
    expect(matchUnavailableCommand('/cd ~/other/dir', ['cd'])).toBeNull()
  })
})

describe('isHiddenSdkCommand', () => {
  it('recognizes only hidden SDK commands', () => {
    expect(isHiddenSdkCommand('color')).toBe(true)
    expect(isHiddenSdkCommand('compact')).toBe(false)
  })
})

describe('command list guards', () => {
  it('keeps commands under implementation in other workspaces out of both blocklists', () => {
    // 병렬 작업 중인 명령이 실수로 블록리스트에 들어가면 구현이 도착하기 전에 여기서 깨진다.
    for (const name of RESERVED_COMMANDS) {
      expect(isHiddenSdkCommand(name), name).toBe(false)
      expect(matchUnavailableCommand(`/${name}`), name).toBeNull()
    }
  })

  it('keeps unavailable command groups disjoint', () => {
    const names = UNAVAILABLE_COMMANDS.flatMap((command) => command.names)
    expect(new Set(names).size).toBe(names.length)
  })

  it('keeps names in both lists when hiding them still lets typed input leak through', () => {
    expect(isHiddenSdkCommand('color')).toBe(true)
    expect(matchUnavailableCommand('/color')?.names).toContain('color')
  })
})
