import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import WorkPanel from './WorkPanel'
import TerminalPane from './TerminalPane'
import Splitter from './Splitter'
import type { Workspace } from '@shared/types'

/**
 * 우측 컬럼: 위쪽 탭 패널(All files / Changes / Check) + 아래쪽 인터랙티브 터미널.
 *
 * 터미널 높이는 컬럼 높이의 비율(terminalRatio, 기본 0.5 = 50%)로 정해, 창 크기가 바뀌어도
 * 비율이 유지된다. 가로 분할바를 끌면 비율을 조절한다(전체 폭은 App 의 세로 분할바가 담당).
 */
export default function WorkArea({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const ratio = useStore((s) => s.terminalRatio)
  const setRatio = useStore((s) => s.setTerminalRatio)
  const base = useRef(ratio)
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerH, setContainerH] = useState(0)

  // 컬럼 높이를 측정해 비율 → px 로 환산한다(창 리사이즈에도 비율 유지).
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setContainerH(el.clientHeight))
    ro.observe(el)
    setContainerH(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  const terminalHeight = Math.round(containerH * ratio)

  return (
    <div ref={containerRef} className="h-full flex flex-col min-w-0">
      <div className="flex-1 min-h-0">
        <WorkPanel workspace={workspace} />
      </div>
      <Splitter
        axis="y"
        onStart={() => (base.current = useStore.getState().terminalRatio)}
        // 분할바를 위로 끌면(dy<0) 터미널이 커진다. 픽셀 이동을 컬럼 높이로 나눠 비율로 환산.
        onDelta={(_dx, dy) => containerH && setRatio(base.current - dy / containerH)}
      />
      <div style={{ height: terminalHeight }} className="shrink-0">
        <TerminalPane workspaceId={workspace.id} />
      </div>
    </div>
  )
}
