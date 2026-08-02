import { useEffect } from 'react'
import { useStore } from '../store'
import { CURRENT_FEATURE_TIP, FEATURE_TIP_SEEN, readUiNumber, setUiNumber } from './uiFlags'

export type FeatureTipDecision =
  /** 안내를 띄운다(그리고 봤다고 표시한다). */
  | 'show'
  /** 띄우지 않지만 봤다고 표시한다 — 신규 설치라 알릴 "새 것" 이 없다. */
  | 'mark-seen'
  /** 아무것도 하지 않는다. */
  | 'skip'

/**
 * 새 기능 안내를 띄울지 정한다.
 *
 * 두 가지가 핵심이다:
 *
 * 1. **새로 설치한 사용자에게는 뜨지 않는다.** 그들에겐 새로운 게 아니라 처음부터 있던
 *    기능이고, 온보딩 투어가 이미 앱을 소개한다. 다만 "봤다" 로 표시해 둬야 나중에 안내
 *    번호가 그대로인 채로 뒤늦게 튀어나오지 않는다.
 * 2. **두 번 뜨지 않는다.** 판단 근거를 닫힘 여부가 아니라 안내 번호로 두어, 무시하고
 *    넘어간 사용자에게 매 실행 다시 들이대지 않는다.
 */
export function featureTipDecision(
  onboarded: boolean | undefined,
  seen: number
): FeatureTipDecision {
  // 설정을 아직 못 받았으면(기동 직후) 판단을 미룬다.
  if (onboarded === undefined) return 'skip'
  if (seen >= CURRENT_FEATURE_TIP) return 'skip'
  return onboarded ? 'show' : 'mark-seen'
}

/** 업데이트로 새 기능이 생겼을 때 한 번만 알려 준다. */
export function useFeatureNudge(): void {
  const onboarded = useStore((s) => s.app?.settings.onboarded)
  const pushToast = useStore((s) => s.pushToast)

  useEffect(() => {
    const decision = featureTipDecision(onboarded, readUiNumber(FEATURE_TIP_SEEN))
    if (decision === 'skip') return

    // 띄우는 순간 표시를 남긴다(닫을 때가 아니라). 놓쳐도 기능은 Overview 버튼과 투어로
    // 계속 발견할 수 있으므로, 매 실행 다시 들이대는 것보다 한 번으로 끝내는 편이 낫다.
    setUiNumber(FEATURE_TIP_SEEN, CURRENT_FEATURE_TIP)
    if (decision === 'mark-seen') return

    // 액션이 달린 토스트는 사용자가 닫을 때까지 남는다(store.pushToast 규칙) — 지나가 버리지 않는다.
    pushToast('info', 'New: review a pull request without leaving Wooi.', [
      {
        label: 'Try it',
        run: () => window.dispatchEvent(new Event('wooi:open-pr-review'))
      }
    ])
  }, [onboarded, pushToast])
}
