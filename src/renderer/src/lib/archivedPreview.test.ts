import { describe, expect, it } from 'vitest'
import { archivedPreviewTarget, truncatedHistoryNotice, workspaceSurfaces } from './archivedPreview'

const live = { id: 'a', archived: false }
const archived = { id: 'b', archived: true }

describe('archivedPreviewTarget', () => {
  it('아카이브된 워크스페이스를 고르면 그것을 돌려준다', () => {
    expect(archivedPreviewTarget([live, archived], 'b')).toBe(archived)
  })

  it('살아 있는 워크스페이스는 미리보기 대상이 아니다 — 평범한 대화 화면이 뜬다', () => {
    expect(archivedPreviewTarget([live, archived], 'a')).toBeNull()
  })

  it('선택이 없거나 목록에서 사라졌으면 null 이다', () => {
    expect(archivedPreviewTarget([live, archived], null)).toBeNull()
    expect(archivedPreviewTarget([live, archived], 'gone')).toBeNull()
    expect(archivedPreviewTarget(undefined, 'b')).toBeNull()
  })
})

describe('workspaceSurfaces', () => {
  it('아카이브 미리보기는 worktree 가 필요한 표면을 전부 닫는다', () => {
    expect(workspaceSurfaces(true)).toEqual({
      composer: false,
      workPanel: false,
      fileViewer: false,
      worktreeTools: false,
      visitHistory: false
    })
  })

  it('살아 있는 워크스페이스는 아무것도 닫지 않는다', () => {
    expect(workspaceSurfaces(false)).toEqual({
      composer: true,
      workPanel: true,
      fileViewer: true,
      worktreeTools: true,
      visitHistory: true
    })
  })

  it('같은 입력에는 같은 객체를 돌려준다 — 셀렉터가 매번 새 객체를 보면 앱이 다시 그린다', () => {
    expect(workspaceSurfaces(true)).toBe(workspaceSurfaces(true))
    expect(workspaceSurfaces(false)).toBe(workspaceSurfaces(false))
  })
})

describe('truncatedHistoryNotice', () => {
  it('더 오래된 대화가 남아 있으면 몇 개를 보고 있는지 못박는다', () => {
    expect(truncatedHistoryNotice(300, true)).toBe(
      'Showing the most recent 300 messages — scroll up to load earlier ones.'
    )
  })

  it('머리까지 다 읽었으면 아무 말도 하지 않는다', () => {
    expect(truncatedHistoryNotice(42, false)).toBeNull()
  })

  it('보여 줄 것이 없으면 잘렸다고 하지 않는다', () => {
    expect(truncatedHistoryNotice(0, true)).toBeNull()
  })
})
