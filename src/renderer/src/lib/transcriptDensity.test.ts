import { beforeEach, describe, expect, it } from 'vitest'
import type { ChatItem } from '@shared/types'
import {
  DEFAULT_TRANSCRIPT_DENSITY,
  expandsToolOutput,
  isTranscriptDensity,
  nextTranscriptDensity,
  readRememberedTranscriptDensities,
  rememberTranscriptDensity,
  showsEntry,
  showsInlineDiff,
  transcriptEntryKind,
  type TranscriptDensity,
  type TranscriptEntryKind
} from './transcriptDensity'

const item = (overrides: Partial<ChatItem> & Pick<ChatItem, 'type'>): ChatItem =>
  ({ id: 'i1', ts: 1, ...overrides }) as ChatItem

describe('⌃O 순환', () => {
  it('기본값에서 처음 누르면 Verbose 다 — ⌃O 가 오래도록 "전부 펼치기" 였다', () => {
    expect(DEFAULT_TRANSCRIPT_DENSITY).toBe('normal')
    expect(nextTranscriptDensity('normal')).toBe('verbose')
  })

  it('세 번 누르면 제자리로 돌아온다', () => {
    let d: TranscriptDensity = 'normal'
    for (let i = 0; i < 3; i++) d = nextTranscriptDensity(d)
    expect(d).toBe('normal')
  })

  it('끝에서 처음으로 감는다', () => {
    expect(nextTranscriptDensity('verbose')).toBe('summary')
    expect(nextTranscriptDensity('summary')).toBe('normal')
  })
})

describe('항목을 갈래로 옮긴다', () => {
  it('체크리스트·묶음은 원본 항목 종류보다 먼저 판정한다', () => {
    const use = item({ type: 'tool_use', name: 'TodoWrite', input: {}, toolId: 't1' })
    expect(transcriptEntryKind(use, { todoCard: true })).toBe('todoList')
    expect(transcriptEntryKind(use, { toolGroupHead: true })).toBe('toolGroup')
  })

  it('diff 가 붙은 도구 호출은 "실제로 바꾼 것" 이다', () => {
    const edited = item({
      type: 'tool_use',
      name: 'Bash',
      input: {},
      toolId: 't1',
      diff: '--- a\n+++ b\n+x'
    })
    expect(transcriptEntryKind(edited)).toBe('fileChange')
  })

  it('기록에 diff 가 없어도 편집 도구 이름이면 알아본다', () => {
    const edit = item({ type: 'tool_use', name: 'Edit', input: {}, toolId: 't1' })
    expect(transcriptEntryKind(edit)).toBe('fileChange')
  })

  it('조회성 호출과 그 결과는 같은 갈래다', () => {
    expect(
      transcriptEntryKind(item({ type: 'tool_use', name: 'Read', input: {}, toolId: 't1' }))
    ).toBe('toolCall')
    expect(
      transcriptEntryKind(item({ type: 'tool_result', text: 'x', isError: false, toolId: 't1' }))
    ).toBe('toolCall')
  })

  // 기록에서 사용자의 `!명령` 은 agent 를 아예 달지 않는다(ChatItem 의 `agent?: true`).
  it('명령은 누가 돌렸는지로 갈린다 — `!명령` 은 사용자의 턴이다', () => {
    expect(transcriptEntryKind(item({ type: 'bash', command: 'ls', agent: true }))).toBe(
      'agentBash'
    )
    expect(transcriptEntryKind(item({ type: 'bash', command: 'ls' }))).toBe('userBash')
  })

  it('사고 과정·서브에이전트 카드는 각자의 갈래를 갖는다', () => {
    expect(transcriptEntryKind(item({ type: 'thinking', text: '…' }))).toBe('thinking')
    expect(transcriptEntryKind(item({ type: 'task', description: 'sub' }))).toBe('subagent')
  })

  it('말풍선·오류·시스템 알림은 모두 대화 그 자체다', () => {
    for (const type of ['user', 'assistant', 'error', 'system', 'result', 'compaction'] as const) {
      expect(transcriptEntryKind(item({ type, text: 'x' } as never))).toBe('message')
    }
  })
})

describe('밀도가 무엇을 남기는가', () => {
  const KINDS: TranscriptEntryKind[] = [
    'message',
    'thinking',
    'toolCall',
    'fileChange',
    'toolGroup',
    'todoList',
    'agentBash',
    'userBash',
    'subagent'
  ]

  it('Normal 과 Verbose 는 아무것도 감추지 않는다 — 접기와 감추기는 다른 일이다', () => {
    for (const kind of KINDS) {
      expect(showsEntry('normal', kind)).toBe(true)
      expect(showsEntry('verbose', kind)).toBe(true)
    }
  })

  it('Summary 는 최종 응답과 실제로 바꾼 것, 그리고 사용자가 한 일만 남긴다', () => {
    const kept = KINDS.filter((k) => showsEntry('summary', k))
    expect(kept).toEqual(['message', 'fileChange', 'userBash'])
  })
})

describe('밀도가 도구 카드에 넘기는 파라미터', () => {
  it('도구 출력을 처음부터 펴 두는 건 Verbose 뿐이다', () => {
    expect(expandsToolOutput('verbose')).toBe(true)
    expect(expandsToolOutput('normal')).toBe(false)
    expect(expandsToolOutput('summary')).toBe(false)
  })

  it('Summary 는 변경 목록만 남기고 diff 원문은 접는다', () => {
    expect(showsInlineDiff('summary')).toBe(false)
    expect(showsInlineDiff('normal')).toBe(true)
    expect(showsInlineDiff('verbose')).toBe(true)
  })
})

describe('워크스페이스별 기억', () => {
  beforeEach(() => localStorage.clear())

  it('워크스페이스마다 따로 기억한다 — 훑기 모드의 쓸모가 바로 그것이다', () => {
    rememberTranscriptDensity('ws-a', 'summary')
    rememberTranscriptDensity('ws-b', 'verbose')

    expect(readRememberedTranscriptDensities()).toEqual({ 'ws-a': 'summary', 'ws-b': 'verbose' })
  })

  it('기본값으로 돌아오면 저장하지 않는다 — 손대지 않은 워크스페이스가 쌓이지 않게', () => {
    rememberTranscriptDensity('ws-a', 'summary')
    rememberTranscriptDensity('ws-a', 'normal')

    expect(readRememberedTranscriptDensities()).toEqual({})
  })

  it('남의 키와 깨진 값은 건너뛴다', () => {
    localStorage.setItem('wooi.chatFontScale', '1.2')
    localStorage.setItem('wooi.transcriptDensity.ws-a', 'gigantic')

    expect(readRememberedTranscriptDensities()).toEqual({})
  })

  it('값 검사는 한 곳에서 한다', () => {
    expect(isTranscriptDensity('summary')).toBe(true)
    expect(isTranscriptDensity('SUMMARY')).toBe(false)
    expect(isTranscriptDensity(null)).toBe(false)
  })
})
