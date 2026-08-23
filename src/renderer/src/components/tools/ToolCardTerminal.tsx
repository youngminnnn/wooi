import type { ToolCardStyleProps } from './styleProps'
import { SELECTABLE, unlessSelecting } from '../../lib/selection'

/**
 * Claude Code 터미널의 도구 로그 문법을 그대로 옮긴 외형 — 불릿 `⏺` 과 결과 거터 `⎿`.
 *
 * 접는 정책과 요약 문구는 Wooi 스타일과 완전히 같다. 다른 것은 껍데기뿐이라, 둘을 오가며
 * "무엇이 실제로 달라지는가" 를 비교할 수 있다.
 */
export function ToolCardTerminal({
  name,
  summary,
  activity,
  pending,
  open,
  toggle,
  stat,
  result,
  details,
  children
}: ToolCardStyleProps): React.JSX.Element {
  const arg = pending ? activity : summary
  return (
    <div className="font-mono text-sm text-neutral-300">
      <button
        type="button"
        onClick={unlessSelecting(toggle)}
        className={`block w-full break-words text-left hover:text-neutral-100 ${SELECTABLE}`}
      >
        <span className={pending ? 'text-[var(--warning-500)]' : 'text-[var(--accent-400)]'}>
          ⏺
        </span>{' '}
        {/* 이름과 인자는 span 으로 감싼다 — 크로미움은 버튼 자신의 글자에서 드래그 선택을
            시작하지 못해서, 감싸지 않으면 파일 경로·명령을 복사할 수 없다. */}
        <span>
          {name}
          {arg && `(${arg})`}
        </span>
        {stat && (
          <span className="tabular-nums">
            {' '}
            <span className="text-[var(--diff-add)]">+{stat.added}</span>{' '}
            <span className="text-[var(--diff-del)]">−{stat.removed}</span>
          </span>
        )}
      </button>
      {children}
      {result && (
        <div className="flex items-start text-xs text-neutral-500">
          <span className="mr-1 whitespace-pre" aria-hidden>
            {'  ⎿ '}
          </span>
          <div className="min-w-0 flex-1">{result}</div>
        </div>
      )}
      {open && details}
    </div>
  )
}
