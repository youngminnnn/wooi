import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Layers, Loader2, Search } from 'lucide-react'
import type { AgentBackendId, EffortSetting, PrCandidate } from '@shared/types'
import Modal, { ghostBtn, inputClass, labelClass, primaryBtn } from '../Modal'
import { useStore } from '../../store'
import {
  useAgentSettings,
  useAvailableBackends,
  useBackend,
  useDefaultBackend,
  useModels
} from '../../lib/backends'
import { effortLabel, effortOptionsFor } from '../../lib/effort'
import { modelLabel } from '../../lib/models'
import { AgentBackendMark } from '../BrandIcons'
import { matchesPrQuery, parsePrSelector, parsePrUrl } from '../../lib/review'

/**
 * 리뷰 지시는 **빈 칸에서 시작한다.** 흐린 기본 문장만 자리표시로 남겨 두고, 그대로 두면
 * 그 문장으로 돈다 — 대부분은 특별히 시킬 말이 없고, 그때 매번 남의 문장을 지우게 만들 이유가
 * 없기 때문이다.
 *
 * 지난번 문장을 다시 쓰고 싶은 사람만 체크박스로 남긴다. 남겼을 때만 다음 번에 그 문장이
 * 채워진 채로 열린다(체크는 그대로라 언제든 지우고 새로 쓸 수 있다).
 */
const PROMPT_KEY = 'wooi.reviewPrompt'
const DEFAULT_PROMPT = 'Review this PR.'

function readPrompt(): string | null {
  try {
    return localStorage.getItem(PROMPT_KEY)
  } catch {
    return null
  }
}

