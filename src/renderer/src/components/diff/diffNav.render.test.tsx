import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { DiffChangeAnchor, DiffNavProvider, useDiffNav } from './diffNav'

/**
 * 이 파일이 지키는 것은 하나다 — **덩어리 수가 바뀌어도 diff 본문은 다시 그리지 않는다.**
 * 등록 컨텍스트와 개수 컨텍스트를 나눈 유일한 이유이고, 합치는 순간 조용히 무너지는 성질이라
 * 주석이 아니라 테스트로 못 박아 둔다.
 */

const heavy = vi.fn()

/** 무거운 diff 본문 역할. 등록만 하고 개수는 읽지 않는다. */
function Heavy(): React.JSX.Element {
  heavy()
  return (
    <DiffChangeAnchor>
      <span>heavy</span>
    </DiffChangeAnchor>
  )
}

/** 파일을 펼치는 동작 역할 — 자기 상태만 바꿔 덩어리를 하나 더 붙인다(FileBlock 과 같은 모양). */
function Expandable(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)}>expand</button>
      {open && (
        <DiffChangeAnchor>
          <span>extra</span>
        </DiffChangeAnchor>
      )}
    </>
  )
}

function Header(): React.JSX.Element {
  const { count } = useDiffNav()
  return <span data-testid="count">{count}</span>
}

describe('diffNav 컨텍스트 분리', () => {
  it('덩어리 수가 바뀌어도 본문은 다시 그리지 않는다', () => {
    heavy.mockClear()
    render(
      <DiffNavProvider>
        <Header />
        <Heavy />
        <Expandable />
      </DiffNavProvider>
    )
    expect(screen.getByTestId('count').textContent).toBe('1')
    expect(heavy).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText('expand'))

    // 헤더는 새 숫자를 받았고,
    expect(screen.getByTestId('count').textContent).toBe('2')
    // 본문은 그대로다.
    expect(heavy).toHaveBeenCalledTimes(1)
  })

  it('덩어리가 사라지면 개수도 줄어든다', () => {
    function Removable(): React.JSX.Element {
      const [on, setOn] = useState(true)
      return (
        <>
          <button onClick={() => setOn(false)}>remove</button>
          {on && (
            <DiffChangeAnchor>
              <span>gone soon</span>
            </DiffChangeAnchor>
          )}
        </>
      )
    }
    render(
      <DiffNavProvider>
        <Header />
        <Removable />
      </DiffNavProvider>
    )
    expect(screen.getByTestId('count').textContent).toBe('1')
    fireEvent.click(screen.getByText('remove'))
    expect(screen.getByTestId('count').textContent).toBe('0')
  })
})
