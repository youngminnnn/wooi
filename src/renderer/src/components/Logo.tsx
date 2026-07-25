/**
 * Wooi 로고 — "wooi" 의 머리글자 W 를 커밋 그래프로 그린 모노그램.
 * 꺾이는 지점마다 커밋 노드가 찍힌 한 줄기 브랜치 선이 갈라졌다 모였다 다시 갈라지는 모양으로,
 * worktree 가 분기해 각자 PR 로 수렴하는 흐름을 나타낸다.
 *
 * 앱 아이콘(build/icon.svg)은 이름의 유래인 한글 "우이"를 그대로 쓴다. 한글 두 글자는 18px
 * 사이드바에서 뭉개지므로, 작은 자리에는 이 축약형 W 를 쓴다 — 워드마크/모노그램 관계다.
 * 그라데이션(파랑→보라)은 양쪽이 동일해 하나의 시스템으로 묶인다.
 */
export default function Logo({ size = 18 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Wooi"
    >
      <defs>
        <linearGradient
          id="wooi-logo-grad"
          gradientUnits="userSpaceOnUse"
          x1="7.5"
          y1="7.5"
          x2="25"
          y2="25"
        >
          <stop offset="0" stopColor="#74acff" />
          <stop offset="1" stopColor="#b08bfa" />
        </linearGradient>
      </defs>
      {/* 브랜치 선 */}
      <path
        d="M4.8 8.3 L10.8 25.3 L16 13.3 L21.2 25.3 L27.2 8.3"
        fill="none"
        stroke="url(#wooi-logo-grad)"
        strokeWidth="3.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* 커밋 노드 */}
      <circle cx="4.8" cy="8.3" r="3.3" fill="url(#wooi-logo-grad)" />
      <circle cx="16" cy="13.3" r="3.3" fill="url(#wooi-logo-grad)" />
      <circle cx="27.2" cy="8.3" r="3.3" fill="url(#wooi-logo-grad)" />
    </svg>
  )
}
