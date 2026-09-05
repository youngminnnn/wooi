import { describe, expect, it } from 'vitest'
import { artifactUrl, parseArtifactUrl, vendorUrl } from './artifactUrl'

const WS = '3f8b1c2e-0a4d-4b1f-9c7e-2d5a6b8c9e10'

describe('artifactUrl', () => {
  it('round-trips an artifact document url', () => {
    const url = artifactUrl(WS, 'sales-dashboard', 3)
    expect(url).toBe(`wooi-artifact://a/w/${WS}/sales-dashboard/3/index.html`)
    expect(parseArtifactUrl(url)).toEqual({
      kind: 'artifact',
      workspaceId: WS,
      artifactId: 'sales-dashboard',
      version: 3,
      file: 'index.html'
    })
  })

  it('round-trips the sibling files a document links', () => {
    for (const file of ['module.js', 'style.css'] as const) {
      const parsed = parseArtifactUrl(artifactUrl(WS, 'counter', 1, file))
      expect(parsed).toMatchObject({ kind: 'artifact', file })
    }
  })

  it('round-trips a vendor url', () => {
    expect(parseArtifactUrl(vendorUrl('react-dom-client.js'))).toEqual({
      kind: 'vendor',
      file: 'react-dom-client.js'
    })
  })

  // 경로 탈출은 정규식이 1차 방어선이다. 2차(path.resolve 봉쇄)는 [[main/artifacts]] 쪽 테스트.
  it('refuses traversal, in raw and percent-encoded form', () => {
    for (const bad of [
      `wooi-artifact://a/w/${WS}/../../etc/passwd/1/index.html`,
      `wooi-artifact://a/w/${WS}/..%2f..%2fpasswd/1/index.html`,
      `wooi-artifact://a/w/${WS}/%2e%2e/1/index.html`,
      `wooi-artifact://a/w/${WS}//1/index.html`,
      `wooi-artifact://a/v/../../../.zshrc`
    ]) {
      expect(parseArtifactUrl(bad), bad).toBeNull()
    }
  })

  it('refuses ids outside the slug charset', () => {
    for (const bad of ['Sales', 'a_b', '-lead', 'ünicode', 'a'.repeat(65)]) {
      expect(parseArtifactUrl(artifactUrl(WS, bad, 1)), bad).toBeNull()
    }
  })

  it('refuses a file it does not serve', () => {
    expect(parseArtifactUrl(`wooi-artifact://a/w/${WS}/x/1/index.js`)).toBeNull()
    expect(parseArtifactUrl(`wooi-artifact://a/w/${WS}/x/1/`)).toBeNull()
  })

  it('refuses non-positive and oversized versions', () => {
    for (const v of ['0', '-1', '01', '1.5', '999999']) {
      expect(parseArtifactUrl(`wooi-artifact://a/w/${WS}/x/${v}/index.html`), v).toBeNull()
    }
  })

  it('refuses another scheme, another host, and query/fragment smuggling', () => {
    expect(parseArtifactUrl(`file:///w/${WS}/x/1/index.html`)).toBeNull()
    expect(parseArtifactUrl(`wooi-artifact://evil/w/${WS}/x/1/index.html`)).toBeNull()
    expect(parseArtifactUrl(`wooi-artifact://a/w/${WS}/x/1/index.html?a=1`)).toBeNull()
    expect(parseArtifactUrl(`wooi-artifact://a/w/${WS}/x/1/index.html#f`)).toBeNull()
  })

  it('refuses garbage that is not a url at all', () => {
    for (const bad of ['', 'not a url', 'wooi-artifact://a', 'wooi-artifact://a/']) {
      expect(parseArtifactUrl(bad), bad).toBeNull()
    }
  })
})
