import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MAX_DIFF_LINES_PER_SIDE } from '@shared/diffRenderLimit'
import type { FileDiff, WorkspaceDiff } from '@shared/types'
import { renderWithStore } from '../test/harness'
import type { DiffCommentAnchor } from '../lib/diffComments'
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

describe('변경 지점 간 이동', () => {
  afterEach(() => vi.restoreAllMocks())

  /** hunk 두 개짜리 patch. hunk 하나가 곧 변경 덩어리다. */
  const TWO_HUNKS = `@@ -1,2 +1,2 @@\n a\n-b\n+c\n@@ -10,2 +10,2 @@\n d\n-e\n+f\n`

  it('덩어리가 없으면 버튼을 비활성화한다', () => {
    renderWithStore(<DiffView diff={workspaceDiff([])} loading={false} baseBranch="main" />)
    // 변경이 없으면 DiffView 자체가 빈 화면이라 버튼도 없다.
    expect(screen.queryByLabelText('Next change')).toBeNull()
  })

  it('그려진 덩어리가 없으면(전부 접힘) 버튼이 비활성화된다', () => {
    renderWithStore(
      <DiffView
        diff={workspaceDiff([
          // 400 줄이 넘어 기본으로 접힌다 — 접힌 파일에는 뛸 자리가 없다.
          fileDiff({ path: 'src/a.ts', patch: TWO_HUNKS, additions: 500, deletions: 100 })
        ])}
        loading={false}
        baseBranch="main"
      />
    )
    expect(screen.getByLabelText('Next change')).toBeDisabled()
    expect(screen.getByLabelText('Previous change')).toBeDisabled()
  })

  it('덩어리 수를 세어 버튼을 켠다', () => {
    renderWithStore(
      <DiffView
        diff={workspaceDiff([
          fileDiff({ path: 'src/a.ts', patch: TWO_HUNKS, additions: 2, deletions: 2 })
        ])}
        loading={false}
        baseBranch="main"
      />
    )
    const next = screen.getByLabelText('Next change')
    expect(next).toBeEnabled()
    expect(next.getAttribute('title')).toBe('Next change (F7) — 2 changes in view')
  })

  it('다음/이전으로 덩어리를 하나씩 옮겨 다닌다', () => {
    const scrollTo = vi.spyOn(Element.prototype, 'scrollIntoView')
    renderWithStore(
      <DiffView
        diff={workspaceDiff([
          fileDiff({ path: 'src/a.ts', patch: TWO_HUNKS, additions: 2, deletions: 2 })
        ])}
        loading={false}
        baseBranch="main"
      />
    )
    fireEvent.click(screen.getByLabelText('Next change'))
    expect(scrollTo).toHaveBeenCalledTimes(1)
    const first = scrollTo.mock.instances[0] as HTMLElement
    expect(first.textContent).toContain('@@ -1,2 +1,2 @@')

    fireEvent.click(screen.getByLabelText('Next change'))
    expect((scrollTo.mock.instances[1] as HTMLElement).textContent).toContain('@@ -10,2 +10,2 @@')

    // 끝에서 다음을 누르면 처음으로 돌아온다.
    fireEvent.click(screen.getByLabelText('Next change'))
    expect((scrollTo.mock.instances[2] as HTMLElement).textContent).toContain('@@ -1,2 +1,2 @@')

    fireEvent.click(screen.getByLabelText('Previous change'))
    expect((scrollTo.mock.instances[3] as HTMLElement).textContent).toContain('@@ -10,2 +10,2 @@')
  })

  it('F7 과 ⇧F7 이 같은 동작을 한다', () => {
    const scrollTo = vi.spyOn(Element.prototype, 'scrollIntoView')
    renderWithStore(
      <DiffView
        diff={workspaceDiff([
          fileDiff({ path: 'src/a.ts', patch: TWO_HUNKS, additions: 2, deletions: 2 })
        ])}
        loading={false}
        baseBranch="main"
      />
    )
    fireEvent.keyDown(window, { code: 'F7' })
    expect((scrollTo.mock.instances[0] as HTMLElement).textContent).toContain('@@ -1,2 +1,2 @@')
    fireEvent.keyDown(window, { code: 'F7', shiftKey: true })
    expect((scrollTo.mock.instances[1] as HTMLElement).textContent).toContain('@@ -10,2 +10,2 @@')
  })

  it('수식 키가 붙은 F7 은 무시한다', () => {
    const scrollTo = vi.spyOn(Element.prototype, 'scrollIntoView')
    renderWithStore(
      <DiffView
        diff={workspaceDiff([
          fileDiff({ path: 'src/a.ts', patch: TWO_HUNKS, additions: 2, deletions: 2 })
        ])}
        loading={false}
        baseBranch="main"
      />
    )
    fireEvent.keyDown(window, { code: 'F7', metaKey: true })
    fireEvent.keyDown(window, { code: 'F7', ctrlKey: true })
    fireEvent.keyDown(window, { code: 'F7', altKey: true })
    expect(scrollTo).not.toHaveBeenCalled()
  })
})

