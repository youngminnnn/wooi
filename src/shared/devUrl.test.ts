import { describe, expect, it } from 'vitest'
import { detectDevUrl, isLocalUrl, normalizeInputUrl, previewLabel } from './devUrl'

const ESC = '\u001b'

describe('detectDevUrl', () => {
  it('vite 의 Local 줄에서 주소를 뽑는다', () => {
    const out = [
      '',
      '  VITE v7.0.0  ready in 240 ms',
      '',
      '  ➜  Local:   http://localhost:5173/',
      '  ➜  Network: use --host to expose',
      ''
    ].join('\n')
    expect(detectDevUrl(out)).toBe('http://localhost:5173/')
  })

  it('URL 안쪽에 낀 ANSI 색 코드를 걷어낸다', () => {
    // vite 는 포트만 굵게 칠해 escape 가 URL 중간에 들어간다.
    const out = `  ➜  Local:   ${ESC}[36mhttp://localhost:${ESC}[1m5173${ESC}[22m/${ESC}[39m`
    expect(detectDevUrl(out)).toBe('http://localhost:5173/')
  })

  it('127.0.0.1 도 받는다', () => {
    expect(detectDevUrl('Listening on http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
  })

  it('0.0.0.0 은 접속 가능한 루프백으로 옮긴다', () => {
    expect(detectDevUrl('- Local: http://0.0.0.0:3000')).toBe('http://127.0.0.1:3000')
  })

  it('재시작이 섞인 꼬리 버퍼에서는 마지막 주소를 고른다', () => {
    const out = [
      'Local: http://localhost:3000',
      '[wooi] exited (code 0)',
      'Local: http://localhost:3001'
    ].join('\n')
    expect(detectDevUrl(out)).toBe('http://localhost:3001')
  })

  it('문장 끝에 붙은 마침표는 주소에서 뗀다', () => {
    expect(detectDevUrl('Ready on http://localhost:3000.')).toBe('http://localhost:3000')
  })

  it('포트가 없으면 dev 서버로 보지 않는다', () => {
    expect(detectDevUrl('see http://localhost for details')).toBeNull()
  })

  it('LAN 주소나 외부 주소는 무시한다', () => {
    expect(detectDevUrl('Network: http://192.168.0.5:5173/')).toBeNull()
    expect(detectDevUrl('docs at https://example.com:8443/')).toBeNull()
  })

  it('출력이 비어 있으면 null', () => {
    expect(detectDevUrl('')).toBeNull()
  })
})

describe('normalizeInputUrl', () => {
  it('포트만 치면 localhost 로 채운다', () => {
    expect(normalizeInputUrl('5173')).toBe('http://localhost:5173')
  })

  it('스킴이 없으면 http 를 붙인다', () => {
    expect(normalizeInputUrl('localhost:3000/admin')).toBe('http://localhost:3000/admin')
  })

  it('http/https 가 아닌 스킴은 거절한다', () => {
    expect(normalizeInputUrl('file:///etc/passwd')).toBeNull()
    expect(normalizeInputUrl('javascript:alert(1)')).toBeNull()
  })

  it('빈 입력은 null', () => {
    expect(normalizeInputUrl('   ')).toBeNull()
  })
})

describe('isLocalUrl', () => {
  it('루프백만 로컬로 본다', () => {
    expect(isLocalUrl('http://localhost:3000')).toBe(true)
    expect(isLocalUrl('http://127.0.0.1:3000')).toBe(true)
    expect(isLocalUrl('http://app.localhost:3000')).toBe(true)
    expect(isLocalUrl('https://example.com')).toBe(false)
    expect(isLocalUrl('not a url')).toBe(false)
  })
})

describe('previewLabel', () => {
  it('호스트와 포트로 파일 이름 조각을 만든다', () => {
    expect(previewLabel('http://localhost:5173/foo')).toBe('localhost-5173')
    expect(previewLabel('nope')).toBe('preview')
  })
})
