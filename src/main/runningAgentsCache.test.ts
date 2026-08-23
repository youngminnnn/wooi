import { beforeEach, describe, expect, it } from 'vitest'
import type { RunningAgent } from '@shared/types'
import {
  backgroundShellCount,
  forgetRunningAgents,
  rememberRunningAgents
} from './runningAgentsCache'

function agent(taskId: string, taskType?: string): RunningAgent {
  return {
    taskId,
    ...(taskType === undefined ? {} : { taskType }),
    agentType: taskType === undefined ? 'Explore' : 'background',
    description: 'working',
    startedAt: 1
  }
}

beforeEach(() => forgetRunningAgents('ws-1'))

describe('runningAgentsCache', () => {
  it('taskType 이 있는 백그라운드 셸만 센다', () => {
    rememberRunningAgents('ws-1', [
      agent('subagent'),
      agent('shell-1', 'bash'),
      agent('shell-2', '')
    ])
    expect(backgroundShellCount('ws-1')).toBe(2)
  })

  it('REPLACE 이벤트의 빈 목록과 세션 초기화가 값을 지운다', () => {
    rememberRunningAgents('ws-1', [agent('shell-1', 'bash')])
    rememberRunningAgents('ws-1', [])
    expect(backgroundShellCount('ws-1')).toBe(0)

    rememberRunningAgents('ws-1', [agent('shell-2', 'bash')])
    forgetRunningAgents('ws-1')
    expect(backgroundShellCount('ws-1')).toBe(0)
  })
})
