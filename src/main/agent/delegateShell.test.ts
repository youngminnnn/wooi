import { describe, expect, it } from 'vitest'
import { delegateShellAttempt, delegateShellGuidance } from './delegateShell'

/**
 * 이 가로채기의 값은 "무엇을 잡는가" 보다 **"무엇을 안 잡는가"** 에 있다.
 *
 * 너무 넓게 잡으면 에이전트가 codex 를 조사하거나(`codex --version`) 사용자가 부탁한 무관한
 * 명령까지 막혀, 능력을 뺏는 도구가 된다. 너무 좁으면 실측에서 본 그 명령 하나가 그대로 새어
 * 나간다. 경계를 여기서 못 박는다.
 */

describe('delegateShellAttempt', () => {
  // 실측(dev 트랜스크립트 349b8642)에서 모델이 실제로 돌린 명령이다. 이게 안 잡히면 이 기능은
  // 존재할 이유가 없다.
  it('실제로 새어 나갔던 명령을 잡는다', () => {
    expect(
      delegateShellAttempt('codex exec --cd /tmp/wt --sandbox workspace-write "구현해 줘"')
    ).toBe('codex')
  })

  it.each([
    ['codex e "구현해 줘"', 'codex'],
    ['codex review --base main', 'codex'],
    ['claude -p "리팩터링해 줘"', 'claude'],
    ['claude --print "리팩터링해 줘"', 'claude'],
    ['claude --model opus -p "일해"', 'claude'],
    ['agy -p "일해"', 'antigravity'],
    ['agy --print "일해"', 'antigravity'],
    ['agy --prompt "일해"', 'antigravity'],
    ['agy --model X -p "일해"', 'antigravity'],
    ['env FOO=1 agy -p "일해"', 'antigravity'],
    ['cd foo && agy -p "일해"', 'antigravity']
  ])('%s → %s', (command, backend) => {
    expect(delegateShellAttempt(command)).toBe(backend)
  })

  it('앞에 뭐가 붙어도 잡는다 — 우회가 쉬우면 가로채기가 아니다', () => {
    expect(delegateShellAttempt('cd /tmp && codex exec "일해"')).toBe('codex')
    expect(delegateShellAttempt('npx codex exec "일해"')).toBe('codex')
    expect(delegateShellAttempt('FOO=1 claude -p "일해"')).toBe('claude')
  })

  // 조사는 막지 않는다. 여기서 막으면 모델은 "이 환경에 codex 가 없다" 로 잘못 배우고,
  // 그건 우리가 유도하려는 결론과 정반대다.
  it.each(['codex --version', 'codex --help', 'which codex', 'claude --version', 'man codex'])(
    '조사는 그냥 둔다: %s',
    (command) => {
      expect(delegateShellAttempt(command)).toBeNull()
    }
  )

  it.each([
    'agy --version',
    'agy --help',
    'agy models',
    'agy',
    'agy --print-timeout 30s',
    'agy --prompt-interactive'
  ])('Antigravity 탐색과 대화형 실행은 그냥 둔다: %s', (command) => {
    expect(delegateShellAttempt(command)).toBeNull()
  })

  it.each([
    'git commit -m "codex exec 관련 수정"',
    'echo "claude -p" >> notes.md',
    'echo "agy -p later"',
    'rg "codex exec" src',
    'npm run codex-exec'
  ])('이름만 스치는 명령은 잡지 않는다: %s', (command) => {
    expect(delegateShellAttempt(command)).toBeNull()
  })

  it('빈 명령은 잡지 않는다', () => {
    expect(delegateShellAttempt('   ')).toBeNull()
  })
})

describe('delegateShellGuidance', () => {
  it('팀이면 위임 도구를 지목한다', () => {
    const message = delegateShellGuidance('codex', true, false)
    expect(message).toContain('codex_subagent')
    expect(message).not.toContain('switch_to_agent_team')
  })

  // 이 문장이 이 기능의 전부다 — 모델이 이걸 읽고 같은 턴에 전환 도구를 부른다.
  it('Solo 이고 바꿀 수 있으면 전환 도구를 지목한다', () => {
    const message = delegateShellGuidance('codex', false, true)
    expect(message).toContain('switch_to_agent_team')
    expect(message).toContain('codex_subagent')
  })

  // 대안 없이 막기만 하면 능력을 뺏는 것이다. 사용자에게 넘기라고 말해야 한다.
  it('바꿀 수도 없으면 사용자에게 넘기라고 한다', () => {
    const message = delegateShellGuidance('codex', false, false)
    expect(message).not.toContain('switch_to_agent_team')
    expect(message).toMatch(/tell the user/i)
  })
})
