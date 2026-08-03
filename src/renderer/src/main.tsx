import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// highlight.js 토큰 색은 index.css 가 --hl-* 토큰으로 테마별(github-dark/github)로 정의한다.
import './index.css'
import App from './App'
import PaneApp from './PaneApp'
import ErrorBoundary from './components/ErrorBoundary'
import { bootstrapTheme } from './lib/theme'
import { paneKind, paneWorkspaceId } from './lib/paneWindow'

// 권위 있는 설정이 도착하기 전, 캐시된 테마를 첫 페인트 전에 적용한다.
bootstrapTheme()

// 번들은 하나이고 창의 역할만 다르다 — 분리한 패널 창이면 앱 전체 대신 그 패널만 그린다.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* 최후의 방어선 — 여기까지 올라온 예외라도 백지 화면 대신 원인을 보여 준다. */}
    <ErrorBoundary>
      {paneKind ? <PaneApp kind={paneKind} initialWorkspaceId={paneWorkspaceId} /> : <App />}
    </ErrorBoundary>
  </StrictMode>
)
