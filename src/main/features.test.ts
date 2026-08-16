import { describe, expect, it } from 'vitest'
import { parseFeatures } from './features'

describe('기능 플래그 파싱', () => {
  it('boolean 만 값으로 받는다', () => {
    expect(parseFeatures('{"remoteAccess":true}')).toEqual({ remoteAccess: true })
    expect(parseFeatures('{"remoteAccess":false}')).toEqual({ remoteAccess: false })
  })

  it('없거나 모양이 다르면 null 이다 — "모른다"와 "꺼짐"은 다르다', () => {
    // null 을 "꺼짐"으로 읽으면 파일을 못 가져온 순간 이미 쓰던 사람에게서 기능이 사라진다.
    // 부르는 쪽이 마지막으로 알던 값을 유지할 수 있어야 한다.
    expect(parseFeatures('{}')).toBeNull()
    expect(parseFeatures('{"remoteAccess":"yes"}')).toBeNull()
    expect(parseFeatures('{"remoteAccess":1}')).toBeNull()
    expect(parseFeatures('{"remoteAccess":null}')).toBeNull()
  })

  it('JSON 이 아니거나 객체가 아니면 null 이다', () => {
    // 이 파일은 앱 밖에서 바뀌는 입력이다. 깨진 값 하나가 기능을 마음대로 열면 안 된다.
    expect(parseFeatures('not json')).toBeNull()
    expect(parseFeatures('[]')).toBeNull()
    expect(parseFeatures('"remoteAccess"')).toBeNull()
    expect(parseFeatures('null')).toBeNull()
  })

  it('모르는 키는 무시하고 아는 것만 읽는다', () => {
    // 나중에 플래그가 늘어나도 옛 버전이 그 파일을 읽고 죽지 않아야 한다.
    expect(parseFeatures('{"remoteAccess":true,"somethingNew":{"a":1}}')).toEqual({
      remoteAccess: true
    })
  })
})
