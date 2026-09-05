import { appendFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ARTIFACT_MAX_PER_WORKSPACE, ARTIFACT_MAX_VERSIONS } from '@shared/types'
import { ArtifactError, getArtifacts, resetArtifactsForTest } from './artifacts'

let userData = ''
vi.mock('electron', () => ({ app: { getPath: (): string => userData } }))

beforeAll(() => {
  userData = mkdtempSync(join(tmpdir(), 'wooi-artifacts-test-'))
})
afterAll(() => rmSync(userData, { recursive: true, force: true }))
afterEach(() => {
  resetArtifactsForTest()
  rmSync(join(userData, 'artifacts'), { recursive: true, force: true })
})

const WS = '3f8b1c2e-0a4d-4b1f-9c7e-2d5a6b8c9e10'

function write(id: string, body = '<p>hi</p>', workspaceId = WS) {
  return getArtifacts().write(workspaceId, {
    id,
    kind: 'html',
    title: id,
    files: { 'index.html': body }
  })
}

describe('ArtifactStore', () => {
  it('starts at version 1 and increments on the same id', () => {
    expect(write('counter').version).toBe(1)
    expect(write('counter').version).toBe(2)
    expect(write('other').version).toBe(1)
  })

  it('serves the file that was written, per version', () => {
    write('counter', '<p>v1</p>')
    write('counter', '<p>v2</p>')
    const store = getArtifacts()
    expect(store.readFile(WS, 'counter', 1, 'index.html')).toBe('<p>v1</p>')
    expect(store.readFile(WS, 'counter', 2, 'index.html')).toBe('<p>v2</p>')
  })

  it('does not serve a version that was never written', () => {
    write('counter')
    expect(getArtifacts().readFile(WS, 'counter', 2, 'index.html')).toBeNull()
    expect(getArtifacts().readFile(WS, 'ghost', 1, 'index.html')).toBeNull()
  })

  it('survives a fresh process — the index is on disk, not in memory', () => {
    write('counter', '<p>kept</p>')
    resetArtifactsForTest()
    expect(getArtifacts().readFile(WS, 'counter', 1, 'index.html')).toBe('<p>kept</p>')
  })

  it('skips a torn last line rather than losing the whole index', () => {
    write('a')
    write('b')
    const file = join(userData, 'artifacts', WS, 'index.jsonl')
    // 크래시 중 잘린 append 를 흉내낸다.
    appendFileSync(file, '{"id":"c","vers')
    resetArtifactsForTest()
    expect(
      getArtifacts()
        .list(WS)
        .map((s) => s.id)
        .sort()
    ).toEqual(['a', 'b'])
  })

  it('lists most-recently-updated first, with versions newest-first', () => {
    write('old')
    write('new')
    write('old')
    const list = getArtifacts().list(WS)
    expect(list.map((s) => s.id)).toEqual(['old', 'new'])
    expect(list[0].versions).toEqual([2, 1])
  })

  it('keeps workspaces apart', () => {
    const other = '9a8b7c6d-0000-4000-8000-111122223333'
    write('counter', '<p>mine</p>')
    write('counter', '<p>theirs</p>', other)
    expect(getArtifacts().readFile(WS, 'counter', 1, 'index.html')).toBe('<p>mine</p>')
    expect(getArtifacts().readFile(other, 'counter', 1, 'index.html')).toBe('<p>theirs</p>')
  })

  it('prunes past the version cap and stops serving what it pruned', () => {
    for (let i = 0; i < ARTIFACT_MAX_VERSIONS + 3; i++) write('counter', `<p>${i}</p>`)
    const store = getArtifacts()
    const summary = store.list(WS)[0]
    expect(summary.versions).toHaveLength(ARTIFACT_MAX_VERSIONS)
    expect(summary.versions[0]).toBe(ARTIFACT_MAX_VERSIONS + 3)
    // 잘린 버전은 메타에서도 디스크에서도 사라진다.
    expect(store.readFile(WS, 'counter', 1, 'index.html')).toBeNull()
    expect(existsSync(join(userData, 'artifacts', WS, 'counter', '1'))).toBe(false)
  })

  it('caps how many artifacts one workspace can hold, but never blocks an update', () => {
    for (let i = 0; i < ARTIFACT_MAX_PER_WORKSPACE; i++) write(`a-${i}`)
    expect(() => write('one-too-many')).toThrow(ArtifactError)
    // 상한에 걸렸어도 기존 것을 고치는 길은 열려 있어야 한다.
    expect(write('a-0').version).toBe(2)
  })

  it('removes one artifact without touching its neighbours', () => {
    write('doomed')
    write('kept')
    getArtifacts().removeArtifact(WS, 'doomed')
    expect(
      getArtifacts()
        .list(WS)
        .map((s) => s.id)
    ).toEqual(['kept'])
    expect(getArtifacts().readFile(WS, 'doomed', 1, 'index.html')).toBeNull()
    expect(existsSync(join(userData, 'artifacts', WS, 'doomed'))).toBe(false)
  })

  // 모델은 같은 일에 같은 slug 를 다시 고른다. 묘비가 그 재사용을 죽이면 안 된다.
  it('lets a removed id come back, continuing above the tombstone', () => {
    write('phoenix')
    write('phoenix')
    getArtifacts().removeArtifact(WS, 'phoenix')
    expect(write('phoenix', '<p>reborn</p>').version).toBe(3)
    expect(getArtifacts().list(WS)[0].versions).toEqual([3])
    expect(getArtifacts().readFile(WS, 'phoenix', 3, 'index.html')).toBe('<p>reborn</p>')
    // 지워진 버전의 주소가 되살아나지는 않는다.
    expect(getArtifacts().readFile(WS, 'phoenix', 1, 'index.html')).toBeNull()
  })

  it('removes a whole workspace', () => {
    write('a')
    getArtifacts().remove(WS)
    expect(getArtifacts().list(WS)).toEqual([])
    expect(existsSync(join(userData, 'artifacts', WS))).toBe(false)
  })
})

describe('ArtifactStore path containment', () => {
  // 정규식이 1차 방어선, resolve 뒤 봉쇄가 2차. 어느 쪽이 잡든 디스크에는 아무것도 안 생긴다.
  const escapes = ['../evil', '..', 'a/../../b', 'A-Upper', '_lead', '-lead', '', 'a'.repeat(65)]

  for (const bad of escapes) {
    it(`refuses artifact_id ${JSON.stringify(bad)} and writes nothing`, () => {
      expect(() => write(bad)).toThrow(ArtifactError)
      const root = join(userData, 'artifacts')
      const strays = existsSync(root) ? readdirSync(root) : []
      expect(strays.filter((n) => n !== WS)).toEqual([])
    })
  }

  it('refuses a workspace id outside the slug charset', () => {
    expect(() => write('fine', '<p>x</p>', '../..')).toThrow(ArtifactError)
  })

  it('refuses a bad id on the read path too, not just the write path', () => {
    write('real')
    expect(() => getArtifacts().readFile(WS, '../real', 1, 'index.html')).toThrow(ArtifactError)
  })

  it('never leaves a file outside the artifacts root', () => {
    getArtifacts() // 생성자가 artifacts/ 루트를 만든 뒤를 기준선으로 삼는다.
    const before = readdirSync(userData)
    for (const bad of escapes) {
      try {
        write(bad)
      } catch {
        /* 예상된 거절 */
      }
    }
    expect(readdirSync(userData)).toEqual(before)
  })
})
