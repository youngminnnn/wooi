import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFileChangeDiff, isFileChangeTool } from './editDiff'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wooi-diff-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 줄 번호가 있는 diff 를 만들기 위한 소재 — 앞뒤 맥락이 충분히 길어야 헝크가 의미 있다. */
const SAMPLE = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'].join('\n') + '\n'

function file(name: string, content: string): string {
  const path = join(dir, name)
  writeFileSync(path, content)
  return path
}

describe('isFileChangeTool', () => {
  it('파일을 바꾸는 도구만 참이다', () => {
    expect(isFileChangeTool('Edit')).toBe(true)
    expect(isFileChangeTool('MultiEdit')).toBe(true)
    expect(isFileChangeTool('Write')).toBe(true)
    expect(isFileChangeTool('NotebookEdit')).toBe(true)
    expect(isFileChangeTool('Bash')).toBe(false)
    expect(isFileChangeTool('Read')).toBe(false)
  })
})

describe('buildFileChangeDiff — Edit', () => {
  it('디스크 내용을 기준으로 줄 번호와 맥락이 있는 헝크를 만든다', () => {
    const path = file('a.txt', SAMPLE)
    const diff = buildFileChangeDiff(
      'Edit',
      { file_path: path, old_string: 'four', new_string: 'FOUR' },
      dir
    )
    expect(diff).not.toBeNull()
    expect(diff).toContain('--- a/a.txt') // cwd 안이면 상대 경로로 줄인다
    expect(diff).toContain('-four')
    expect(diff).toContain('+FOUR')
    expect(diff).toContain('@@ -1,7 +1,7 @@') // 맥락 3줄 + 변경 1줄
    // 맥락 밖(8번째 줄)은 헝크에 들어오지 않는다.
    expect(diff).not.toContain('eight')
  })

  it('replace_all 은 모든 일치를 바꾼 결과를 보여 준다', () => {
    const path = file('b.txt', 'x\nx\nkeep\n')
    const diff = buildFileChangeDiff(
      'Edit',
      { file_path: path, old_string: 'x', new_string: 'y', replace_all: true },
      dir
    )
    expect(diff).not.toBeNull()
    expect((diff as string).match(/^\+y$/gm)?.length).toBe(2)
  })

  it('replace_all 없이는 첫 일치만 바꾼다', () => {
    const path = file('c.txt', 'x\nx\nkeep\n')
    const diff = buildFileChangeDiff(
      'Edit',
      { file_path: path, old_string: 'x', new_string: 'y' },
      dir
    )
    expect((diff as string).match(/^\+y$/gm)?.length).toBe(1)
  })

  it('디스크에서 old_string 을 찾지 못하면 맥락 없는 폴백 diff 를 만든다', () => {
    const path = file('d.txt', SAMPLE)
    const diff = buildFileChangeDiff(
      'Edit',
      { file_path: path, old_string: 'nowhere', new_string: 'here' },
      dir
    )
    expect(diff).toContain('@@ proposed change @@')
    expect(diff).toContain('-nowhere')
    expect(diff).toContain('+here')
  })

  it('파일이 없어도 입력만으로 diff 를 만든다', () => {
    const diff = buildFileChangeDiff(
      'Edit',
      { file_path: join(dir, 'missing.txt'), old_string: 'a', new_string: 'b' },
      dir
    )
    expect(diff).toContain('-a')
    expect(diff).toContain('+b')
  })
})

describe('buildFileChangeDiff — MultiEdit', () => {
  it('편집을 순서대로 적용한 최종 상태를 하나의 diff 로 만든다', () => {
    const path = file('e.txt', Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n')
    const diff = buildFileChangeDiff(
      'MultiEdit',
      {
        file_path: path,
        edits: [
          { old_string: 'line 2', new_string: 'TWO' },
          { old_string: 'line 30', new_string: 'THIRTY' }
        ]
      },
      dir
    )
    expect(diff).toContain('-line 2')
    expect(diff).toContain('+TWO')
    expect(diff).toContain('-line 30')
    expect(diff).toContain('+THIRTY')
    // 멀리 떨어진 두 변경은 각자의 헝크가 되고, 사이의 줄들은 diff 에서 빠진다.
    expect((diff as string).match(/^@@/gm)?.length).toBe(2)
    expect(diff).not.toContain('line 15')
  })

  it('가까운 두 변경은 맥락이 겹쳐 하나의 헝크로 합쳐진다', () => {
    const path = file('e2.txt', SAMPLE)
    const diff = buildFileChangeDiff(
      'MultiEdit',
      {
        file_path: path,
        edits: [
          { old_string: 'two', new_string: 'TWO' },
          { old_string: 'seven', new_string: 'SEVEN' }
        ]
      },
      dir
    )
    expect((diff as string).match(/^@@/gm)?.length).toBe(1)
  })
})

describe('buildFileChangeDiff — Write', () => {
  it('새 파일은 전부 추가 줄이다', () => {
    const diff = buildFileChangeDiff(
      'Write',
      { file_path: join(dir, 'new.txt'), content: 'hello\nworld\n' },
      dir
    )
    expect(diff).toContain('+hello')
    expect(diff).toContain('+world')
    // 삭제 줄이 하나도 없어야 한다(`---` 헤더는 제외).
    expect(/^-(?!--)/m.test(diff as string)).toBe(false)
    expect(diff).toContain('@@ -0,0 +1,2 @@')
  })

  it('기존 파일은 바뀐 줄만 헝크로 보여 준다', () => {
    const path = file('f.txt', SAMPLE)
    const diff = buildFileChangeDiff(
      'Write',
      { file_path: path, content: SAMPLE.replace('five', 'FIVE') },
      dir
    )
    expect(diff).toContain('-five')
    expect(diff).toContain('+FIVE')
    expect(diff).toContain(' four')
  })

  it('내용이 같으면 diff 가 없다', () => {
    const path = file('g.txt', SAMPLE)
    expect(buildFileChangeDiff('Write', { file_path: path, content: SAMPLE }, dir)).toBeNull()
  })
})

describe('buildFileChangeDiff — 기타', () => {
  it('NotebookEdit 는 새 셀 소스를 추가 블록으로 보여 준다', () => {
    const diff = buildFileChangeDiff(
      'NotebookEdit',
      { notebook_path: join(dir, 'n.ipynb'), cell_id: 'c1', new_source: 'print(1)' },
      dir
    )
    expect(diff).toContain('cell c1')
    expect(diff).toContain('+print(1)')
  })

  it('파일 변경이 아닌 도구는 null 이다', () => {
    expect(buildFileChangeDiff('Bash', { command: 'ls' }, dir)).toBeNull()
  })

  it('경로가 없으면 null 이다', () => {
    expect(buildFileChangeDiff('Write', { content: 'x' }, dir)).toBeNull()
  })

  it('아주 큰 변경은 잘라내고 안내를 붙인다', () => {
    const content = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n')
    const diff = buildFileChangeDiff('Write', { file_path: join(dir, 'big.txt'), content }, dir)
    expect((diff as string).split('\n').length).toBeLessThan(700)
    expect(diff).toContain('more diff lines')
  })

  it('cwd 밖의 경로는 절대 경로 그대로 보여 준다', () => {
    const outside = mkdtempSync(join(tmpdir(), 'wooi-outside-'))
    try {
      const path = join(outside, 'h.txt')
      const diff = buildFileChangeDiff('Write', { file_path: path, content: 'x\n' }, dir)
      expect(diff).toContain(`--- a/${path}`)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
