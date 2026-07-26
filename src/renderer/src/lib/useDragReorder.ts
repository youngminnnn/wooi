import { useRef, useState } from 'react'
import type React from 'react'
import type { DropPosition } from '@shared/types'

/**
 * 목록 재정렬용 HTML5 드래그 앤 드롭 배선.
 *
 * dnd-kit 같은 라이브러리 대신 브라우저 기본 DnD 를 쓰는 이유: 사이드바 재정렬은 "세로 목록에서
 * 행 하나를 형제 사이로 옮긴다"가 전부라, 의존성을 하나 더 얹을 만큼의 요구가 없다.
 *
 * 사용법 — 드래그를 시작할 요소에 handleProps, 드롭을 받을 요소에 zoneProps 를 펼쳐 넣는다.
 * 둘이 같은 요소여도 되고(워크스페이스 행), 달라도 된다(리포는 헤더만 잡아 끌고 블록 전체가
 * 드롭을 받는다 — 블록 전체를 draggable 로 만들면 내부 이름 편집 입력의 텍스트 선택이 막힌다).
 */
export interface DragReorder {
  /** 이 요소를 잡아 끌면 id 항목의 드래그가 시작된다. */
  handleProps(id: string): {
    draggable: true
    onDragStart: (e: React.DragEvent) => void
    onDragEnd: () => void
  }
  /** 이 요소 위에 놓으면 id 항목의 앞/뒤로 삽입된다. */
  zoneProps(id: string): {
    onDragOver: (e: React.DragEvent) => void
    onDragLeave: (e: React.DragEvent) => void
    onDrop: (e: React.DragEvent) => void
  }
  /**
   * 드래그 중 흐림 + 드롭 위치 표시선을 그리는 인라인 스타일.
   * 레이아웃을 밀지 않도록 별도 요소가 아니라 inset box-shadow 로 선을 그린다.
   * 자체 style 이 있는 요소는 `{ ...own, ...dnd.visualStyle(id) }` 로 병합한다.
   */
  visualStyle(id: string): React.CSSProperties
}

export function useDragReorder({
  mime,
  canDrop,
  onReorder
}: {
  /**
   * 이 목록만의 dataTransfer 타입(예: 'application/x-wooi-repo'). 중첩된 다른 목록의 드래그를
   * 서로 구분하는 열쇠다. 브라우저가 커스텀 타입을 소문자로 정규화하므로 소문자로 쓴다.
   */
  mime: string
  /** 두 항목이 서로 자리를 바꿀 수 있는지(예: 같은 레포·같은 stack 부모). 없으면 항상 허용. */
  canDrop?: (draggedId: string, targetId: string) => boolean
  onReorder: (draggedId: string, targetId: string, position: DropPosition) => void
}): DragReorder {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [drop, setDrop] = useState<{ id: string; position: DropPosition } | null>(null)
  // dragover 중에는 보안상 dataTransfer.getData() 가 빈 문자열을 돌려준다(타입 목록만 읽을 수 있다).
  // 그래서 드래그 중인 id 를 따로 들고 canDrop 판정에 쓴다. state 가 아니라 ref 인 이유는
  // dragover 가 초당 수십 번 발생해, 판정용 값까지 렌더에 묶으면 낭비이기 때문이다.
  const draggingRef = useRef<string | null>(null)

  /** 이 드래그를 이 목록이 받아야 하는지. */
  const accepts = (e: React.DragEvent, targetId: string): boolean => {
    if (!e.dataTransfer.types.includes(mime)) return false
    const dragged = draggingRef.current
    if (!dragged || dragged === targetId) return false
    return canDrop ? canDrop(dragged, targetId) : true
  }

  /** 행의 세로 중앙을 기준으로 앞/뒤를 정한다. */
  const positionIn = (el: HTMLElement, clientY: number): DropPosition => {
    const r = el.getBoundingClientRect()
    return clientY < r.top + r.height / 2 ? 'before' : 'after'
  }

  const reset = (): void => {
    draggingRef.current = null
    setDraggingId(null)
    setDrop(null)
  }

  return {
    handleProps: (id) => ({
      draggable: true,
      onDragStart: (e) => {
        // 중첩 draggable(리포 블록 안의 워크스페이스 행)에서 바깥 핸들까지 이벤트가 올라가
        // payload 를 덮어쓰지 않도록, 가장 안쪽 핸들에서 끊는다.
        e.stopPropagation()
        e.dataTransfer.setData(mime, id)
        e.dataTransfer.effectAllowed = 'move'
        draggingRef.current = id
        setDraggingId(id)
      },
      // 드롭 성공·취소(ESC·바깥에 놓기) 모두에서 반드시 발생하므로, 시각 상태 정리를 여기 모은다.
      onDragEnd: reset
    }),

    zoneProps: (id) => ({
      onDragOver: (e) => {
        // 우리가 다룰 수 없는 드래그면 preventDefault 도 stopPropagation 도 하지 않고 흘려보낸다.
        // 그래야 리포를 워크스페이스 행 위로 지나가게 끌 때 바깥 리포 드롭존이 대신 반응한다.
        if (!accepts(e, id)) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        const position = positionIn(e.currentTarget as HTMLElement, e.clientY)
        // 같은 위치면 객체를 새로 만들지 않아, 마우스가 한 행 안에서 움직이는 동안 재렌더를 막는다.
        setDrop((cur) => (cur?.id === id && cur.position === position ? cur : { id, position }))
      },
      onDragLeave: (e) => {
        if (!e.dataTransfer.types.includes(mime)) return
        // 자식 요소로 넘어갈 때도 dragleave 가 뜬다. 실제로 이 존 밖으로 나갔을 때만 표시를 지워
        // 커서가 행 내부를 오갈 때 표시선이 깜빡이지 않게 한다.
        const next = e.relatedTarget as Node | null
        if (next && (e.currentTarget as HTMLElement).contains(next)) return
        setDrop((cur) => (cur?.id === id ? null : cur))
      },
      onDrop: (e) => {
        if (!accepts(e, id)) return
        e.preventDefault()
        e.stopPropagation()
        const dragged = e.dataTransfer.getData(mime)
        const position = positionIn(e.currentTarget as HTMLElement, e.clientY)
        reset()
        if (dragged && dragged !== id) onReorder(dragged, id, position)
      }
    }),

    visualStyle: (id) => {
      const style: React.CSSProperties = {}
      if (draggingId === id) style.opacity = 0.4
      if (drop?.id === id) {
        const edge = drop.position === 'before' ? '2px' : '-2px'
        style.boxShadow = `inset 0 ${edge} 0 0 var(--info-500)`
      }
      return style
    }
  }
}
