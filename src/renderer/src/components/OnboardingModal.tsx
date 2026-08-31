import { useState } from 'react'
import IntegrationsPanel from './IntegrationsPanel'
import PreferencesStep from './PreferencesStep'
import Logo from './Logo'
import { primaryBtn } from './Modal'
import { useStore } from '../store'
import { CURRENT_TERMS_VERSION, hasAnyAgent } from '@shared/types'
import type { AppSettings } from '@shared/types'
import { WOOI_URLS } from '../lib/externalLinks'

type Step = 'consent' | 'integrations' | 'preferences'

/**
 * 최초 실행 온보딩. 첫 단계로 약관·개인정보처리방침 동의를 강제하고(미동의 시 진행 불가),
 * 동의가 끝나면 계정 연결(AI 제공자/GitHub) → 기본값 고르기로 이어진다.
 *
 * 예전엔 여기 사이에 기능을 일괄 소개하는 투어가 있었다. 리포도 워크스페이스도 없는 상태에서
 * work panel·⌘J·PR 리뷰를 한꺼번에 듣는 건 와닿지 않아 뺐다 — 그 소개는 이제 사용자가 각
 * 기능에 실제로 닿는 순간으로 흩어져 있다. 투어 자체는 Settings → About 에서 여전히 돌 수
 * 있다(`FeatureTour`).
 *
 * 각 단계는 독립적으로 필요 여부를 판단한다 — 약관 버전이 올라가 재동의만 필요한 경우엔 동의만,
 * 기본값 고르기가 추가되기 전부터 쓰던 기존 사용자에게는 그 단계만 보여준다.
 */
export default function OnboardingModal({
  needsConsent,
  needsOnboarding,
  needsDefaults
}: {
  needsConsent: boolean
  needsOnboarding: boolean
  needsDefaults: boolean
}): React.JSX.Element {
  const [step, setStep] = useState<Step>(
    needsConsent ? 'consent' : needsOnboarding ? 'integrations' : 'preferences'
  )

  // 동의 저장 후 아직 남은 단계가 있으면 그리로. 없으면 settings 갱신으로 모달이 닫힌다.
  const acceptConsent = (): void => {
    void window.api.settings.update({ acceptedTermsVersion: CURRENT_TERMS_VERSION })
    if (needsOnboarding) setStep('integrations')
    else if (needsDefaults) setStep('preferences')
  }

  // 연결을 마치거나 건너뛰면 기본값 고르기로. 이미 골라 둔 사용자(재동의 흐름 등)는 여기서
  // 바로 온보딩을 끝낸다.
  const finishIntegrations = (): void => {
    if (needsDefaults) setStep('preferences')
    else void window.api.settings.update({ onboarded: true })
  }

  // 마지막 단계 — 고른 기본값과 함께 온보딩 완료 플래그를 한 번에 저장해 모달을 닫는다.
  const finishOnboarding = (patch: Partial<AppSettings>): void => {
    void window.api.settings.update({ ...patch, pickedDefaults: true, onboarded: true })
  }

  if (step === 'preferences') {
    return <PreferencesStep onDone={finishOnboarding} />
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60">
      <div className="no-drag w-[520px] max-w-[92vw] bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden">
        <div className="px-6 pt-7 pb-2 text-center">
          <div className="mb-3 flex justify-center">
            <Logo size={56} />
          </div>
          <h2 className="text-lg font-semibold text-neutral-100">Welcome to Wooi</h2>
          <p className="mt-1.5 text-sm text-neutral-500 leading-relaxed">
            Run parallel AI coding agents, each in its own isolated git worktree.
          </p>
        </div>

        {step === 'consent' ? (
          <ConsentStep onContinue={acceptConsent} />
        ) : (
          <IntegrationsStep onDone={finishIntegrations} />
        )}
      </div>
    </div>
  )
}

function ConsentStep({ onContinue }: { onContinue: () => void }): React.JSX.Element {
  const [agreed, setAgreed] = useState(false)

  const openDoc =
    (url: string) =>
    (e: React.MouseEvent): void => {
      e.preventDefault()
      void window.api.openExternal(url)
    }

  return (
    <>
      <div className="px-6 py-4 text-sm text-neutral-400 leading-relaxed space-y-2">
        <p className="text-neutral-300">Before you start, here&rsquo;s how your data is handled:</p>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            Your prompts and code are sent to the{' '}
            <b className="text-neutral-300">AI provider you connect</b> (such as Anthropic) to run
            the coding agent.
          </li>
          <li>
            If you use the GitHub features, repository data is sent to{' '}
            <b className="text-neutral-300">GitHub</b>.
          </li>
          <li>
            Settings and conversation transcripts are stored{' '}
            <b className="text-neutral-300">locally</b> on your Mac.
          </li>
          <li>
            Wooi has no servers and collects <b className="text-neutral-300">no analytics</b>.
          </li>
        </ul>
        <label className="flex items-start gap-2 pt-1.5 text-neutral-300 cursor-pointer">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            I have read and agree to the{' '}
            <a
              href={WOOI_URLS.privacyPolicy}
              onClick={openDoc(WOOI_URLS.privacyPolicy)}
              className="text-[var(--info-400)] hover:underline"
            >
              Privacy Policy
            </a>{' '}
            and{' '}
            <a
              href={WOOI_URLS.terms}
              onClick={openDoc(WOOI_URLS.terms)}
              className="text-[var(--info-400)] hover:underline"
            >
              Terms of Use
            </a>
            .
          </span>
        </label>
      </div>

      <div className="px-6 py-4 border-t border-[var(--border)] flex justify-end">
        <button
          className={primaryBtn + ' disabled:opacity-40 disabled:cursor-not-allowed'}
          disabled={!agreed}
          onClick={onContinue}
        >
          Continue
        </button>
      </div>
    </>
  )
}

function IntegrationsStep({ onDone }: { onDone: () => void }): React.JSX.Element {
  // gh(GitHub CLI)는 선택이다 — 없어도 리포 연결·워크스페이스 생성·에이전트 실행은 전부 되고,
  // PR·스택 기능을 처음 쓰는 순간에만 연결을 요구한다. 그래서 이 단계는 건너뛸 수 있다.
  const auth = useStore((s) => s.authStatus)
  const githubReady = !!auth && auth.github.installed && auth.github.loggedIn
  // 에이전트는 **둘 중 하나만** 연결하면 된다. Claude 만, 또는 Codex 만 가진 사용자도
  // 정상 사용자이므로 한쪽이 없다고 막지 않는다.
  const agentReady = hasAnyAgent(auth)

  return (
    <>
      <div className="px-6 py-4">
        <p className="mb-3 text-sm text-neutral-500 text-center leading-relaxed">
          Connect a coding agent to get started — Claude Code or Codex, whichever you have. GitHub
          is optional; you only need it for pull requests and stacked branches. You can change these
          anytime in Settings → Integrations. If you connect both, the next step lets you pick which
          one runs by default.
        </p>
        <IntegrationsPanel />
      </div>

      <div className="px-6 py-4 border-t border-[var(--border)] flex items-center justify-end gap-3">
        {!agentReady ? (
          <span className="text-xs text-[var(--warning-400)]">
            Connect at least one coding agent to start a session.
          </span>
        ) : (
          !githubReady && (
            <span className="text-xs text-neutral-500">
              You can connect GitHub later — we&rsquo;ll ask when a PR needs it.
            </span>
          )
        )}
        <button className={primaryBtn} onClick={onDone}>
          {agentReady && githubReady ? 'Get started' : 'Skip for now'}
        </button>
      </div>
    </>
  )
}
