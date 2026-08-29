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

describe('브랜치 총 변경 줄수 칩', () => {
  it('갈라낼 것이 없으면 합계를 그대로 보여 준다', () => {
    renderWithStore(
      <DiffView
        diff={workspaceDiff([
          fileDiff({ path: 'src/a.ts', patch: SMALL_PATCH, additions: 12, deletions: 3 })
        ])}
        loading={false}
        baseBranch="main"
      />
    )
    const chip = screen.getByRole('group', {
      name: 'Branch total: 12 lines added, 3 lines deleted'
    })
    expect(chip.textContent).toBe('+12−3')
  })

  // lock 파일 3천 줄이 섞이면 "이 브랜치가 얼마나 썼나" 라는 숫자가 무의미해진다.
  it('생성 코드와 테스트를 본 숫자에서 빼고 내역으로 남긴다', () => {
    renderWithStore(
      <DiffView
        diff={workspaceDiff([
          fileDiff({ path: 'src/main/git.ts', additions: 100, deletions: 10 }),
          fileDiff({ path: 'src/main/git.test.ts', additions: 50, deletions: 5 }),
          fileDiff({ path: 'package-lock.json', additions: 3000, deletions: 2000 })
        ])}
        loading={false}
        baseBranch="main"
      />
    )
    // 본 숫자는 사람이 쓴 몫만. 3,150 이 아니라 100 이다.
    expect(screen.getByRole('group').textContent).toBe('+100−10')
    // 갈라낸 몫과 전체 합계는 내역에 그대로 남는다 — 갈라내는 것과 숨기는 것은 다르다.
    expect(screen.getByText('Generated')).toBeTruthy()
    expect(screen.getByText('Branch total')).toBeTruthy()
    expect(screen.getByText('+3,150')).toBeTruthy()
  })

  // 리더가 "8,259" 를 숫자 둘로 끊어 읽는다.
  it('접근성 라벨은 자릿수 구분 기호 없는 원시 숫자로 만든다', () => {
    renderWithStore(
      <DiffView
        diff={workspaceDiff([
          fileDiff({ path: 'src/main/git.ts', additions: 8259, deletions: 1200 }),
          fileDiff({ path: 'package-lock.json', additions: 3000, deletions: 2000 })
        ])}
        loading={false}
        baseBranch="main"
      />
    )
    // 화면에는 8,259 로 나오지만 라벨에는 8259 로 들어간다.
    const chip = screen.getByRole('group')
    expect(chip.textContent).toBe('+8,259−1,200')
    expect(chip.getAttribute('aria-label')).toContain(
      'Source: 8259 lines added, 1200 lines deleted'
    )
    expect(chip.getAttribute('aria-label')).toContain(
      'generated: 3000 lines added, 2000 lines deleted'
    )
    expect(chip.getAttribute('aria-label')).not.toContain(',259')
  })
})
