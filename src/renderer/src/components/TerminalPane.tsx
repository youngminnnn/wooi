import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import type { ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { TerminalSquare, RotateCw } from 'lucide-react'

// xterm 은 CSS 변수를 못 읽으므로 테마별 색을 직접 정의한다. 라이트는 패널 배경(--bg-2)에
// 맞춘 밝은 바탕 + 흰 배경에서도 읽히는 ANSI 팔레트를 쓴다(다크는 xterm 기본 ANSI 로 충분).
const DARK_TERMINAL: ITheme = { background: '#0d0e11', foreground: '#d4d4d8', cursor: '#d4d4d8' }
const LIGHT_TERMINAL: ITheme = {
  background: '#ffffff',
  foreground: '#27272a',
  cursor: '#27272a',
  cursorAccent: '#ffffff',
  selectionBackground: '#bcd4f6',
  black: '#27272a',
  red: '#c0392b',
  green: '#1e7e34',
  yellow: '#b7791f',
  blue: '#2563eb',
  magenta: '#9333ea',
  cyan: '#0e7490',
  white: '#52525b',
  brightBlack: '#71717a',
  brightRed: '#e74c3c',
  brightGreen: '#22a35a',
  brightYellow: '#d69e2e',
  brightBlue: '#3b82f6',
  brightMagenta: '#a855f7',
  brightCyan: '#0891b2',
  brightWhite: '#18181b'
}

/** 현재 <html data-theme> 에 맞는 xterm 테마를 고른다. */
function terminalTheme(): ITheme {
  return document.documentElement.dataset.theme === 'light' ? LIGHT_TERMINAL : DARK_TERMINAL
}

/**
 * 우하단 인터랙티브 터미널. workspace 의 PTY(메인 프로세스)에 붙는다.
 *
 * PTY 는 메인에서 workspace 수명 동안 유지되므로, 이 컴포넌트는 화면(xterm)만 담당한다.
 * 부착 시 메인이 누적 버퍼를 reset 이벤트로 재생해 직전 상태를 복원한다. 입력은 PTY 로
 * 그대로 보내고, 크기는 컨테이너 변화에 맞춰 fit + resize 한다. 언마운트해도 PTY 는 끄지 않는다.
 */
export default function TerminalPane({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [exited, setExited] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontSize: 12,
      fontFamily: "'SF Mono', ui-monospace, 'JetBrains Mono', Menlo, monospace",
      lineHeight: 1.2,
      cursorBlink: true,
      theme: terminalTheme()
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    fitRef.current = fit

    const safeFit = (): { cols: number; rows: number } => {
      try {
        fit.fit()
      } catch {
        // 컨테이너 크기가 0 인 순간 등 — 무시.
      }
      return { cols: term.cols, rows: term.rows }
    }

    // 첫 레이아웃 이후 크기를 잡고 PTY 부착 시작.
    const raf = requestAnimationFrame(() => {
      const { cols, rows } = safeFit()
      void window.api.terminal.start(workspaceId, cols, rows)
    })

    // 사용자 입력 → PTY.
    const inputSub = term.onData((data) => {
      void window.api.terminal.input(workspaceId, data)
    })

    // PTY 출력 → 화면. reset 이면 화면을 비우고 누적 버퍼로 다시 채운다(부착 복원).
    const offData = window.api.terminal.onData((e) => {
      if (e.workspaceId !== workspaceId) return
      if (e.reset) {
        term.reset()
        setExited(false)
      }
      if (e.data) term.write(e.data)
    })

    const offExit = window.api.terminal.onExit((e) => {
      if (e.workspaceId !== workspaceId) return
      setExited(true)
      term.write(`\r\n\x1b[90m[process exited (${e.code ?? '?'})]\x1b[0m\r\n`)
    })

    // 컨테이너 크기 변화 → fit + PTY resize.
    const ro = new ResizeObserver(() => {
      const { cols, rows } = safeFit()
      void window.api.terminal.resize(workspaceId, cols, rows)
    })
    ro.observe(host)

    // 테마 전환(<html data-theme> 변경) → 터미널 색을 다시 적용한다.
    const themeObs = new MutationObserver(() => {
      term.options.theme = terminalTheme()
    })
    themeObs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })

    return () => {
      cancelAnimationFrame(raf)
      inputSub.dispose()
      offData()
      offExit()
      ro.disconnect()
      themeObs.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      // PTY 는 의도적으로 유지한다(다음 부착 시 복원).
    }
  }, [workspaceId])

  const restart = (): void => {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    term.reset()
    setExited(false)
    try {
      fit.fit()
    } catch {
      // 무시.
    }
    void window.api.terminal.start(workspaceId, term.cols, term.rows)
  }

  return (
    <div className="h-full flex flex-col min-h-0 bg-[var(--bg-2)]">
      <div className="h-7 shrink-0 flex items-center gap-1.5 px-3 border-b border-[var(--border)] text-xs text-neutral-500">
        <TerminalSquare size={12} />
        <span>Terminal</span>
        <div className="flex-1" />
        {exited && (
          <button
            onClick={restart}
            className="flex items-center gap-1 text-[var(--success-400)] hover:text-[var(--success-300)]"
            title="Restart shell"
          >
            <RotateCw size={11} /> Restart
          </button>
        )}
      </div>
      <div ref={hostRef} className="flex-1 min-h-0 px-2 py-1 overflow-hidden" />
    </div>
  )
}
