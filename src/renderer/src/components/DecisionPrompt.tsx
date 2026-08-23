import { useState } from 'react'
import { Loader2, MessageCircleQuestion, Send, X } from 'lucide-react'
import type { PendingDecision, Workspace } from '@shared/types'
import { useStore } from '../store'

/** 오래된 질문부터 한 건씩 보여 줘, 여러 갈림길이 한꺼번에 묻혀 버리지 않게 한다. */
export default function DecisionPrompt({
  workspace
}: {
  workspace: Workspace
}): React.JSX.Element | null {
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const parent = useStore((state) =>
    state.app?.workspaces.find(
      (candidate) => candidate.id === workspace.parentWorkspaceId && !candidate.archived
    )
  )
  const decisions = workspace.decisions ?? []
  const pending: PendingDecision | undefined = decisions[0]
  if (!pending) return null

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Wooi could not send that. Try again.')
    } finally {
      setBusy(false)
    }
  }
  const submit = (text: string): void => {
    if (!text.trim()) return
    void run(() => window.api.workspace.answerDecision(workspace.id, pending.id, text))
  }

  return (
    <div className="px-4 pt-2">
      <div className="max-w-3xl mx-auto flex items-start gap-2.5 rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-2.5">
        <MessageCircleQuestion size={14} className="mt-0.5 shrink-0 text-[var(--accent-400)]" />
        <div className="min-w-0 flex-1 text-xs leading-relaxed text-neutral-200">
          <div className="flex items-center gap-1.5 font-medium">
            Decision needed
            {decisions.length > 1 && (
              <span className="text-[10px] font-normal text-neutral-500">
                +{decisions.length - 1} more waiting
              </span>
            )}
          </div>
          <div className="mt-1 whitespace-pre-wrap break-words text-neutral-300">
            {pending.question}
          </div>
          {pending.recommendation && (
            <div className="mt-2 text-neutral-400">
              <span className="font-medium text-neutral-300">Its recommendation:</span>{' '}
              {pending.recommendation}
            </div>
          )}
          {pending.escalatedTo && (
            <div className="mt-2 text-neutral-500">
              Handed to {pending.escalatedTo.branch} — its reply arrives here as a message
            </div>
          )}
          {pending.deliveryFailed ? (
            <div className="mt-2 flex items-center gap-2">
              <button
                disabled={busy}
                onClick={() => submit(pending.answer ?? '')}
                className="rounded-md bg-[var(--accent-500)] px-2.5 py-1 text-white hover:bg-[var(--accent-400)] disabled:opacity-50"
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : 'Retry'}
              </button>
              <span className="text-neutral-500">
                The answer was saved, but its turn did not start.
              </span>
            </div>
          ) : (
            <>
              {pending.options && (
                <div className="mt-2 grid gap-1.5">
                  {pending.options.map((option) => (
                    <button
                      key={option.label}
                      disabled={busy}
                      onClick={() => submit(option.label)}
                      className="rounded-md border border-[var(--border-2)] px-2.5 py-1.5 text-left hover:bg-[var(--surface-2)] disabled:opacity-50"
                    >
                      <div className="text-neutral-200">{option.label}</div>
                      {option.description && (
                        <div className="text-[11px] text-neutral-500">{option.description}</div>
                      )}
                    </button>
                  ))}
                </div>
              )}
              <div className="mt-2 flex gap-1.5">
                <input
                  value={answer}
                  onChange={(event) => setAnswer(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') submit(answer)
                  }}
                  placeholder="Answer in your own words"
                  className="min-w-0 flex-1 rounded-md border border-[var(--border-2)] bg-[var(--bg)] px-2 py-1 text-neutral-200 outline-none focus:border-[var(--accent-500)]"
                />
                <button
                  disabled={busy || !answer.trim()}
                  onClick={() => submit(answer)}
                  className="grid h-7 w-7 place-items-center rounded-md bg-[var(--accent-500)] text-white hover:bg-[var(--accent-400)] disabled:opacity-40"
                  aria-label="Send answer"
                >
                  {busy ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                </button>
              </div>
            </>
          )}
          {error && <div className="mt-1.5 text-[var(--danger-400)]">{error}</div>}
          <div className="mt-2 flex items-center gap-2 text-neutral-500">
            {parent && (
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const delivered = await window.api.workspace.escalateDecision(
                      workspace.id,
                      pending.id
                    )
                    if (!delivered)
                      throw new Error(
                        `${parent.branch} is not accepting messages. Answer here instead.`
                      )
                  })
                }
                className="rounded px-1.5 py-0.5 hover:bg-[var(--surface-2)] hover:text-neutral-300 disabled:opacity-50"
              >
                Ask {parent.branch}
              </button>
            )}
            <button
              disabled={busy}
              onClick={() =>
                void run(() => window.api.workspace.dismissDecision(workspace.id, pending.id))
              }
              className="ml-auto grid h-5 w-5 place-items-center rounded hover:bg-[var(--surface-2)] hover:text-neutral-300 disabled:opacity-50"
              title="Discard — the workspace is not told and stays waiting for an answer."
              aria-label="Discard question"
            >
              <X size={12} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
