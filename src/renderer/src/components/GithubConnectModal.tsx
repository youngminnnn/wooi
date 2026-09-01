import { useEffect } from 'react'
import { X } from 'lucide-react'
import IntegrationsPanel from './IntegrationsPanel'
import { GithubMark } from './BrandIcons'
import { useStore } from '../store'

/**
 * gh(GitHub CLI) 지연 게이트. PR 생성·머지·스택처럼 gh 가 실제로 필요한 액션을 눌렀을 때만 뜬다.
 * 앱 진입을 막던 예전 하드 게이트(GithubGate)를 대체한다 — 이제 gh 없이도 리포 연결·워크스페이스
 * 생성·에이전트 실행 등 git 만으로 되는 일은 전부 할 수 있고, 연결은 필요한 순간에만 요구한다.
 *
 * 설치/로그인은 IntegrationsPanel 의 기존 플로우(Install 링크 · 앱 내 로그인 · 폴링)를 그대로
 * 재사용한다. 사용자가 앱 밖에서 gh 를 설치·로그인한 경우도 감지하도록 열려 있는 동안 인증
 * 상태를 주기적으로 갱신하고, 연결이 확인되면 원래 하려던 액션을 이어서 수행한 뒤 닫힌다.
 */
export default function GithubConnectModal(): React.JSX.Element {
  const reason = useStore((s) => s.githubGate?.reason ?? '')
  const refreshAuth = useStore((s) => s.refreshAuth)
  const resolve = useStore((s) => s.resolveGithubGate)
  const dismiss = useStore((s) => s.dismissGithubGate)
  const connected = useStore(
    (s) => !!s.authStatus?.github.installed && !!s.authStatus.github.loggedIn
  )

  useEffect(() => {
    const id = setInterval(() => void refreshAuth(), 3000)
    return () => clearInterval(id)
  }, [refreshAuth])

  // 연결이 확인되면 대기 중이던 액션을 실행하고 닫는다.
  useEffect(() => {
    if (connected) resolve()
  }, [connected, resolve])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') dismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dismiss])

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50">
      <div className="no-drag relative w-[520px] max-w-[92vw] bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden">
        <button
          onClick={dismiss}
          aria-label="Close"
          className="absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-lg text-neutral-500 hover:bg-[var(--surface-2)] hover:text-neutral-300"
        >
          <X size={15} />
        </button>
        <div className="px-6 pt-7 pb-2 text-center">
          <div className="mb-3 flex justify-center">
            <div className="grid h-12 w-12 place-items-center rounded-xl bg-[var(--surface-2)] text-neutral-200">
              <GithubMark size={24} />
            </div>
          </div>
          <h2 className="text-lg font-semibold text-neutral-100">Connect GitHub</h2>
          <p className="mt-1.5 text-sm text-neutral-500 leading-relaxed">
            {reason || 'This action uses the GitHub CLI (gh).'} Sign in once and Wooi picks it up
            automatically — you can keep working without it in the meantime.
          </p>
        </div>
        <div className="px-6 py-4">
          <IntegrationsPanel only="github" />
        </div>
        <div className="px-6 pb-5 flex justify-end">
          <button
            onClick={dismiss}
            className="text-sm px-3 py-1.5 rounded-lg text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-200"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  )
}
