import { describe, expect, it } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { MAX_DIFF_LINES_PER_SIDE } from '@shared/diffRenderLimit'
import type { FileDiff, WorkspaceDiff } from '@shared/types'
import { renderWithStore } from '../test/harness'
import DiffView from './DiffView'

function fileDiff(over: Partial<FileDiff> & { path: string }): FileDiff {
  return {
    status: 'modified',
    additions: 0,
    deletions: 0,
    patch: '',
    binary: false,
    ...over
  }
}

function workspaceDiff(files: FileDiff[]): WorkspaceDiff {
  return { baseBranch: 'main', files }
}

/** 상한을 넘기는 patch. 문맥 없이 추가 줄만 넣어 만든다. */
function hugePatch(lines: number): string {
  return `@@ -0,0 +1,${lines} @@\n${Array.from({ length: lines }, (_, i) => `+line ${i}`).join('\n')}\n`
}

const SMALL_PATCH = `@@ -1,2 +1,2 @@\n const a = 1\n-const b = 2\n+const b = 3\n`

describe('DiffView 대용량 폴백', () => {
  it('평범한 파일은 그대로 그린다', () => {
    renderWithStore(
      <DiffView
        diff={workspaceDiff([
          fileDiff({ path: 'src/a.ts', patch: SMALL_PATCH, additions: 1, deletions: 1 })
        ])}
        loading={false}
        baseBranch="main"
      />
    )
    expect(screen.getByText('const b = 3')).toBeTruthy()
    expect(screen.queryByText(/too large to display/)).toBeNull()
  })

  // 이 카드가 없으면 사용자는 앱이 멎는 것으로 대가를 치른다.
  it('상한을 넘으면 diff 대신 카드를 띄우고 숫자로 이유를 댄다', () => {
    const lines = MAX_DIFF_LINES_PER_SIDE + 1
    renderWithStore(
      <DiffView
        diff={workspaceDiff([
          fileDiff({ path: 'dist/bundle.js', patch: hugePatch(lines), additions: lines })
        ])}
        loading={false}
        baseBranch="main"
      />
    )
    // 400 줄이 넘으면 기본으로 접혀 있다 — 펼쳐야 카드가 나온다.
    fireEvent.click(screen.getByTitle('Expand this file'))
    expect(screen.getByText(/too large to display safely/)).toBeTruthy()
    expect(screen.getByText('Line count is over the safe display limit')).toBeTruthy()
    // 세다 멈춘 값은 `+` 를 달고 나온다 — 정확한 값인 척하지 않는다.
    expect(screen.getByText(`${lines.toLocaleString()}+`)).toBeTruthy()
    // 걸린 한계값이 화면에 있어야 "왜 안 보이는지" 가 완성된다.
    expect(screen.getByText(/20,000 lines per side/)).toBeTruthy()
    // 본문은 한 줄도 그리지 않는다.
    expect(screen.queryByText('line 0')).toBeNull()
  })

  it('main 이 본문을 못 실어 온 파일은 읽기 한도를 이유로 보여 준다', () => {
    renderWithStore(
      <DiffView
        diff={workspaceDiff([
          fileDiff({
            path: 'package-lock.json',
            patch: '',
            additions: 8259,
            deletions: 12,
            patchOmitted: 'too-large'
          })
        ])}
        loading={false}
        baseBranch="main"
      />
    )
    fireEvent.click(screen.getByTitle('Expand this file'))
    expect(screen.getByText(/could not be loaded/)).toBeTruthy()
    expect(screen.getByText('Branch diff is over the 32 MB read limit')).toBeTruthy()
    // numstat 만 아는 값이므로 양쪽 면 모두 최소값으로 적는다.
    expect(screen.getByText('8,259+')).toBeTruthy()
  })
})
