import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * 렌더 중 예외를 잡아 앱이 통째로 사라지는 것을 막는다.
 *
 * React 는 에러 바운더리가 없으면 예외가 난 순간 **트리 전체를 언마운트**한다 — 화면이 백지가
 * 되고, 원인은 DevTools 콘솔에만 남는다(메인 로그에는 "정상 기동"으로만 보인다). 실제로 zustand
 * 셀렉터가 매 호출마다 새 배열을 돌려줘 무한 렌더에 빠졌을 때 이 증상이 나왔다.
 *
 * 여기서 잡으면 최소한 "무엇이 왜 깨졌는지"와 복구 수단(다시 시도)이 화면에 남는다.
 * 콘솔로도 다시 던져 main 의 console-message 훅이 로그 파일에 남기게 한다.
 */
interface Props {
  children: ReactNode
  /** 어느 영역에서 난 오류인지(예: "Settings"). 메시지와 로그에 함께 남는다. */
  label?: string
}

interface State {
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // main 프로세스가 console-message 로 받아 로그 파일에 남긴다.
    console.error(
      `[${this.props.label ?? 'app'}] render error: ${error.message}\n${info.componentStack ?? ''}`
    )
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="p-4 m-4 rounded-lg border border-[var(--warning-500)]/30 bg-[var(--warning-500)]/10">
        <div className="text-sm font-medium text-[var(--warning-300)]">
          Something broke{this.props.label ? ` in ${this.props.label}` : ''}
        </div>
        <div className="mt-1 text-xs text-neutral-400 break-words">{error.message}</div>
        <button
          onClick={() => this.setState({ error: null })}
          className="mt-3 text-xs px-2.5 py-1 rounded border border-[var(--border)] text-neutral-300 hover:bg-[var(--surface-2)]"
        >
          Try again
        </button>
      </div>
    )
  }
}
