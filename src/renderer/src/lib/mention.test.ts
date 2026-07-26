import { describe, it, expect } from 'vitest'
import { findMention, mentionToken, mentionWithRange, appendMention } from './mention'

/** 커서를 문자열 끝에 둔 흔한 경우. */
const atEnd = (text: string): ReturnType<typeof findMention> => findMention(text, text.length)

describe('findMention', () => {
  it('줄 시작의 @ 를 잡는다', () => {
    expect(atEnd('@src/ma')).toEqual({ query: 'src/ma', at: 0 })
  })

  it('문장 중간의 @ 도 잡고 위치를 정확히 돌려준다', () => {
    const text = 'please review @src/git.ts'
    expect(atEnd(text)).toEqual({ query: 'src/git.ts', at: 14 })
    expect(text.slice(14)).toBe('@src/git.ts')
  })

  it('@ 만 친 상태면 빈 질의로 메뉴를 연다', () => {
    expect(atEnd('look at @')).toEqual({ query: '', at: 8 })
  })

  it('이메일 주소는 멘션으로 보지 않는다', () => {
    expect(atEnd('mail me at foo@bar.com')).toBeNull()
  })

  it('공백이 오면 멘션이 끝난 것으로 본다', () => {
    expect(atEnd('@src/git.ts 리뷰해줘')).toBeNull()
  })

  it('한국어 문장 뒤에 바로 붙은 @ 도 잡는다', () => {
    const text = '이거 봐줘 @README'
    expect(atEnd(text)?.query).toBe('README')
  })

  it('열린 따옴표 안의 공백 포함 경로를 이어서 잡는다', () => {
    expect(atEnd('@"my docs/re')).toEqual({ query: 'my docs/re', at: 0 })
  })

  it('커서 뒤의 텍스트는 질의에 넣지 않는다', () => {
    // "@src|/rest" — 커서가 4번째 뒤에 있으므로 질의는 'src' 까지만.
    expect(findMention('@src/rest', 4)).toEqual({ query: 'src', at: 0 })
  })

  it('이미 완성된 멘션 뒤에서 새 @ 를 독립적으로 잡는다', () => {
    const text = '@a.ts and @b'
    expect(atEnd(text)).toEqual({ query: 'b', at: 10 })
  })
})

describe('mentionToken', () => {
  it('파일은 공백으로 끊어 다음 단어를 이어 쓰게 한다', () => {
    expect(mentionToken({ path: 'src/git.ts', isDir: false })).toBe('@src/git.ts ')
  })

  it('디렉토리는 슬래시로 끝내 하위를 계속 좁히게 한다', () => {
    expect(mentionToken({ path: 'src/main', isDir: true })).toBe('@src/main/')
  })

  it('공백이 든 경로는 따옴표로 감싼다(CLI 가 그 형태만 인식한다)', () => {
    expect(mentionToken({ path: 'my docs/a.md', isDir: false })).toBe('@"my docs/a.md" ')
  })

  it('공백이 든 디렉토리는 따옴표를 열어 둔 채 이어 가게 한다', () => {
    expect(mentionToken({ path: 'my docs', isDir: true })).toBe('@"my docs/')
  })

  it('생성한 토큰을 다시 파싱하면 같은 경로가 나온다(왕복)', () => {
    const token = mentionToken({ path: 'my docs/a.md', isDir: false })
    const text = `see ${token}`
    // 닫힌 따옴표 + 공백이라 멘션은 이미 끝난 상태여야 한다.
    expect(atEnd(text)).toBeNull()
    expect(text).toContain('@"my docs/a.md"')
  })
})

describe('mentionWithRange', () => {
  it('범위가 없으면 경로만 넣는다', () => {
    expect(mentionWithRange('src/git.ts')).toBe('@src/git.ts ')
  })

  it('한 줄만 고르면 #L 하나로 쓴다', () => {
    expect(mentionWithRange('src/git.ts', 17)).toBe('@src/git.ts#L17 ')
  })

  it('여러 줄은 #L시작-끝 으로 쓴다', () => {
    expect(mentionWithRange('src/git.ts', 17, 20)).toBe('@src/git.ts#L17-20 ')
  })

  it('시작과 끝이 같으면 한 줄 형태로 줄인다', () => {
    expect(mentionWithRange('src/git.ts', 5, 5)).toBe('@src/git.ts#L5 ')
  })

  it('공백 경로는 범위까지 따옴표 안에 넣는다', () => {
    expect(mentionWithRange('my docs/a.md', 1, 9)).toBe('@"my docs/a.md#L1-9" ')
  })
})

describe('appendMention', () => {
  it('빈 초안에는 그대로 넣는다', () => {
    expect(appendMention('', '@a.ts ')).toBe('@a.ts ')
  })

  it('앞말과 붙지 않도록 공백을 넣어 준다', () => {
    expect(appendMention('리뷰해줘', '@a.ts ')).toBe('리뷰해줘 @a.ts ')
  })

  it('이미 공백으로 끝나면 중복해서 넣지 않는다', () => {
    expect(appendMention('리뷰해줘 ', '@a.ts ')).toBe('리뷰해줘 @a.ts ')
  })
})
