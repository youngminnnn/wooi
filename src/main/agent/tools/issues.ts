import { listOpenIssues } from '../../github'
import { getStore } from '../../store'
import type { AgentToolHandler } from './registry'

/** 현재 워크스페이스와 같은 리포의 열린 이슈를 고르기 위한 가벼운 목록. */
export const listIssues: AgentToolHandler = async (_deps, workspaceId, args) => {
  const state = getStore().getState()
  const workspace = state.workspaces.find((item) => item.id === workspaceId)
  if (!workspace) throw new Error('This workspace no longer exists.')
  const repo = state.repos.find((item) => item.id === workspace.repoId)
  if (!repo) throw new Error('This repository no longer exists.')

  const rawLimit = args.limit
  if (rawLimit !== undefined && (!Number.isInteger(rawLimit) || (rawLimit as number) < 1)) {
    throw new Error('The limit must be a positive integer.')
  }
  const limit = Math.min((rawLimit as number | undefined) ?? 30, 100)
  return (await listOpenIssues(repo.path)).slice(0, limit)
}
