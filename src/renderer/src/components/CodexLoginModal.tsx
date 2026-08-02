import { useEffect, useRef, useState } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'
import Modal, { ghostBtn, inputClass, primaryBtn } from './Modal'
import { useStore } from '../store'

/**
 * 앱 안에서 Codex 로그인을 끝내는 모달.
 *
 * Claude 와 달리 PTY 도, 코드 붙여넣기도 없다 — codex app-server 가 OAuth 콜백 서버까지 직접
 * 호스팅하므로, 우리는 인증 URL 을 열어 주고 완료 알림을 기다리기만 하면 된다.
 * ChatGPT 구독이 없는 사용자를 위해 OpenAI API 키 직접 입력 경로도 함께 제공한다.
 */

type Method = 'chatgpt' | 'apiKey'
type Phase = 'choose' | 'starting' | 'awaiting-browser' | 'submitting' | 'error'

export default function CodexLoginModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const refreshAuth = useStore((s) => s.refreshAuth)
  const [method, setMethod] = useState<Method>('chatgpt')
  const [phase, setPhase] = useState<Phase>('choose')
  const [url, setUrl] = useState<string>()
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState<string>()

  // 콜백은 ref 로 최신값을 참조한다 — effect 의존성에 넣으면 부모 리렌더마다 구독이
  // 끊겼다 다시 붙어 로그인이 중간에 취소된다. 갱신은 렌더 중이 아니라 커밋 후에 한다.
  const onCloseRef = useRef(onClose)
  const refreshAuthRef = useRef(refreshAuth)
  useEffect(() => {
    onCloseRef.current = onClose
    refreshAuthRef.current = refreshAuth
  })

  useEffect(() => {
    const unsub = window.api.onCodexLogin((e) => {
      if (e.phase === 'awaiting-browser') {
        setUrl(e.url)
        setPhase('awaiting-browser')
        // CLI 가 브라우저를 열어 주지 않으므로 우리가 연다.
        void window.api.openExternal(e.url)
        return
      }
      if (e.success) {
        void refreshAuthRef.current()
        onCloseRef.current()
      } else {
        setPhase('error')
        setError(e.error || 'Sign-in failed or was canceled. Try again.')
      }
    })
    return () => {
      unsub()
      // 모달을 닫으면 진행 중인 브라우저 로그인을 정리한다(완료된 경우엔 no-op).
      void window.api.auth.codexLoginCancel()
    }
  }, [])

  const start = (next: Method): void => {
    setMethod(next)
    setError(undefined)

    if (next === 'apiKey') {
      if (!apiKey.trim()) {
        setPhase('choose')
        return
      }
      setPhase('submitting')
      void window.api.auth
        .codexLoginStart('apiKey', apiKey.trim())
        .then(() => {
          void refreshAuthRef.current()
          onCloseRef.current()
        })
        .catch((err: Error) => {
          setPhase('error')
          setError(err.message || 'Could not save that API key.')
        })
      return
    }

    setPhase('starting')
    void window.api.auth.codexLoginStart('chatgpt').catch((err: Error) => {
      setPhase('error')
      setError(err.message || 'Could not start sign-in.')
    })
  }

  const busy = phase === 'starting' || phase === 'submitting'

  return (
    <Modal title="Sign in to Codex" onClose={onClose} width={460}>
      <div className="space-y-3">
        {phase === 'choose' && (
          <>
            <p className="text-sm text-neutral-300 leading-relaxed">
              Sign in with your ChatGPT plan, or use an OpenAI API key if you don&rsquo;t have one.
            </p>
            <div>
              <input
                autoFocus
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && apiKey.trim()) start('apiKey')
                }}
                placeholder="sk-… (optional — only for API key sign-in)"
                type="password"
                className={inputClass}
              />
              <p className="mt-1.5 text-xs text-neutral-600">
                API key usage is billed at OpenAI Platform rates, not your ChatGPT plan.
              </p>
            </div>
          </>
        )}

        {phase === 'starting' && (
          <div className="flex items-center gap-2 text-sm text-neutral-400">
            <Loader2 size={15} className="animate-spin" />
            Opening your browser to sign in…
          </div>
        )}

        {phase === 'submitting' && (
          <div className="flex items-center gap-2 text-sm text-neutral-400">
            <Loader2 size={15} className="animate-spin" />
            Saving your API key…
          </div>
        )}

        {phase === 'awaiting-browser' && (
          <>
            <div className="flex items-center gap-2 text-sm text-neutral-300">
              <Loader2 size={15} className="animate-spin shrink-0" />
              Waiting for you to finish signing in…
            </div>
            {url && (
              <button
                onClick={() => void window.api.openExternal(url)}
                className="flex items-center gap-1.5 text-xs text-[var(--info-400)] hover:text-[var(--info-300)]"
              >
                <ExternalLink size={13} /> Browser didn&rsquo;t open? Open the sign-in page
              </button>
            )}
          </>
        )}

        {phase === 'error' && <p className="text-sm text-[var(--danger-400)]">{error}</p>}
      </div>

      <div className="flex justify-end gap-2 pt-4">
        <button onClick={onClose} className={ghostBtn}>
          Cancel
        </button>
        {phase === 'error' ? (
          <button onClick={() => start(method)} className={primaryBtn}>
            Try again
          </button>
        ) : (
          <>
            {phase === 'choose' && apiKey.trim() && (
              <button onClick={() => start('apiKey')} className={ghostBtn}>
                Use API key
              </button>
            )}
            <button onClick={() => start('chatgpt')} disabled={busy} className={primaryBtn}>
              {busy && <Loader2 size={13} className="inline mr-1.5 animate-spin" />}
              Sign in with ChatGPT
            </button>
          </>
        )}
      </div>
    </Modal>
  )
}
