/**
 * Ditto 로고. "ditto" = 복제/분신 컨셉을 계단식으로 겹쳐 쌓인 둥근 카드(병렬 복제된 workspace)로
 * 표현한다. 뒤로 갈수록 흐려지는 3장의 카드로 "병렬 세션"을 나타내며, 앱 아이콘(build/icon.svg)과
 * 동일한 모티프다. 파랑→보라 그라데이션은 앱의 강조색(파랑 액션, 보라 PR)과 맞춘다.
 */
export default function Logo({ size = 18 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Ditto"
    >
      <defs>
        <linearGradient id="ditto-logo-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#74acff" />
          <stop offset="1" stopColor="#b08bfa" />
        </linearGradient>
        <linearGradient id="ditto-logo-gloss" x1="0.5" y1="0" x2="0.5" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.45" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* 뒤 카드 → 앞 카드 순으로 계단식 배치. 뒤로 갈수록 흐려진다. */}
      <rect
        x="5"
        y="4"
        width="15"
        height="15"
        rx="4.5"
        fill="url(#ditto-logo-grad)"
        opacity="0.3"
      />
      <rect
        x="8.5"
        y="7.5"
        width="15"
        height="15"
        rx="4.5"
        fill="url(#ditto-logo-grad)"
        opacity="0.55"
      />
      <rect x="12" y="11" width="15" height="15" rx="4.5" fill="url(#ditto-logo-grad)" />
      <rect x="12" y="11" width="15" height="15" rx="4.5" fill="url(#ditto-logo-gloss)" />
    </svg>
  )
}