export default function PrReviewStartModal({
  onClose
}: {
  onClose: () => void
}): React.JSX.Element {
  const repos = useStore((s) => s.app?.repos ?? [])
  const defaultBackend = useDefaultBackend()
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
  /** 검색창에 친 글자. 번호·URL·제목 조각 무엇이든 될 수 있다. */
  const [query, setQuery] = useState('')
  /** 확정한 PR. 정해지면 목록을 접는다 — 고른 뒤에도 목록이 펼쳐져 있으면 골랐는지 알 수 없다. */
  const [picked, setPicked] = useState<{ number: number; pr?: PrCandidate } | null>(null)
  // 남겨 둔 문장이 있으면 그것으로 시작한다(체크박스로 직접 남긴 것이므로 다시 쓰겠다는 뜻).
  const remembered = useMemo(() => readPrompt(), [])
  const [prompt, setPrompt] = useState(remembered ?? '')
  const [remember, setRemember] = useState(remembered !== null)
  // 어떤 리포의 목록인지 함께 들고 있어야, 리포를 바꾼 직후에 이전 리포의 PR 이 잠깐
  // 잘못 보이는 일이 없다. (effect 안에서 동기적으로 null 로 리셋하면 리렌더가 한 번 더 돈다.)
  const [candidates, setCandidates] = useState<{
    repoId: string
    list: PrCandidate[]
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  /**
   * 모델·추론 강도. 빈 문자열이 "Default" 이고, 그때는 값을 아예 보내지 않아 그 에이전트의
   * 전역 기본값으로 돈다 — 리뷰만 따로 설정하고 싶은 사람에게만 선택지를 준다.
   *
   * 에이전트를 바꾸면 둘 다 Default 로 되돌린다. 모델 ID 는 백엔드마다 다른 세계라, Claude 에서
   * 고른 값을 Codex 에 그대로 넘기면 CLI 가 거부한다.
   */
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const backendMeta = useBackend(effectiveBackend)
  const models = useModels(effectiveBackend)
  const agentDefaults = useAgentSettings(effectiveBackend)
  const efforts = effortOptionsFor(
    backendMeta,
    models.find((m) => m.id === (model || agentDefaults.model))
  )
  const pickBackend = (id: AgentBackendId): void => {
    setAgentBackend(id)
    setModel('')
    setEffort('')
  }

  // 리포를 고르면 열린 PR 목록을 받아 목록을 채운다. gh 미연결이면 빈 배열이 와서
  // 번호·URL 직접 입력 경로만 남는다(그 경우 시작 시 연결 모달이 뜬다).
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
  const matches = useMemo(
    () => (loaded ?? []).filter((pr) => matchesPrQuery(pr, query)),
    [loaded, query]
  )
  // 목록에 없는 PR(닫힘·다른 상태)도 번호나 URL 만 있으면 리뷰할 수 있다.
  const typedNumber = parsePrSelector(query)
  const typedIsListed = matches.some((pr) => pr.number === typedNumber)

  const prNumber = picked?.number ?? null
  const canStart = !!repoId && prNumber !== null && !busy

  /**
   * 고른 PR 이 속한 스택. 리뷰의 기본값을 정하므로 고르는 즉시 물어본다.
   * `null` 은 아직 조회 중, 원소 1개는 스택이 아니라는 뜻이다.
   */
  const [stack, setStack] = useState<{ prNumber: number; prNumbers: number[] } | null>(null)
  /**
   * 스택 전체를 볼지. **기본값은 켬**이다 — 스택의 한 층만 따로 보는 것이 지금 잘못돼 있는
   * 바로 그 지점이고, 5개짜리 스택의 가운데 PR 주소를 붙여 넣은 사람이 나머지 4개를 일부러
   * 무시하기로 정했을 리는 없다. 무엇을 보게 되는지 아래에 그대로 적어 두고, 끄는 것은 한 번이다.
   */
  const [wholeStack, setWholeStack] = useState(true)

  // 결과에 어느 PR 의 것인지 함께 담아 두므로, PR 을 바꿀 때 여기서 비울 필요가 없다 —
  // 아래 `resolved` 가 지금 고른 PR 의 결과일 때만 유효로 본다(리포 목록과 같은 방식).
  useEffect(() => {
    if (prNumber === null || !repoId) return
    let alive = true
    void window.api.review.resolveStack(repoId, prNumber).then((res) => {
      if (alive) setStack({ prNumber, prNumbers: res.prNumbers })
    })
    return () => {
      alive = false
    }
  }, [repoId, prNumber])

  const resolved = stack?.prNumber === prNumber ? stack.prNumbers : null
  const isStack = (resolved?.length ?? 0) > 1

  const choose = (number: number, pr?: PrCandidate): void => {
    setPicked({ number, pr })
    setQuery('')
    setWholeStack(true)
  }

  /**
   * 붙여넣기·타이핑을 함께 받는다. **PR URL 은 그 자리에서 확정한다** — 주소창에서 복사해 온
   * 사람은 이미 어떤 PR 인지 정했고, 그 뒤에 목록에서 또 고르라고 할 이유가 없다. 리포까지
   * 알아낼 수 있으면 등록된 리포 중 이름이 같은 것으로 함께 맞춰 준다.
   */
  const onQueryChange = (value: string): void => {
    const url = parsePrUrl(value)
    if (!url) {
      setQuery(value)
      return
    }
    const repo = repos.find((r) => r.name.toLowerCase() === url.repo.toLowerCase())
    if (repo && repo.id !== repoId) setRepoId(repo.id)
    choose(url.number)
  }

  const submit = async (): Promise<void> => {
    if (!canStart || prNumber === null) return
    // 비워 두면 자리표시로 보여 준 그 문장으로 돈다 — 보이는 것과 도는 것이 같아야 한다.
    const written = prompt.trim()
    const message = written || DEFAULT_PROMPT
    setBusy(true)
    try {
      // 빈 칸을 기억해 봐야 다음 번에 자리표시와 같은 문장이 채워진 채로 열릴 뿐이다.
      if (remember && written) localStorage.setItem(PROMPT_KEY, written)
      else localStorage.removeItem(PROMPT_KEY)
    } catch {
      /* 기억은 편의 기능일 뿐이다. */
    }
    await startReview({
      repoId,
      prNumbers: isStack && wholeStack ? resolved! : [prNumber],
      prompt: message,
      agentBackend: effectiveBackend,
      // 빈 값 = Default → 키를 넘기지 않아 전역 기본값으로 해석된다.
      ...(model ? { model } : {}),
      ...(effort ? { effort: effort as EffortSetting } : {})
    })
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
          <button onClick={() => void submit()} disabled={!canStart} className={primaryBtn}>
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
              setPicked(null)
              setQuery('')
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
          <span className={labelClass}>Pull request</span>

          {picked ? (
            <div className="flex items-center gap-2 rounded-lg border border-[var(--info-500)]/40 bg-[var(--info-600)]/10 px-3 py-2">
              <Check size={14} className="shrink-0 text-[var(--info-300)]" />
              <span className="shrink-0 font-mono text-sm text-neutral-400">#{picked.number}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-neutral-100">
                {picked.pr?.title ?? 'Pull request'}
              </span>
              {picked.pr?.author && (
                <span className="shrink-0 text-xs text-neutral-500">{picked.pr.author}</span>
              )}
              <button
                onClick={() => {
                  setPicked(null)
                  setTimeout(() => searchRef.current?.focus(), 0)
                }}
                className="shrink-0 rounded-md px-2 py-0.5 text-xs text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100"
              >
                Change
              </button>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-2)] px-3 py-2 focus-within:border-[var(--border-strong)]">
                <Search size={14} className="shrink-0 text-neutral-500" />
                <input
                  ref={searchRef}
                  className="min-w-0 flex-1 bg-transparent text-base text-neutral-100 outline-none placeholder:text-neutral-600"
                  value={query}
                  onChange={(e) => onQueryChange(e.target.value)}
                  onKeyDown={(e) => {
                    // 첫 후보로 바로 확정한다 — 검색해서 하나로 좁힌 뒤 마우스로 옮겨 가는 건 군더더기다.
                    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
                    e.preventDefault()
                    if (matches.length > 0) choose(matches[0].number, matches[0])
                    else if (typedNumber !== null) choose(typedNumber)
                  }}
                  placeholder="Search open PRs, or paste a pull request URL"
                  autoComplete="off"
                  aria-label="Search pull requests"
                />
              </div>

              {loaded === null ? (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-neutral-500">
                  <Loader2 size={12} className="animate-spin" /> Loading open pull requests…
                </p>
              ) : (
                <div className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-[var(--border)] empty:hidden">
                  {matches.map((pr) => (
                    <button
                      key={pr.number}
                      onClick={() => choose(pr.number, pr)}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-[var(--surface-2)]"
                    >
                      <span className="shrink-0 font-mono text-neutral-500">#{pr.number}</span>
                      <span className="min-w-0 flex-1 truncate text-neutral-200">{pr.title}</span>
                      {pr.author && <span className="shrink-0 text-neutral-500">{pr.author}</span>}
                    </button>
                  ))}
                  {/* 목록에 없는 번호를 쳤을 때의 탈출구. 닫힌 PR·다른 상태도 리뷰할 수 있다. */}
                  {typedNumber !== null && !typedIsListed && (
                    <button
                      onClick={() => choose(typedNumber)}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-neutral-300 hover:bg-[var(--surface-2)]"
                    >
                      Review <span className="font-mono">#{typedNumber}</span>
                      <span className="text-neutral-600">(not in the open list)</span>
                    </button>
                  )}
                </div>
              )}

              {loaded !== null &&
                matches.length === 0 &&
                typedNumber === null &&
                (query.trim() ? (
                  <p className="mt-2 text-xs text-neutral-500">
                    No open pull request matches that.
                  </p>
                ) : (
                  <p className="mt-2 text-xs text-neutral-500">
                    No open pull requests — paste a URL or type a number.
                  </p>
                ))}
            </>
          )}
        </div>

        {/* 스택이면 여기서 정한다. 무엇을 리뷰하게 되는지 목록으로 보여 주고, 한 번에 끌 수 있다. */}
        {isStack && (
          <div className="rounded-lg border border-[var(--accent-400)]/30 bg-[var(--accent-400)]/5 px-3 py-2.5">
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                className="mt-0.5 accent-[var(--accent-400)]"
                checked={wholeStack}
                onChange={(e) => setWholeStack(e.target.checked)}
              />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-sm text-neutral-100">
                  <Layers size={13} className="text-[var(--accent-400)]" />
                  Review the whole stack ({resolved!.length} pull requests)
                </span>
                <span className="mt-0.5 block text-xs text-neutral-400">
                  {resolved!.map((n) => `#${n}`).join(' → ')}
                </span>
                <span className="mt-1 block text-xs text-neutral-500">
                  One review over every layer at once — is the split correct, is the order right,
                  does a layer depend on the one above it? Uncheck to review #{prNumber} alone.
                </span>
              </span>
            </label>
          </div>
        )}

        {available.length > 1 && (
          <div>
            <span className={labelClass}>Agent</span>
            <div className="flex gap-1.5">
              {available.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => pickBackend(b.id)}
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

        {/* 모델·추론 강도. 워크스페이스와 같은 규칙으로 "Default" 는 그 에이전트의 전역 기본값을
            따른다는 뜻이고, 괄호 안에 그게 무엇인지 적어 둔다. */}
        <div className="flex gap-3">
          <div className="min-w-0 flex-1">
            <label className={labelClass} htmlFor="review-model">
              Model
            </label>
            <select
              id="review-model"
              className={`${inputClass} text-sm`}
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="">Default — {modelLabel(models, agentDefaults.model)}</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-0 flex-1">
            <label className={labelClass} htmlFor="review-effort">
              Reasoning effort
            </label>
            <select
              id="review-effort"
              className={`${inputClass} text-sm`}
              value={effort}
              onChange={(e) => setEffort(e.target.value)}
            >
              <option value="">Default — {effortLabel(backendMeta, agentDefaults.effort)}</option>
              {efforts.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </select>
          </div>
        </div>

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
            placeholder={DEFAULT_PROMPT}
          />
          <label className="mt-2 flex cursor-pointer items-center gap-1.5 text-xs text-neutral-400 select-none">
            <input
              type="checkbox"
              className="accent-[var(--info-500)]"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            Use this message next time
          </label>
          <p className="mt-1.5 text-xs text-neutral-500">
            Leave it empty to just review the PR — or name a skill or an angle. &#8984;&#8629; to
            start.
          </p>
        </div>
      </div>
    </Modal>
  )
}
