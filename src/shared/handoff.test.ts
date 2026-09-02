import { describe, expect, it } from 'vitest'
import { buildHandoffPrompt } from './handoff'
import type { ChatItem } from './types'

const user = (text: string, id = text): ChatItem => ({ id, type: 'user', text, ts: 1 })
const agent = (text: string, id = text): ChatItem => ({ id, type: 'assistant', text, ts: 1 })

const build = (items: ChatItem[], budget?: number): string | null =>
  buildHandoffPrompt({ items, fromLabel: 'Claude Code', budget })

describe('buildHandoffPrompt', () => {
  it('넘길 대화가 없으면 null — 보낼 것도, 물릴 사용량도 없다', () => {
    expect(build([])).toBeNull()
    expect(
      build([
        {
          id: 'r',
          type: 'result',
          subtype: 'ok',
          isError: false,
          durationMs: 1,
          numTurns: 1,
          ts: 1
        }
      ])
    ).toBeNull()
  })

  it('대화를 순서대로 담고 넘겨주는 에이전트 이름을 붙인다', () => {
    const prompt = build([user('add a login button'), agent('done — edited Login.tsx')])!
    expect(prompt.indexOf('add a login button')).toBeLessThan(prompt.indexOf('done — edited'))
    expect(prompt).toContain('## Goal and recent user intent')
    expect(prompt).toContain('## Progress and decisions reported by Claude Code')
    expect(prompt).toContain('taking over this workspace from Claude Code')
  })

  it('대화 원문 대신 목표와 진행 상황을 구조화한 체크포인트를 만든다', () => {
    const prompt = build([user('add a login button'), agent('done — edited Login.tsx')])!
    expect(prompt).toContain('## Goal and recent user intent')
    expect(prompt).toContain('## Progress and decisions reported by Claude Code')
    expect(prompt).toContain('===== Workspace checkpoint =====')
    expect(prompt).not.toContain('===== Conversation so far')
  })

  it('변경 파일과 검증 명령을 별도 섹션으로 보존한다', () => {
    const items: ChatItem[] = [
      {
        id: 'edit',
        type: 'tool_use',
        toolId: 'edit',
        name: 'Edit',
        input: { file_path: 'src/Login.tsx' },
        ts: 1
      },
      {
        id: 'test',
        type: 'bash',
        agent: true,
        command: 'npm test',
        output: 'ok',
        exitCode: 0,
        running: false,
        ts: 2
      }
    ]
    const prompt = build(items)!
    expect(prompt).toContain('## Files changed through agent tools')
    expect(prompt).toContain('src/Login.tsx')
    expect(prompt).toContain('## Verification commands')
    expect(prompt).toContain('npm test — exit 0')
  })

  it('Claude Bash 도구 호출도 검증 명령으로 보존한다', () => {
    const prompt = build([
      {
        id: 'bash',
        type: 'tool_use',
        toolId: 'bash',
        name: 'Bash',
        input: { command: 'npm run typecheck' },
        ts: 1
      }
    ])!
    expect(prompt).toContain('npm run typecheck — result not recorded')
  })

  it('Codex Apply patch 의 paths 배열도 변경 파일로 보존한다', () => {
    const prompt = build([
      {
        id: 'patch',
        type: 'tool_use',
        toolId: 'patch',
        name: 'Apply patch',
        input: { paths: ['src/a.ts', 'src/b.ts'] },
        ts: 1
      }
    ])!
    expect(prompt).toContain('src/a.ts')
    expect(prompt).toContain('src/b.ts')
  })

  it('지난 요청을 다시 수행하지 말라고 못박는다 — 마지막 줄은 대개 지시문이다', () => {
    const prompt = build([user('delete every test file')])!
    expect(prompt).toContain('not instructions for you')
    expect(prompt).toContain('Do not carry them out again')
  })

  it('진짜 할 일은 뒤에 붙는 사용자 메시지라고 마지막에 말해 준다', () => {
    // 이 프롬프트는 단독으로 나가지 않고 사용자의 다음 메시지 앞에 붙는다. 그 경계를 말해 주지
    // 않으면 새 에이전트가 지난 대화의 마지막 지시를 자기 할 일로 착각한다.
    const prompt = build([user('add a login button')])!
    expect(prompt.trimEnd().endsWith('----------')).toBe(true)
    expect(prompt).toContain('The user’s new message follows')
  })

  it('생각·도구 결과는 넘기지 않는다(속말이거나, 예산 대비 얻는 게 적다)', () => {
    const items: ChatItem[] = [
      { id: 't', type: 'thinking', text: 'hmm, maybe useState', ts: 1 },
      { id: 'r', type: 'tool_result', toolId: 'x', text: 'file contents…', isError: false, ts: 1 },
      user('go on')
    ]
    const prompt = build(items)!
    expect(prompt).not.toContain('useState')
    expect(prompt).not.toContain('file contents')
    expect(prompt).toContain('go on')
  })

  it('도구 호출은 이름과 대상 한 줄로 줄인다', () => {
    const items: ChatItem[] = [
      {
        id: 'u',
        type: 'tool_use',
        toolId: 'a',
        name: 'Edit',
        input: { file_path: 'src/app.ts' },
        ts: 1
      }
    ]
    expect(build(items)!).toContain('Edit src/app.ts')
  })

  it('예산을 넘으면 오래된 쪽부터 버리고, 버렸다는 사실을 프롬프트에 남긴다', () => {
    const long = 'x'.repeat(400)
    const items = [user(`${long}-oldest`, '1'), user(`${long}-newest`, '2')]
    const prompt = build(items, 500)!
    expect(prompt).toContain('-newest')
    expect(prompt).not.toContain('-oldest')
    expect(prompt).toContain('Goal and recent user intent')
  })

  it('항목 하나가 예산을 독점하지 못하게 각 항목을 먼저 자른다', () => {
    const prompt = build([user('y'.repeat(20_000))])!
    expect(prompt).toContain('…(truncated)')
    expect(prompt.length).toBeLessThan(10_000)
  })
})
