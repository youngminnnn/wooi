import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { AgentBackendId, ReviewPrCandidate } from '@shared/types'
import { DEFAULT_AGENT_BACKEND } from '@shared/types'
import Modal, { ghostBtn, inputClass, labelClass, primaryBtn } from '../Modal'
import { useStore } from '../../store'
import { useAvailableBackends } from '../../lib/backends'
import { AgentBackendMark } from '../BrandIcons'
import { parsePrSelector } from '../../lib/review'

/** 마지막에 쓴 프롬프트를 기억해 둔다 — 대부분 같은 문장을 반복해서 쓴다. */
const PROMPT_KEY = 'wooi.reviewPrompt'
const DEFAULT_PROMPT = 'Review this PR.'

function readPrompt(): string {
  try {
    return localStorage.getItem(PROMPT_KEY) || DEFAULT_PROMPT
  } catch {
    return DEFAULT_PROMPT
  }
}

export default function PrReviewStartModal({
  onClose
}: {
  onClose: () => void
}): React.JSX.Element {
  const repos = useStore((s) => s.app?.repos ?? [])
  const defaultBackend = useStore(
    (s) => s.app?.settings.defaultAgentBackend ?? DEFAULT_AGENT_BACKEND
  )
  const startReview = useStore((s) => s.startReview)

  // 리뷰도 워크스페이스와 같은 규칙이다 — 시작할 때 고른 에이전트로 **끝까지** 돈다(후속 턴은
  // 그 세션을 resume 하므로). 기본값은 전역 기본 에이전트라 화면은 항상 하나가 선택된 채로 뜬다.
  const available = useAvailableBackends()
  const [agentBackend, setAgentBackend] = useState<AgentBackendId>(defaultBackend)
  // 기본 에이전트를 쓸 수 없으면(CLI 제거 등) 쓸 수 있는 것으로 대체한다.
  const effectiveBackend =
    available.some((b) => b.id === agentBackend) || available.length === 0
      ? agentBackend
      : available[0].id

  const [repoId, setRepoId] = useState(repos[0]?.id ?? '')
  const [selector, setSelector] = useState('')
  const [prompt, setPrompt] = useState(readPrompt)
  // 어떤 리포의 목록인지 함께 들고 있어야, 리포를 바꾼 직후에 이전 리포의 PR 이 잠깐
  // 잘못 보이는 일이 없다. (effect 안에서 동기적으로 null 로 리셋하면 리렌더가 한 번 더 돈다.)
  const [candidates, setCandidates] = useState<{
    repoId: string
    list: ReviewPrCandidate[]
  } | null>(null)
  const [busy, setBusy] = useState(false)

  // 리포를 고르면 열린 PR 목록을 받아 드롭다운을 채운다. gh 미연결이면 빈 배열이 와서
  // 번호 직접 입력 경로만 남는다(그 경우 시작 시 연결 모달이 뜬다).
  useEffect(() => {
    if (!repoId) return
    let alive = true
    void window.api.review.listOpenPrs(repoId).then((list) => {
      if (alive) setCandidates({ repoId, list })
    })
    return () => {
      alive = false
    }
  }, [repoId])

  // 현재 고른 리포의 목록만 유효로 본다. 아직이면 null(=로딩).
  const loaded = candidates?.repoId === repoId ? candidates.list : null
  const prNumber = parsePrSelector(selector)
  const canStart = !!repoId && prNumber !== null && prompt.trim().length > 0 && !busy

  const submit = async (): Promise<void> => {
    if (!canStart || prNumber === null) return
    setBusy(true)
    try {
      localStorage.setItem(PROMPT_KEY, prompt)
    } catch {
      /* 기억은 편의 기능일 뿐이다. */
    }
    await startReview({ repoId, prNumber, prompt, agentBackend: effectiveBackend })
    setBusy(false)
    onClose()
  }

  return (
    <Modal
      title="Review a pull request"
      onClose={onClose}
      width={560}
      footer={
        <>
          <button onClick={onClose} className={ghostBtn}>
            Cancel
          </button>
          <button onClick={submit} disabled={!canStart} className={primaryBtn}>
            {busy ? 'Starting…' : 'Start review'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className={labelClass} htmlFor="review-repo">
            Repository
          </label>
          <select
            id="review-repo"
            className={inputClass}
            value={repoId}
            onChange={(e) => {
              setRepoId(e.target.value)
              setSelector('')
            }}
          >
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelClass} htmlFor="review-pr">
            Pull request
          </label>
          <input
            id="review-pr"
            className={inputClass}
            value={selector}
            onChange={(e) => setSelector(e.target.value)}
            placeholder="123, #123, or a pull request URL"
            autoComplete="off"
          />
          {selector.trim() && prNumber === null && (
            <p className="mt-1.5 text-xs text-[var(--danger-400)]">
              Couldn&rsquo;t read a PR number from that.
            </p>
          )}

          {loaded === null ? (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-neutral-500">
              <Loader2 size={12} className="animate-spin" /> Loading open pull requests…
            </p>
          ) : loaded.length > 0 ? (
            <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-[var(--border)]">
              {loaded.map((pr) => (
                <button
                  key={pr.number}
                  onClick={() => setSelector(String(pr.number))}
                  className={`w-full text-left px-3 py-2 text-xs hover:bg-[var(--surface-2)] ${
                    prNumber === pr.number ? 'bg-[var(--surface-2)]' : ''
                  }`}
                >
                  <span className="font-mono text-neutral-500">#{pr.number}</span>{' '}
                  <span className="text-neutral-200">{pr.title}</span>
                  {pr.author && <span className="text-neutral-500"> · {pr.author}</span>}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {available.length > 1 && (
          <div>
            <span className={labelClass}>Agent</span>
            <div className="flex gap-1.5">
              {available.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => setAgentBackend(b.id)}
                  aria-pressed={effectiveBackend === b.id}
                  className={
                    'flex-1 flex items-center justify-center gap-2 text-sm px-3 py-2 rounded-lg border transition-colors ' +
                    (effectiveBackend === b.id
                      ? 'border-[var(--info-500)] bg-[var(--info-600)]/15 text-neutral-100'
                      : 'border-[var(--border)] text-neutral-300 hover:bg-[var(--surface-2)]')
                  }
                >
                  <AgentBackendMark backend={b.id} size={15} />
                  {b.label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-neutral-600">
              A review stays on the agent it was started with.
            </p>
          </div>
        )}

        <div>
          <label className={labelClass} htmlFor="review-prompt">
            How should it be reviewed?
          </label>
          <textarea
            id="review-prompt"
            className={`${inputClass} min-h-[88px] resize-y`}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
            }}
            placeholder="e.g. focus on concurrency bugs and error handling"
          />
          <p className="mt-1.5 text-xs text-neutral-500">
            Write it however you normally would — name a skill or an angle if you like.
            &#8984;&#8629; to start.
          </p>
        </div>
      </div>
    </Modal>
  )
}
