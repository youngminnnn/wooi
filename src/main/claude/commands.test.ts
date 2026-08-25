import { describe, expect, it } from 'vitest'
import type { SlashCommandInfo } from '@shared/types'
import { mergeCommands } from './commands'

describe('mergeCommands', () => {
  it('/agents 중복에서 Wooi 설명을 우선한다', () => {
    const commands = mergeCommands([
      {
        name: 'agents',
        description: '(removed) Ask Claude to create/manage subagents, or edit .claude/agents/'
      }
    ])
    const agents = commands.filter((command) => command.name === 'agents')

    expect(agents).toHaveLength(1)
    expect(agents[0]?.description).toBe('List subagents available to this session')
    expect(agents[0]?.description).not.toContain('(removed)')
  })

  it('중복 이름의 Wooi argumentHint 와 aliases 를 통째로 우선한다', () => {
    const commands = mergeCommands([
      { name: 'compact', description: 'SDK compact', aliases: ['sdk-compact'] }
    ])
    const compact = commands.find((command) => command.name === 'compact')

    expect(compact?.argumentHint).toBe('[instructions]')
    expect(compact?.aliases).toBeUndefined()
  })

  it('SDK 에만 있는 명령은 변경하지 않는다', () => {
    const humanize: SlashCommandInfo = {
      name: 'humanize',
      description: 'Make Korean prose natural',
      argumentHint: '<text>',
      aliases: ['naturalize']
    }

    expect(mergeCommands([humanize])).toContainEqual(humanize)
  })

  it('결과에 중복 이름이 없다', () => {
    const commands = mergeCommands([
      { name: 'compact', description: 'SDK compact' },
      { name: 'humanize', description: 'Make Korean prose natural' },
      { name: 'humanize', description: 'Duplicate SDK command' }
    ])
    const names = commands.map((command) => command.name)

    expect(new Set(names).size).toBe(names.length)
  })
})
