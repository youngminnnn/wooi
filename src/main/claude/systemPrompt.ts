import type { Options } from '@anthropic-ai/claude-agent-sdk'

/**
 * 모델 턴을 도는 모든 query 가 공유하는 시스템 프롬프트 설정.
 *
 * **생략하면 안 된다.** SDK 는 systemPrompt 가 undefined 면 "기본값을 쓴다" 가 아니라 빈
 * 문자열("")을 커스텀 프롬프트로 명시 전송해, CLI 의 기본 프롬프트를 통째로 덮어쓴다
 * (sdk.mjs 의 정규화: `if (i === void 0) f = ""`). 그러면 도구 정의와 settingSources 로 읽은
 * CLAUDE.md 는 그대로 실리지만, Claude Code 의 행동 지침 프로즈(Harness · Session-specific
 * guidance · Memory · Environment · Context management · Delivering work · Corrections —
 * 합쳐 약 11K자)가 전부 빠진다. 같은 모델·같은 도구인데도 작업 진행 방식, 톤, 할 일 관리,
 * 컨텍스트 운용이 터미널 `claude` 와 어긋나는 원인이 이것이다.
 *
 * `{ type: 'preset', preset: 'claude_code' }` 를 주면 SDK 는 커스텀 프롬프트를 비운 채 append
 * 만 전달하고, CLI 가 자기 기본 프롬프트를 그대로 쓴다.
 *
 * append 는 실행 맥락만 얇게 보정한다 — 기본 프롬프트는 터미널 TUI 를 전제로 쓰여 있는데
 * Wooi 는 GUI 라서, 출력이 채팅 버블·마크다운으로 렌더링되고 worktree 가 작업 단위라는
 * 사실만 덧붙인다. 행동 지침을 여기서 덮어쓰지 않는 것이 요점이다(그럴 거면 preset 을 쓰는
 * 의미가 없다).
 *
 * excludeDynamicSections 는 쓰지 않는다 — 여러 사용자가 프롬프트 프리픽스를 공유하는 fleet
 * 에서 캐시를 교차 히트시키려는 옵션이라, 로컬 단일 사용자인 Wooi 에서는 이득 없이 cwd ·
 * 메모리 경로 · git status 컨텍스트만 system 에서 user 메시지로 밀려나 스티어링이 약해진다.
 */
export const CLAUDE_CODE_SYSTEM_PROMPT: Options['systemPrompt'] = {
  type: 'preset',
  preset: 'claude_code',
  append: [
    'You are running inside Wooi, a desktop GUI app, not a terminal TUI.',
    'Your output is rendered as chat messages with markdown, so terminal-only',
    'affordances (ANSI art, cursor control, box drawing for layout) do not apply.',
    'Each conversation runs in a git worktree dedicated to a single task.'
  ].join(' ')
}
