import { randomBytes, randomUUID } from 'node:crypto'
import type { PeerMessageOutcome, SentPeerMessage } from '@shared/types'
import { getStore } from '../../store'

/**
 * 세션은 앱 재시작 뒤에도 이어지므로 발신자가 며칠 뒤 결말을 물을 수 있다. 본문 없이 작은
 * 항목만 남기므로 7일 × 워크스페이스당 50건은 기존 저장 상태에 비해 무시할 만한 크기다.
 */
const MAX_PEER_SENT_LOG = 50
const PEER_SENT_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** 프로세스 메모리에만 있던 대기를 재시작 뒤 사실처럼 답하지 않기 위한 실행 표식. */
const PEER_RUN_ID = randomUUID()

const TERMINAL_OUTCOMES = new Set<PeerMessageOutcome>([
  'delivered',
  'delivered-after-user-approval',
  'declined-by-user',
  'dropped-target-inbox-full',
  'dropped-target-workspace-gone',
  'not-delivered-duplicate'
])

export function newPeerMessageId(): string {
  return `pm-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

export function peerMessageIdSentAt(id: string): number | null {
  const match = /^pm-([0-9a-z]+)-[0-9a-f]{8}$/.exec(id)
  if (!match) return null
  const at = Number.parseInt(match[1], 36)
  return Number.isSafeInteger(at) && at >= 0 ? at : null
}

function pruned(entries: SentPeerMessage[] | undefined, now = Date.now()): SentPeerMessage[] {
  return (entries ?? [])
    .filter((entry) => now - entry.at <= PEER_SENT_TTL_MS)
    .sort((a, b) => a.at - b.at)
    .slice(-MAX_PEER_SENT_LOG)
}

function pruneWorkspace(fromWorkspaceId: string): SentPeerMessage[] {
  let result: SentPeerMessage[] = []
  getStore().update((st) => {
    const from = st.workspaces.find((w) => w.id === fromWorkspaceId)
    if (!from) return
    result = pruned(from.peerSent)
    from.peerSent = result
  })
  return result
}

export function recordPeerSend(
  fromWorkspaceId: string | null,
  entry: Omit<SentPeerMessage, 'runId'>
): void {
  if (fromWorkspaceId === null) return
  getStore().update((st) => {
    const from = st.workspaces.find((w) => w.id === fromWorkspaceId)
    if (!from) return
    const recorded: SentPeerMessage = {
      ...entry,
      ...(entry.outcome === 'waiting-for-target-turn-to-end' ? { runId: PEER_RUN_ID } : {})
    }
    from.peerSent = pruned([...(from.peerSent ?? []), recorded], entry.outcomeAt)
  })
}

export function resolvePeerMessage(
  fromWorkspaceId: string | null,
  messageId: string,
  outcome: PeerMessageOutcome
): void {
  if (fromWorkspaceId === null) return
  getStore().update((st) => {
    const from = st.workspaces.find((w) => w.id === fromWorkspaceId)
    if (!from) return
    from.peerSent = pruned(from.peerSent)
    const entry = from.peerSent.find((item) => item.id === messageId)
    if (!entry || TERMINAL_OUTCOMES.has(entry.outcome)) return
    entry.outcome = outcome
    entry.outcomeAt = Date.now()
    entry.runId = outcome === 'waiting-for-target-turn-to-end' ? PEER_RUN_ID : undefined
  })
}

export function lookupPeerMessage(
  fromWorkspaceId: string,
  messageId: string
): { entry: SentPeerMessage | null; cutoff: number; lostAfterRestart: boolean } {
  const entries = pruneWorkspace(fromWorkspaceId)
  const entry = entries.find((item) => item.id === messageId) ?? null
  const cutoff = entries[0]?.at ?? Date.now() - PEER_SENT_TTL_MS
  return {
    entry,
    cutoff,
    lostAfterRestart:
      entry?.outcome === 'waiting-for-target-turn-to-end' && entry.runId !== PEER_RUN_ID
  }
}

export function recentPeerMessages(fromWorkspaceId: string, limit: number): SentPeerMessage[] {
  return pruneWorkspace(fromWorkspaceId).slice(-Math.max(0, limit)).reverse()
}
