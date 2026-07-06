import { useEffect, useRef, useState } from 'react'
import { Check, Copy, ExternalLink, Loader2 } from 'lucide-react'
import Modal, { ghostBtn, primaryBtn } from './Modal'
import { useStore } from '../store'

type Phase = 'starting' | 'awaiting-auth' | 'error'

/**
 * 별도 Terminal 창 없이 앱 안에서 GitHub(gh) 로그인을 끝내는 모달.
 *
 * main 의 PTY 가 `gh auth login --web`(디바이스 플로우)을 실행하면서 띄운 one-time 코드와
 * 디바이스 페이지 URL 을 onGithubLogin 이벤트로 받아, 사용자가 브라우저에서 그 코드를 입력하고
 * 승인하면 gh 가 스스로 완료된다(코드를 앱에 되붙여넣지 않는다 — Claude 플로우와 다른 점).
 * 브라우저는 gh 가 자동으로 열며, 안 열렸을 때를 위해 URL 링크도 함께 보여 준다.
 */
export default function GithubLoginModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const refreshAuth = useStore((s) => s.refreshAuth)
  const [phase, setPhase] = useState<Phase>('starting')
  const [code, setCode] = useState<string>()
  const [url, setUrl] = useState<string>()
  const [error, setError] = useState<string>()
  const [copied, setCopied] = useState(false)

  // 콜백은 ref 로 최신값을 참조한다. effect 의존성에 넣으면 부모 리렌더로 참조가 바뀔 때마다
  // effect 가 재실행(cleanup→start)돼 로그인 PTY 가 무한히 다시 시작되기 때문이다.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const refreshAuthRef = useRef(refreshAuth)
  refreshAuthRef.current = refreshAuth

  useEffect(() => {
    const unsub = window.api.onGithubLogin((e) => {
      if (e.phase === 'awaiting-auth') {
        setCode(e.code)
        setUrl(e.url)
        setPhase('awaiting-auth')
      } else if (e.phase === 'done') {
        if (e.success) {
          void refreshAuthRef.current()
          onCloseRef.current()
        } else {
          setPhase('error')
          setError('Sign-in failed or was canceled. Try again.')
        }
      }
    })
    void window.api.auth.githubLoginStart()
    return () => {
      unsub()
      // 모달을 닫으면 진행 중인 로그인 PTY 를 정리한다(완료된 경우엔 no-op).
      void window.api.auth.githubLoginCancel()
    }
    // 마운트 시 한 번만 로그인 PTY 를 시작하고, 언마운트 시 정리한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const copyCode = (): void => {
    if (!code) return
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const restart = (): void => {
    setCode(undefined)
    setUrl(undefined)
    setError(undefined)
    setPhase('starting')
    void window.api.auth.githubLoginStart()
  }

  return (
    <Modal title="Sign in to GitHub" onClose={onClose} width={460}>
      <div className="space-y-3">
        {phase === 'starting' && (
          <div className="flex items-center gap-2 text-sm text-neutral-400">
            <Loader2 size={15} className="animate-spin" />
            Requesting a device code…
          </div>
        )}

        {phase === 'awaiting-auth' && (
          <>
            <p className="text-sm text-neutral-300 leading-relaxed">
              A browser window opened for sign-in. Enter this one-time code to authorize, then this
              window closes automatically.
            </p>

            {code && (
              <button
                onClick={copyCode}
                className="flex w-full items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 hover:bg-[var(--border)]"
              >
                <span className="font-mono text-xl tracking-[0.3em] text-neutral-100">{code}</span>
                <span className="flex items-center gap-1.5 text-xs text-neutral-400">
                  {copied ? <Check size={13} className="text-[var(--success-400)]" /> : <Copy size={13} />}
                  {copied ? 'Copied' : 'Copy'}
                </span>
              </button>
            )}

            {url && (
              <button
                onClick={() => void window.api.openExternal(url)}
                className="flex items-center gap-1.5 text-xs text-[var(--info-400)] hover:text-[var(--info-300)]"
              >
                <ExternalLink size={13} /> Browser didn’t open? Open the device page
              </button>
            )}

            <div className="flex items-center gap-2 pt-1 text-xs text-neutral-500">
              <Loader2 size={13} className="animate-spin" />
              Waiting for authorization…
            </div>
          </>
        )}

        {phase === 'error' && <p className="text-sm text-[var(--danger-400)]">{error}</p>}
      </div>

      <div className="flex justify-end gap-2 pt-4">
        <button onClick={onClose} className={ghostBtn}>
          Cancel
        </button>
        {phase === 'error' && (
          <button onClick={restart} className={primaryBtn}>
            Try again
          </button>
        )}
      </div>
    </Modal>
  )
}
