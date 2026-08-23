import { stackedWaits } from '../../stackedWait'
import type { AgentToolHandler } from './registry'

/** 등록만 동기로 끝낸다. 조건을 기다리는 일은 메인 코디네이터의 틱이 맡는다. */
export const awaitStackedWork: AgentToolHandler = async (_deps, workspaceId, args) =>
  stackedWaits.register(workspaceId, {
    workspaceIds: Array.isArray(args.workspaceIds)
      ? args.workspaceIds.filter((id): id is string => typeof id === 'string')
      : undefined,
    until: args.until === 'any-reported' ? 'any-reported' : 'all-reported',
    timeoutMinutes: typeof args.timeoutMinutes === 'number' ? args.timeoutMinutes : undefined
  })