/**
 * 워드랩 토글이 **라인 코멘트의 히트 테스트를 어긋나게 하지 않는지** 확인한다.
 *
 * Wooi 는 드래그로 행 범위를 골라 코멘트를 단다. 랩이 켜지면 한 줄이 여러 시각적 줄로 늘어나고,
 * 끄면 행이 화면보다 넓어져 가로로 밀린다 — 좌표로 행을 찾는 구현이었다면 둘 다 어긋났을
 * 자리다. 실제로는 행 `<div>` 의 `onMouseEnter` 와 배열 인덱스만 쓰므로 기하학이 개입하지
 * 않는다. 그 사실을 고정해 둔다.
 */
const WRAP_PATCH = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1
-const b = 2
+const b = 3
+const veryLong = '${'x'.repeat(400)}'
 const c = 4
`

const WRAP_DIFF: WorkspaceDiff = {
  baseBranch: 'origin/main',
  files: [
    {
      path: 'src/a.ts',
      status: 'modified',
      additions: 2,
      deletions: 1,
      patch: WRAP_PATCH,
      binary: false
    }
  ]
}

/** 행 0 에서 눌러 행 3 까지 끌고 놓은 뒤, 열린 상자에 코멘트를 저장한다. */
function dragComment(fromRow: number, toRow: number): void {
  const buttons = screen.getAllByLabelText('Comment on this line')
  fireEvent.mouseDown(buttons[fromRow])
  // 버튼의 조상이 행 컨테이너다 — span > div(row).
  const target = buttons[toRow].parentElement!.parentElement!
  fireEvent.mouseEnter(target)
  fireEvent.mouseUp(window)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'fix this' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add comment' }))
}

describe.each([
  ['랩 켜짐', true],
  ['랩 꺼짐', false]
])('DiffView 라인 코멘트 (%s)', (_label, wrap) => {
  const renderView = (
    onAdd: (anchor: DiffCommentAnchor, body: string) => void
  ): ReturnType<typeof render> =>
    render(
      <DiffView
        diff={WRAP_DIFF}
        loading={false}
        baseBranch="origin/main"
        wrap={wrap}
        commenting={{ comments: [], onAdd, onEdit: vi.fn(), onRemove: vi.fn() }}
      />
    )

  it('드래그로 고른 범위가 같은 줄 번호로 굳는다', () => {
    const onAdd = vi.fn()
    renderView(onAdd)

    // 행 0(문맥 L1) → 행 3(추가 L3). 사이의 삭제 행은 새 파일에 줄 번호가 없어 건너뛴다.
    dragComment(0, 3)

    expect(onAdd).toHaveBeenCalledWith(
      { path: 'src/a.ts', deleted: false, from: 1, to: 3 },
      'fix this'
    )
  })

  it('한 행만 눌러도 그 줄에 달린다', () => {
    const onAdd = vi.fn()
    renderView(onAdd)

    dragComment(4, 4)

    expect(onAdd).toHaveBeenCalledWith(
      { path: 'src/a.ts', deleted: false, from: 4, to: 4 },
      'fix this'
    )
  })
})

describe('DiffView 워드랩', () => {
  const renderWrap = (wrap: boolean): HTMLElement => {
    const { container } = render(
      <DiffView diff={WRAP_DIFF} loading={false} baseBranch="origin/main" wrap={wrap} />
    )
    return container.querySelector('[data-diff-file="src/a.ts"]') as HTMLElement
  }

  it('랩을 켜면 접히고, 가로 스크롤을 만들지 않는다', () => {
    const block = renderWrap(true)
    expect(block.querySelector('.whitespace-pre-wrap')).not.toBeNull()
    expect(block.querySelector('.overflow-x-auto')).toBeNull()
  })

  it('랩을 끄면 정렬을 지키고 가로로 민다', () => {
    const block = renderWrap(false)
    expect(block.querySelector('.whitespace-pre-wrap')).toBeNull()
    expect(block.querySelector('.overflow-x-auto')).not.toBeNull()
    // 짧은 줄에서도 행 상자가 화면 폭까지 늘어나야 hover 로 범위를 늘릴 수 있다.
    expect(block.querySelector('.min-w-full')).not.toBeNull()
  })

  it('파일 블록에는 트리가 찾아올 표적이 달려 있다', () => {
    expect(renderWrap(true)).not.toBeNull()
  })
})
