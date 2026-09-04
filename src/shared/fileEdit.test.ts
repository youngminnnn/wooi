import { describe, it, expect } from 'vitest'
import type { FileContent } from './types'
import { classifySave, canEditFile, isDraftDirty, detectEol, applyEol } from './fileEdit'

function content(over: Partial<FileContent> = {}): FileContent {
  return { path: 'a.ts', text: 'hello', truncated: false, binary: false, sha: 'aaa', ...over }
}

describe('classifySave', () => {
  it('열었을 때와 디스크가 같으면 쓴다', () => {
    expect(classifySave({ baselineSha: 'aaa', diskSha: 'aaa' })).toEqual({ kind: 'write' })
  })

  it('디스크가 바뀌었으면 stale 로 막는다', () => {
    expect(classifySave({ baselineSha: 'aaa', diskSha: 'bbb' })).toEqual({
      kind: 'conflict',
      conflict: 'stale'
    })
  })

  it('파일이 사라졌으면 stale 이 아니라 vanished 로 구분한다', () => {
    // 사용자에게 "누가 고쳤다" 와 "없어졌다" 는 다른 사건이라 문구도 선택지도 달라야 한다.
    expect(classifySave({ baselineSha: 'aaa', diskSha: null })).toEqual({
      kind: 'conflict',
      conflict: 'vanished'
    })
  })

  it('baseline 이 없으면 비교할 근거가 없으므로 쓰지 않는다', () => {
    expect(classifySave({ baselineSha: null, diskSha: 'aaa' })).toEqual({
      kind: 'conflict',
      conflict: 'stale'
    })
  })

  it('force 는 모든 검사를 건너뛴다 — 경고를 보고 고른 선택이다', () => {
    expect(classifySave({ baselineSha: 'aaa', diskSha: 'bbb', force: true })).toEqual({
      kind: 'write'
    })
    expect(classifySave({ baselineSha: 'aaa', diskSha: null, force: true })).toEqual({
      kind: 'write'
    })
    expect(classifySave({ baselineSha: null, diskSha: null, force: true })).toEqual({
      kind: 'write'
    })
  })
})

describe('canEditFile', () => {
  it('평범한 텍스트 파일은 고칠 수 있다', () => {
    expect(canEditFile(content())).toBe(true)
  })

  it('아직 못 읽은 파일은 고칠 수 없다', () => {
    expect(canEditFile(null)).toBe(false)
  })

  it('바이너리는 고칠 수 없다', () => {
    expect(canEditFile(content({ binary: true, text: '' }))).toBe(false)
  })

  it('잘려서 읽힌 파일은 고칠 수 없다 — 저장하면 안 보이는 뒷부분이 날아간다', () => {
    expect(canEditFile(content({ truncated: true }))).toBe(false)
  })
})

describe('isDraftDirty', () => {
  it('편집을 시작하지 않았으면 dirty 가 아니다', () => {
    expect(isDraftDirty(null, 'hello')).toBe(false)
  })

  it('원본과 같은 내용으로 되돌리면 dirty 가 아니다', () => {
    expect(isDraftDirty('hello', 'hello')).toBe(false)
  })

  it('한 글자라도 다르면 dirty 다', () => {
    expect(isDraftDirty('hellO', 'hello')).toBe(true)
  })

  it('빈 문자열로 지운 것도 변경이다', () => {
    expect(isDraftDirty('', 'hello')).toBe(true)
  })
})

describe('detectEol / applyEol', () => {
  it('LF 파일은 LF 로 본다', () => {
    expect(detectEol('a\nb\n')).toBe('lf')
  })

  it('CRLF 가 하나라도 있으면 CRLF 파일로 본다', () => {
    expect(detectEol('a\r\nb\n')).toBe('crlf')
  })

  it('개행이 없으면 LF 로 본다', () => {
    expect(detectEol('a')).toBe('lf')
  })

  it('CRLF 로 되돌리면 원본과 같아진다 — 안 고친 줄이 diff 에 뜨지 않는다', () => {
    const original = 'a\r\nb\r\nc\r\n'
    // textarea 가 LF 로 정규화한 값
    const asTextarea = original.replace(/\r\n/g, '\n')
    expect(applyEol(asTextarea, detectEol(original))).toBe(original)
  })

  it('CR 을 두 번 붙이지 않는다', () => {
    expect(applyEol('a\r\nb', 'crlf')).toBe('a\r\nb')
  })

  it('LF 로 내리면 CR 이 남지 않는다', () => {
    expect(applyEol('a\r\nb', 'lf')).toBe('a\nb')
  })
})
