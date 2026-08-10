import { describe, it, expect } from 'vitest'
import { compareVersions, parseNotices, parseVersion } from './notice'

const NOW = Date.parse('2026-08-02T00:00:00Z')
const VERSION = '1.2.0'

const doc = (...notices: unknown[]): string => JSON.stringify({ notices })

describe('parseVersion / compareVersions', () => {
  it('v 접두사와 prerelease 꼬리표를 무시하고 세 칸을 읽는다', () => {
    expect(parseVersion('v1.2.3-beta.1')).toEqual([1, 2, 3])
    expect(parseVersion('2')).toEqual([2, 0, 0])
    expect(parseVersion('없음')).toBeNull()
  })

  it('자리별로 숫자 비교한다(문자열 비교가 아니다)', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0)
    expect(compareVersions('1.2.0', '1.2.0')).toBe(0)
    expect(compareVersions('1.2.0', '1.2.1')).toBeLessThan(0)
  })

  it('읽을 수 없는 버전은 "같음"으로 봐서 공지를 거르지 않는다', () => {
    expect(compareVersions('1.2.0', 'garbage')).toBe(0)
  })
})

describe('parseNotices', () => {
  it('id 와 message 가 있는 공지를 통과시키고 level 기본값은 info 다', () => {
    const out = parseNotices(doc({ id: 'a', message: '점검 예정' }), NOW, VERSION)
    expect(out).toEqual([
      { id: 'a', level: 'info', message: '점검 예정', link: undefined, action: undefined }
    ])
  })

  it('id 나 message 가 없거나 level 이 이상한 항목은 버리거나 정규화한다', () => {
    const out = parseNotices(
      doc(
        { message: 'id 없음' },
        { id: 'b' },
        { id: 'c', message: 'ok', level: 'nope' },
        'not-an-object'
      ),
      NOW,
      VERSION
    )
    expect(out.map((n) => n.id)).toEqual(['c'])
    expect(out[0].level).toBe('info')
  })

  it('깨진 JSON 이나 예상 밖 구조에서도 던지지 않고 빈 배열을 준다', () => {
    expect(parseNotices('{{{', NOW, VERSION)).toEqual([])
    expect(parseNotices('{"hello":1}', NOW, VERSION)).toEqual([])
  })

  it('최상위가 배열인 형태도 받아 준다', () => {
    const out = parseNotices(JSON.stringify([{ id: 'a', message: 'ok' }]), NOW, VERSION)
    expect(out).toHaveLength(1)
  })

  it('기간(startsAt/endsAt) 밖의 공지는 숨긴다 — 경계는 포함이다', () => {
    const before = { id: 'before', message: 'x', startsAt: '2026-08-03T00:00:00Z' }
    const after = { id: 'after', message: 'x', endsAt: '2026-08-01T00:00:00Z' }
    const during = {
      id: 'during',
      message: 'x',
      startsAt: '2026-08-01T00:00:00Z',
      endsAt: '2026-08-03T00:00:00Z'
    }
    const edge = { id: 'edge', message: 'x', startsAt: '2026-08-02T00:00:00Z' }
    const out = parseNotices(doc(before, after, during, edge), NOW, VERSION)
    expect(out.map((n) => n.id)).toEqual(['during', 'edge'])
  })

  it('읽을 수 없는 날짜는 조건이 없는 것으로 본다', () => {
    const out = parseNotices(doc({ id: 'a', message: 'x', startsAt: '내일' }), NOW, VERSION)
    expect(out).toHaveLength(1)
  })

  it('minVersion / maxVersion 으로 버전 범위를 거른다', () => {
    const notices = [
      { id: 'old-only', message: 'x', maxVersion: '1.1.0' },
      { id: 'new-only', message: 'x', minVersion: '1.3.0' },
      { id: 'range', message: 'x', minVersion: '1.0.0', maxVersion: '1.2.0' }
    ]
    const out = parseNotices(doc(...notices), NOW, VERSION)
    expect(out.map((n) => n.id)).toEqual(['range'])
  })

  it('http/https 가 아닌 링크는 떨어뜨리고 공지 자체는 남긴다', () => {
    const bad = parseNotices(
      doc({ id: 'a', message: 'x', link: { label: 'go', url: 'javascript:alert(1)' } }),
      NOW,
      VERSION
    )
    expect(bad[0].link).toBeUndefined()

    const ok = parseNotices(
      doc({ id: 'b', message: 'x', link: { label: 'go', url: 'https://wooi.app/blog' } }),
      NOW,
      VERSION
    )
    expect(ok[0].link).toEqual({ label: 'go', url: 'https://wooi.app/blog' })
  })

  it('내장 allowlist 동작만 통과시킨다', () => {
    const ok = parseNotices(
      doc({
        id: 'a',
        message: 'x',
        action: { type: 'enableAutoResumeAfterRateLimit', label: 'Enable' }
      }),
      NOW,
      VERSION
    )
    expect(ok[0].action).toEqual({ type: 'enableAutoResumeAfterRateLimit', label: 'Enable' })

    const bad = parseNotices(
      doc({ id: 'b', message: 'x', action: { type: 'setAnySetting', label: 'Run' } }),
      NOW,
      VERSION
    )
    expect(bad[0].action).toBeUndefined()
  })

  it('같은 id 가 두 번 오면 첫 건만 남는다(닫음 기억이 섞이지 않게)', () => {
    const out = parseNotices(
      doc({ id: 'a', message: '먼저' }, { id: 'a', message: '나중' }),
      NOW,
      VERSION
    )
    expect(out).toHaveLength(1)
    expect(out[0].message).toBe('먼저')
  })

  it('아주 긴 메시지는 잘라 낸다', () => {
    const out = parseNotices(doc({ id: 'a', message: 'x'.repeat(1000) }), NOW, VERSION)
    expect(out[0].message).toHaveLength(300)
  })

  it('공지가 아무리 많아도 10건까지만 들고 온다', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, message: 'x' }))
    expect(parseNotices(doc(...many), NOW, VERSION)).toHaveLength(10)
  })
})
