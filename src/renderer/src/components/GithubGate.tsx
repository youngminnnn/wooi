import { useEffect } from 'react'
import IntegrationsPanel from './IntegrationsPanel'
import Logo from './Logo'
import { useStore } from '../store'

/**
 * gh(GitHub CLI) 하드 게이트. Ditto 는 브랜치·PR 관리에 gh 를 필수로 쓰므로,
 * "설치 + 로그인" 이 모두 끝나기 전에는 본 화면 진입을 막는다(App 에서 전체화면 오버레이로 렌더).
 *
 * Claude 등 다른 에이전트는 막지 않는다 — 향후 Claude 외 에이전트도 지원할 예정이라
 * 에이전트 로그인 여부로 앱을 막는 것은 어색하기 때문이다.
 *
 * 설치/로그인은 IntegrationsPanel 의 기존 플로우(Install 링크 · Terminal 로그인 · 폴링)를
 * 그대로 재사용한다. 사용자가 앱 밖에서 gh 를 설치·로그인한 경우도 감지하도록, 게이트가 떠 있는
 * 동안 인증 상태를 주기적으로 갱신한다 — gh 가 준비되면 App 의 재검사가 통과해 게이트가 사라진다.
 */
export default function GithubGate(): React.JSX.Element {
  const refreshAuth = useStore((s) => s.refreshAuth)

  useEffect(() => {
    const id = setInterval(() => void refreshAuth(), 3000)
    return () => clearInterval(id)
  }, [refreshAuth])

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60">
      <div className="no-drag w-[520px] max-w-[92vw] bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden">
        <div className="px-6 pt-7 pb-2 text-center">
          <div className="mb-3 flex justify-center">
            <Logo size={56} />
          </div>
          <h2 className="text-lg font-semibold text-neutral-100">GitHub CLI required</h2>
          <p className="mt-1.5 text-sm text-neutral-500 leading-relaxed">
            Ditto uses the GitHub CLI (gh) to manage branches and pull requests. Install it and sign
            in to continue — this screen closes automatically once you&rsquo;re connected.
          </p>
        </div>
        <div className="px-6 py-4">
          <IntegrationsPanel />
        </div>
      </div>
    </div>
  )
}
