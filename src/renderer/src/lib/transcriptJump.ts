import { useEffect, useState, type RefObject } from 'react'
import { useStore } from '../store'

/** 대상 항목이 그려질 때까지 기다리는 간격·횟수(트랜스크립트는 비동기로 도착한다). */
const RETRY_MS = 50
const MAX_TRIES = 40
/** 도착 표시를 남겨 두는 시간. 너무 짧으면 스크롤이 끝나기도 전에 사라진다. */
const HIGHLIGHT_MS = 2500

/**
 * 대화 검색(⇧⌘K)에서 고른 항목으로 대화창을 데려간다.
 *
 * 반환값은 "지금 도착 표시를 붙일 항목 id" 로, 대화창의 ⌘F 검색이 쓰는 하이라이트 경로에
 * 그대로 얹힌다 — 이동을 위해 목록 컴포넌트를 새로 뜯지 않기 위한 접점이다.
 *
 * 워크스페이스를 막 전환한 직후에는 기록이 아직 도착하지 않아 대상 DOM 이 없다. 그래서 한 번
 * 찾아보고 마는 대신 짧은 간격으로 다시 본다.
 */
export function useTranscriptJump(
  workspaceId: string,
  containerRef: RefObject<HTMLElement | null>
): string | undefined {
  const target = useStore((s) => s.jumpTarget)
  const clearJumpTarget = useStore((s) => s.clearJumpTarget)
  const [arrivedId, setArrivedId] = useState<string>()

  const itemId = target?.workspaceId === workspaceId ? target.itemId : undefined
  const seq = target?.workspaceId === workspaceId ? target.seq : undefined

  useEffect(() => {
    if (!itemId) return
    let tries = 0
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = (): void => {
      const el = containerRef.current?.querySelector(`[data-item-id="${cssAttr(itemId)}"]`)
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        // 대화창은 내용이 처음 채워질 때 저장해 둔 스크롤 위치를 한 번 복원한다. 그 복원이
        // 이 프레임 뒤에 오면 애써 맞춘 위치가 밀리므로, 한 박자 뒤에 한 번 더 맞춘다.
        timer = setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 150)
        setArrivedId(itemId)
        clearJumpTarget()
        return
      }
      if (tries++ >= MAX_TRIES) {
        // 항목이 사라졌다(/clear 이후 등) — 목적지를 남겨 두면 다음 전환 때 엉뚱하게 되살아난다.
        clearJumpTarget()
        return
      }
      timer = setTimeout(tick, RETRY_MS)
    }

    tick()
    return () => clearTimeout(timer)
    // seq 로 같은 항목을 다시 골랐을 때도 이동이 새로 일어나게 한다.
  }, [itemId, seq, containerRef, clearJumpTarget])

  useEffect(() => {
    if (!arrivedId) return
    const timer = setTimeout(() => setArrivedId(undefined), HIGHLIGHT_MS)
    return () => clearTimeout(timer)
  }, [arrivedId])

  return arrivedId
}

/** 속성 선택자 값에 들어갈 수 있는 따옴표·역슬래시를 이스케이프한다. */
function cssAttr(value: string): string {
  return value.replace(/["\\]/g, '\\$&')
}
