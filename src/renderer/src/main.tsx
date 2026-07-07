import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'highlight.js/styles/github-dark.css'
import './index.css'
import App from './App'
import { bootstrapTheme } from './lib/theme'

// 권위 있는 설정이 도착하기 전, 캐시된 테마를 첫 페인트 전에 적용한다.
bootstrapTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
