import { useEffect, useMemo, useRef, useState } from 'react'
import { ShieldQuestion, Clock } from 'lucide-react'
import { useStore } from '../store'
import { summarizePermission } from '../lib/permission'
import { unlessSelecting } from '../lib/selection'
import { DiffLine } from './DiffView'
import type { PermissionDecision, PermissionOption, PermissionRequest } from '@shared/types'

/** 대기 시간이 이 값을 넘으면 "얼마나 멈춰 있었는지"를 프롬프트에 노출한다(오래 방치 인지용). */
const SHOW_WAIT_AFTER_MS = 20_000

/**
 * 백엔드가 선택지를 주지 않았을 때의 기본 결정지(Claude 경로).
 * 배열의 **마지막 항목이 기본 동작**으로 강조되고 포커스를 받는다.
 *
 * "다시 묻지 않기" 는 두 갈래다 — 이번 세션만(Always), 리포에 저장해 다음에도(Always in project).
 * 무엇이 열리는지는 `request.rule`(예: `Bash(npm run:*)`)이 말해 준다.
 */
function defaultOptions(rule: string | undefined): PermissionOption[] {
  const what = rule ?? 'this'
  return [
    { id: 'deny', label: 'Deny', behavior: 'deny' },
    {
      id: 'allowAlways',
      label: 'Always',
      behavior: 'allow',
      rememberForSession: true,
      rememberScope: 'session',
      description: `Allow ${what} for the rest of this session`
    },
    {
      id: 'allowProject',
      label: 'Always in project',
      behavior: 'allow',
      rememberForSession: true,
      rememberScope: 'project',
      description: `Allow ${what} from now on — saved to this repo's .claude/settings.local.json`
    },
    { id: 'allow', label: 'Allow', behavior: 'allow' }
  ]
}

