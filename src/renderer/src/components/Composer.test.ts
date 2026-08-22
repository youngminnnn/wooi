import { describe, expect, it } from 'vitest'
import {
  matchCodexLocal,
  matchInteractive,
  matchLifecycle,
  matchLocal,
  matchMemory,
  matchPicker,
  matchSideQuestion,
  parseCopyIndex,
  parseMemoryScope
} from './Composer'
import type { CommandPanelKind } from '@shared/types'

describe('백엔드 전용 composer 명령', () => {
  it('Codex에서는 Claude 전용 /memory를 로컬 명령으로 가로채지 않는다', () => {
    expect(matchLocal('/memory', false)).toBeNull()
    expect(matchLocal('/memory', true)).toBe('memory')
  })

  it('side question capability가 없으면 /btw를 가로채지 않는다', () => {
    expect(matchSideQuestion('/btw explain this', false)).toBeNull()
    expect(matchSideQuestion('/btw explain this', true)?.[1]).toBe('explain this')
  })

  it('백엔드 공용 로컬 명령은 그대로 처리한다', () => {
    expect(matchLocal('/diff', false)).toBe('diff')
    expect(matchLocal('/clear', false)).toBe('clear')
  })

  it('/stop 은 백엔드를 가리지 않고 가로챈다', () => {
    expect(matchLocal('/stop', false)).toBe('stop')
    expect(matchLocal('/stop', true)).toBe('stop')
    expect(matchLocal('/wooi:stop dev', false)).toBeNull()
  })

  it('/bashes 별칭을 /tasks 로 해석하고 비슷한 이름은 거부한다', () => {
    expect(matchLocal('/tasks', false)).toBe('tasks')
    expect(matchLocal('/bashes', false)).toBe('tasks')
    expect(matchLocal('/task', false)).toBeNull()
  })

  it('Claude 백엔드에서만 /add-dir을 가로챈다', () => {
    expect(matchLocal('/add-dir ~/notes', false)).toBeNull()
    expect(matchLocal('/add-dir ~/notes', true)).toBe('add-dir')
  })
})

describe('workspace lifecycle commands', () => {
  it('이름을 생략한 /rename 은 인라인 편집 요청으로 처리한다', () => {
    expect(matchLifecycle('/rename')).toEqual({ kind: 'rename', name: null })
    expect(matchLifecycle('/rename   ')).toEqual({ kind: 'rename', name: null })
  })

  it('maps rename and the safety-gated archive/delete commands only as whole inputs', () => {
    expect(matchLifecycle('/rename Better name')).toEqual({ kind: 'rename', name: 'Better name' })
    expect(matchLifecycle('/archive')).toEqual({ kind: 'archive' })
    expect(matchLifecycle('/delete everything')).toEqual({ kind: 'delete' })
    expect(matchLifecycle('please open /archive docs')).toBeNull()
  })
})

describe('Codex account/configuration commands', () => {
  it('intercepts only exact /logout and /plugins commands for Codex', () => {
    expect(matchCodexLocal('/logout', 'codex')).toBe('logout')
    expect(matchCodexLocal('/plugins  ', 'codex')).toBe('plugins')
    expect(matchCodexLocal('/logout now', 'codex')).toBeNull()
    expect(matchCodexLocal('/plugins', 'claude')).toBeNull()
  })
})

describe('Codex conversation-control commands', () => {
  const supported: CommandPanelKind[] = ['status', 'goal', 'plan', 'init']

  it.each(supported)('/%s is intercepted when the backend advertises it', (kind) => {
    expect(matchInteractive(`/${kind}`, supported)?.kind).toBe(kind)
  })

  it('does not intercept unsupported commands or commands with arguments', () => {
    expect(matchInteractive('/goal', [])).toBeNull()
    expect(matchInteractive('/init now', supported)).toBeNull()
  })
})

describe('/copy 인자', () => {
  it('인자가 없으면 가장 최근 응답을 가리킨다', () => {
    expect(parseCopyIndex('/copy')).toBe(1)
    expect(parseCopyIndex('  /copy  ')).toBe(1)
  })

  it('양의 정수를 1-based 인덱스로 읽는다', () => {
    expect(parseCopyIndex('/copy 3')).toBe(3)
  })

  it('양의 정수 하나가 아니면 거부한다', () => {
    for (const command of ['/copy 0', '/copy -1', '/copy abc', '/copy 1.5', '/copy 1 2']) {
      expect(parseCopyIndex(command)).toBeNull()
    }
  })
})

describe('/memory 스코프', () => {
  it('인자가 없으면 카드에서 고르게 한다', () => {
    expect(parseMemoryScope('/memory')).toBe('ask')
    expect(parseMemoryScope('  /memory  ')).toBe('ask')
  })

  it('project와 user 스코프를 읽는다', () => {
    expect(parseMemoryScope('/memory project')).toBe('project')
    expect(parseMemoryScope('/memory user')).toBe('user')
  })

  it('알 수 없는 값과 대소문자가 다른 값은 거부한다', () => {
    expect(parseMemoryScope('/memory global')).toBeNull()
    expect(parseMemoryScope('/memory USER')).toBeNull()
  })
})

describe('선택 카드 슬래시 명령', () => {
  it('고를 에이전트가 둘 이상일 때만 /agent 를 가로챈다', () => {
    expect(matchPicker('/agent', { fast: true, agent: true, plan: true })).toBe('agent')
    // 쓸 수 있는 에이전트가 하나뿐이면 "/agent" 는 카드가 아니라 에이전트에게 보내는 평범한 메시지다.
    expect(matchPicker('/agent', { fast: true, agent: false, plan: true })).toBeNull()
  })

  it('fast mode 미지원 백엔드에서는 /fast 를 가로채지 않는다', () => {
    expect(matchPicker('/fast', { fast: false, agent: true, plan: true })).toBeNull()
    expect(matchPicker('/fast', { fast: true, agent: true, plan: true })).toBe('fast')
  })

  it('/model·/effort 는 뒤따르는 인자와 무관하게 카드를 연다', () => {
    const allow = { fast: false, agent: false, plan: false }
    expect(matchPicker('/model opus', allow)).toBe('model')
    expect(matchPicker('/effort high', allow)).toBe('effort')
    expect(matchPicker('/models', allow)).toBeNull()
  })

  it('권한 모드를 고를 수 있을 때만 /plan 을 가로챈다', () => {
    expect(matchPicker('/plan', { fast: false, agent: false, plan: true })).toBe('plan')
    expect(matchPicker('/plan', { fast: false, agent: false, plan: false })).toBeNull()
  })
})

describe('# 메모리 단축키', () => {
  it('# 뒤의 내용을 기억할 문장으로 뽑는다', () => {
    expect(matchMemory('# always run npm run typecheck')).toBe('always run npm run typecheck')
    expect(matchMemory('#no space')).toBe('no space')
  })

  it('마크다운 제목과 빈 #은 일반 메시지로 둔다', () => {
    expect(matchMemory('## Heading')).toBeNull()
    expect(matchMemory('#')).toBeNull()
    expect(matchMemory('#   ')).toBeNull()
    expect(matchMemory('call the #memory shortcut')).toBeNull()
  })

  it('이슈 초안처럼 #번호로 시작하는 여러 줄 프롬프트는 일반 메시지로 둔다', () => {
    expect(
      matchMemory(
        '#44 Add a branch stack summary to the README\n\n' +
          'https://github.com/youngminnnn/stacked-pr-playground/issues/44\n\n' +
          'Acceptance criteria:\n- Describe the branch relationship.'
      )
    ).toBeNull()
  })
})
