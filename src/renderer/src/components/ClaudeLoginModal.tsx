import { useEffect, useRef, useState } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react'
import Modal, { ghostBtn, inputClass, primaryBtn } from './Modal'
import { useStore } from '../store'

type Phase = 'starting' | 'awaiting-code' | 'verifying' | 'error'

/**
 * 별도 Terminal 창 없이 앱 안에서 Claude Code 로그인을 끝내는 모달.
 *
 * main 의 PTY 가 `claude auth login` 을 실행하면서 띄운 인증 URL 과 "Paste code here" 프롬프트를
 * onClaudeLogin 이벤트로 받아, 사용자가 브라우저에서 받은 코드를 입력하면 PTY 로 제출한다.
 * 브라우저는 CLI 가 자동으로 열며, 안 열렸을 때를 위해 URL 링크도 함께 보여 준다.
 */
export default function ClaudeLoginModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const refreshAuth = useStore((s) => s.refreshAuth)
  const [phase, setPhase] = useState<Phase>('starting')
  const [url, setUrl] = useState<string>()
  const [code, setCode] = useState('')
  const [error, setError] = useState<string>()
  // 코드를 제출한 직후인지 추적 — 같은 프롬프트가 다시 오면 "거절된 코드"로 해석한다.
  const submittedRef = useRef(false)

  // 콜백은 ref 로 최신값을 참조한다. effect 의존성에 넣으면 부모 리렌더로 onClose 참조가
  // 바뀔 때마다 effect 가 재실행(cleanup→start)돼 브라우저가 무한히 다시 열리기 때문이다.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const refreshAuthRef = useRef(refreshAuth)
  refreshAuthRef.current = refreshAuth

  useEffect(() => {
    const unsub = window.api.onClaudeLogin((e) => {
      if (e.phase === 'awaiting-code') {
        setUrl(e.url)
        // 제출 직후 다시 코드 요청이 오면(reprompt) 직전 코드가 거절된 것 — 안내 후 재입력.
        if (submittedRef.current || e.reprompt) {
          submittedRef.current = false
          setError('That code didn’t work. Copy it again and retry.')
          setCode('')
        }
        setPhase('awaiting-code')
      } else if (e.phase === 'done') {
        if (e.success) {
          void refreshAuthRef.current()
          onCloseRef.current()
        } else {
          submittedRef.current = false
          setPhase('error')
          setError('Sign-in failed or was canceled. Try again.')
        }
      }
    })
    void window.api.auth.claudeLoginStart()
    return () => {
      unsub()
      // 모달을 닫으면 진행 중인 로그인 PTY 를 정리한다(완료된 경우엔 no-op).
      void window.api.auth.claudeLoginCancel()
    }
    // 마운트 시 한 번만 로그인 PTY 를 시작하고, 언마운트 시 정리한다.
  }, [])

  const submit = (): void => {
    if (!code.trim()) return
    submittedRef.current = true
    setError(undefined)
    setPhase('verifying')
    void window.api.auth.claudeLoginSubmitCode(code)
  }

  const restart = (): void => {
    submittedRef.current = false
    setCode('')
    setError(undefined)
    setPhase('starting')
    void window.api.auth.claudeLoginStart()
  }

  return (
    <Modal title="Sign in to Claude Code" onClose={onClose} width={460}>
      <div className="space-y-3">
        {phase === 'starting' && (
          <div className="flex items-center gap-2 text-sm text-neutral-400">
            <Loader2 size={15} className="animate-spin" />
            Opening your browser to sign in…
          </div>
        )}

        {(phase === 'awaiting-code' || phase === 'verifying') && (
          <>
            <p className="text-sm text-neutral-300 leading-relaxed">
              A browser window opened for sign-in. After approving, copy the code shown and paste it
              below.
            </p>

            {url && (
              <button
                onClick={() => void window.api.openExternal(url)}
                className="flex items-center gap-1.5 text-xs text-[var(--info-400)] hover:text-[var(--info-300)]"
              >
                <ExternalLink size={13} /> Browser didn’t open? Open the sign-in page
              </button>
            )}

            <div>
              <input
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submit()
                }}
                placeholder="Paste your authorization code"
                disabled={phase === 'verifying'}
                className={inputClass}
              />
              {error && <p className="text-xs text-[var(--danger-400)] mt-1.5">{error}</p>}
            </div>
          </>
        )}

        {phase === 'error' && <p className="text-sm text-[var(--danger-400)]">{error}</p>}
      </div>

      <div className="flex justify-end gap-2 pt-4">
        <button onClick={onClose} className={ghostBtn}>
          Cancel
        </button>
        {phase === 'error' ? (
          <button onClick={restart} className={primaryBtn}>
            Try again
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={phase !== 'awaiting-code' || !code.trim()}
            className={primaryBtn}
          >
            {phase === 'verifying' && <Loader2 size={13} className="inline mr-1.5 animate-spin" />}
            {phase === 'verifying' ? 'Signing in…' : 'Sign in'}
          </button>
        )}
      </div>
    </Modal>
  )
}