export default function PermissionPrompt({
  request
}: {
  request: PermissionRequest
}): React.JSX.Element {
  const dismiss = useStore((s) => s.dismissPermission)
  const primaryRef = useRef<HTMLButtonElement>(null)
  // 이 프롬프트가 처음 뜬 시각. 자리를 비운 사이 얼마나 블로킹됐는지 보여 주기 위해 경과를 계산한다.
  // (렌더 중 Date.now() 호출을 피하려 0 으로 두고, 마운트 이펙트에서 실제 시각을 채운다.)
  const shownAtRef = useRef(0)
  const [elapsedMs, setElapsedMs] = useState(0)
  useEffect(() => {
    shownAtRef.current = Date.now()
    setElapsedMs(0)
    const t = setInterval(() => setElapsedMs(Date.now() - shownAtRef.current), 1000)
    return () => clearInterval(t)
  }, [request.requestId])
  const waiting = elapsedMs >= SHOW_WAIT_AFTER_MS
  const waitLabel = (() => {
    const s = Math.floor(elapsedMs / 1000)
    const m = Math.floor(s / 60)
    return m > 0 ? `${m}m ${s % 60}s` : `${s}s`
  })()

  // 선택지는 백엔드가 정한다 — Codex 는 서버가 제시한 결정지를 그대로 싣고, Claude 는 없으므로
  // 기존 Deny/Always allow/Allow 로 떨어진다.
  const options = useMemo(
    () => (request.options?.length ? request.options : defaultOptions(request.rule)),
    [request.options, request.rule]
  )
  const primary = options[options.length - 1]

  const respond = (option: PermissionOption): void => {
    const decision: PermissionDecision =
      option.behavior === 'allow'
        ? {
            behavior: 'allow',
            rememberForSession: option.rememberForSession,
            rememberScope: option.rememberScope,
            optionId: option.id
          }
        : { behavior: 'deny', optionId: option.id }
    void window.api.permission.respond(request.requestId, decision)
    dismiss(request.requestId)
  }

  // 고빈도 인터랙션이라 키보드를 지원한다: 기본 동작에 포커스(Enter/Space), Esc=거부.
  useEffect(() => {
    primaryRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      // Esc 는 항상 "거부"여야 한다. 백엔드가 거부 선택지를 주지 않았다면(이론상) 아무것도 하지 않는다.
      const deny = options.find((o) => o.behavior === 'deny')
      if (deny) respond(deny)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // requestId 가 바뀌면(다음 권한 요청) 다시 포커스/바인딩.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.requestId, options])

  const heading = request.title ?? `Allow ${request.displayName ?? request.toolName}?`
  // 파일 변경은 diff 자체가 판단 근거라, 입력 요약 대신 diff 를 보여 준다.
  const detail = request.diff ? null : summarizePermission(request)

  return (
    <div className="shrink-0 mx-4 mb-2 rounded-xl border border-[var(--warning-500)]/30 bg-[var(--warning-500)]/10 px-3.5 py-2.5 shadow-lg">
      <div className="flex items-start gap-2.5">
        <ShieldQuestion size={16} className="text-[var(--warning-400)] mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm text-neutral-100">{heading}</span>
            {waiting && (
              <span
                className="flex items-center gap-1 text-[11px] text-[var(--warning-300)]/80 tabular-nums"
                title="This request has been waiting for your response. Esc denies (skips) it."
              >
                <Clock size={11} />
                waiting {waitLabel}
              </span>
            )}
          </div>
          {detail && (
            <pre className="mt-1 text-xs text-neutral-400 whitespace-pre-wrap break-all max-h-24 overflow-y-auto">
              {detail}
            </pre>
          )}
          {request.diff && <DiffPreview diff={request.diff} />}
          {/* 좁혀진 규칙일 때만 노출한다 — 도구 이름뿐인 규칙은 "Always" 의 뜻이 이미 자명하다. */}
          {request.rule?.includes('(') && (
            <p className="mt-1.5 text-[11px] text-neutral-500">
              Always applies to{' '}
              <code className="rounded bg-[var(--surface-2)] px-1 py-0.5 font-mono text-neutral-400">
                {request.rule}
              </code>
            </p>
          )}
          {/* 서버가 이유를 준 경우(왜 승인이 필요한지) diff 아래에 덧붙인다. */}
          {request.diff && request.decisionReason && (
            <p className="mt-1.5 text-xs text-neutral-500">{request.decisionReason}</p>
          )}
        </div>
        {/* 보조 동작과 기본 동작(마지막 항목)을 시각적으로 분리해 위계를 분명히 한다. */}
        <div className="flex flex-wrap items-center justify-end gap-1 shrink-0">
          {options.slice(0, -1).map((option) => (
            <button
              key={option.id}
              onClick={unlessSelecting(() => respond(option))}
              title={option.description}
              className={
                'text-sm px-2.5 py-1 rounded-md ' +
                (option.rememberForSession
                  ? 'text-[var(--warning-300)] hover:bg-[var(--warning-500)]/15'
                  : 'text-neutral-300 hover:bg-[var(--surface-2)] hover:text-neutral-100')
              }
            >
              {option.label}
            </button>
          ))}
          {options.length > 1 && (
            <span aria-hidden className="mx-0.5 h-5 w-px bg-[var(--warning-500)]/25" />
          )}
          <button
            ref={primaryRef}
            onClick={unlessSelecting(() => respond(primary))}
            className="text-sm px-3 py-1 rounded-md bg-[var(--warning-500)]/90 text-black font-medium shadow-sm hover:bg-[var(--warning-400)] focus:outline-none focus:ring-2 focus:ring-[var(--warning-300)]/60"
          >
            {primary.label}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * 승인 대기 중인 패치의 diff 미리보기.
 *
 * 프롬프트는 입력창 위에 얹히는 좁은 영역이라 높이를 제한하고 스크롤한다 — 큰 패치 때문에
 * 버튼이 화면 밖으로 밀려나면 승인 자체를 못 하게 된다.
 */
function DiffPreview({ diff }: { diff: string }): React.JSX.Element {
  const lines = diff.split('\n')
  return (
    <pre className="mt-1.5 max-h-48 overflow-auto rounded-md bg-[var(--code-bg)] py-1 text-xs font-mono leading-[1.45]">
      {lines.map((line, i) => (
        <DiffLine key={i} line={line} />
      ))}
    </pre>
  )
}
