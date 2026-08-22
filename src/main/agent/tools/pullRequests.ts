import {
  annotatePrCandidates,
  getBaseRepoWritable,
  getViewerLogin,
  listOpenPrCandidates
} from '../../github'
import { getStore } from '../../store'
import type { AgentToolHandler } from './registry'

/** 생성 전에 push 가능 여부까지 판단해야 에이전트가 실패할 후보를 고르지 않는다. */
export const listPullRequests: AgentToolHandler = async (_deps, workspaceId, args) => {
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
  const [candidates, viewerLogin, baseRepoWritable] = await Promise.all([
    listOpenPrCandidates(repo.path),
    getViewerLogin(repo.path),
    getBaseRepoWritable(repo.path)
  ])
  return annotatePrCandidates(candidates, viewerLogin, baseRepoWritable).slice(0, limit)
}
