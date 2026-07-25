import { useState } from 'react'
import IntegrationsPanel from './IntegrationsPanel'
import FeatureTour from './FeatureTour'
import PreferencesStep from './PreferencesStep'
import Logo from './Logo'
import { primaryBtn } from './Modal'
import { useStore } from '../store'
import { CURRENT_TERMS_VERSION } from '@shared/types'
import type { AppSettings } from '@shared/types'

// 배포 시 실제 공개 URL 로 교체한다(현재는 앱과 함께 제공되는 repo 문서를 가리킨다).
const PRIVACY_URL = 'https://github.com/youngminnnn/wooi/blob/main/PRIVACY.md'
const TERMS_URL = 'https://github.com/youngminnnn/wooi/blob/main/TERMS.md'

type Step = 'consent' | 'integrations' | 'features' | 'preferences'

/**
 * 최초 실행 온보딩. 첫 단계로 약관·개인정보처리방침 동의를 강제하고(미동의 시 진행 불가),
 * 동의가 끝나면 계정 연결(AI 제공자/GitHub) → 주요 기능 소개 투어 → 기본값 고르기로 이어진다.
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

  // 투어를 마치거나 건너뛰면 기본값 고르기로. 이미 골라 둔 사용자(투어 재실행이 아닌 재동의 흐름 등)는
  // 여기서 바로 온보딩을 끝낸다.
  const finishTour = (): void => {
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

  // 기능 투어는 실제 화면을 스포트라이트하는 전체 화면 단계라 위 모달 껍데기를 쓰지 않는다.
  if (step === 'features') {
    return (
      <FeatureTour firstRun onDone={finishTour} doneLabel={needsDefaults ? 'Next' : undefined} />
    )
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
          <IntegrationsStep onDone={() => setStep('features')} />
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
              href={PRIVACY_URL}
              onClick={openDoc(PRIVACY_URL)}
              className="text-[var(--info-400)] hover:underline"
            >
              Privacy Policy
            </a>{' '}
            and{' '}
            <a
              href={TERMS_URL}
              onClick={openDoc(TERMS_URL)}
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
  // gh(GitHub CLI)는 필수다 — 설치 + 로그인이 모두 끝나기 전에는 온보딩을 마칠 수 없게 막는다.
  const auth = useStore((s) => s.authStatus)
  const githubReady = !!auth && auth.github.installed && auth.github.loggedIn

  return (
    <>
      <div className="px-6 py-4">
        <p className="mb-3 text-sm text-neutral-500 text-center leading-relaxed">
          Connect your accounts to get started — the GitHub CLI (gh) is required. You can change
          these later in Settings.
        </p>
        <IntegrationsPanel />
      </div>

      <div className="px-6 py-4 border-t border-[var(--border)] flex items-center justify-end gap-3">
        {!githubReady && (
          <span className="text-xs text-neutral-500">Sign in to GitHub to continue</span>
        )}
        <button
          className={primaryBtn + ' disabled:opacity-40 disabled:cursor-not-allowed'}
          disabled={!githubReady}
          onClick={onDone}
        >
          Get started
        </button>
      </div>
    </>
  )
}
