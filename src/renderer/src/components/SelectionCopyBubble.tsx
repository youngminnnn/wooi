import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy } from 'lucide-react'
import { addViewportSizeChangeListener } from '../lib/viewportResize'

/**
 * 고른 글자 위에 복사 버튼을 띄운다.
 *
 * Wooi 는 버튼 안에 박힌 도구 출력까지 고를 수 있게 이미 배려해 뒀지만([[SELECTABLE]]),
 * 고르고 나면 누를 것이 화면에 없어서 ⌘C 를 아는 사람만 복사할 수 있었다. 드래그가 끝난 자리에
 * 버튼 하나를 얹어 그 간격을 메운다.
 *
 * 감싼 영역 밖으로 걸친 선택은 무시한다 — 대화 밖까지 훑어 놓고 "복사" 를 누르면 사용자가
 * 보고 있던 것과 다른 글자가 복사된다.
 */
const BUBBLE_WIDTH = 84
const BUBBLE_HEIGHT = 30
/** 화면 가장자리와 버블 사이 여백. 잘려서 반만 보이는 일이 없게 한다. */
const MARGIN = 8
/** 손을 뗀 지점보다 이만큼 위에 띄운다 — 커서와 겹치면 방금 고른 글자를 가린다. */
const LIFT = 12

type Bubble = { x: number; y: number; text: string }

export default function SelectionCopyBubble({
  children,
  className,
  style
}: {
  children: React.ReactNode
  className?: string
  style?: React.CSSProperties
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const [bubble, setBubble] = useState<Bubble | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!bubble) return
    const close = (): void => setBubble(null)
    // 버블 자신을 누른 것은 닫을 이유가 아니다. stopPropagation 대신 포함 관계로 판정하는 이유는
    // 버블이 포털(body 직속)이라 리액트 트리와 DOM 트리의 전파 경로가 갈리기 때문이다.
    const onPointerDown = (e: PointerEvent): void => {
      if (bubbleRef.current?.contains(e.target as Node)) return
      close()
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    // 스크롤은 캡처로 듣는다 — 대화 스크롤러는 window 로 스크롤 이벤트를 올려 보내지 않는다.
    window.addEventListener('scroll', close, true)
    const stopViewportListener = addViewportSizeChangeListener(close)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('scroll', close, true)
      stopViewportListener()
    }
  }, [bubble])

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    // 왼쪽 버튼으로 끝낸 드래그만 본다. 오른쪽 버튼은 OS 컨텍스트 메뉴의 몫이다.
    if (e.button !== 0) return
    const text = selectionTextInside(hostRef.current)
    if (!text) {
      setBubble(null)
      return
    }
    setCopied(false)
    setBubble({
      text,
      x: clamp(e.clientX - BUBBLE_WIDTH / 2, MARGIN, window.innerWidth - BUBBLE_WIDTH - MARGIN),
      y: clamp(
        e.clientY - BUBBLE_HEIGHT - LIFT,
        MARGIN,
        window.innerHeight - BUBBLE_HEIGHT - MARGIN
      )
    })
  }

  const copy = (): void => {
    if (!bubble) return
    void navigator.clipboard.writeText(bubble.text).then(() => {
      setCopied(true)
      setTimeout(() => setBubble(null), 600)
    })
  }

  return (
    <div ref={hostRef} className={className} style={style} onPointerUp={onPointerUp}>
      {children}
      {bubble &&
        createPortal(
          <div
            ref={bubbleRef}
            style={{ left: bubble.x, top: bubble.y }}
            className="fixed z-50 rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] p-0.5 shadow-xl"
          >
            <button
              type="button"
              onClick={copy}
              className="flex h-[26px] items-center gap-1.5 rounded-[6px] px-2 text-xs text-neutral-300 hover:bg-[var(--surface-2)] hover:text-neutral-100"
            >
              {copied ? (
                <Check size={12} className="text-[var(--success-400)]" />
              ) : (
                <Copy size={12} />
              )}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>,
          document.body
        )}
    </div>
  )
}

/** 감싼 영역 안에서만 고른 글자. 한쪽 끝이라도 밖으로 나가면 빈 문자열이다. */
function selectionTextInside(host: HTMLElement | null): string {
  if (!host) return ''
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return ''
  const { anchorNode, focusNode } = selection
  if (!anchorNode || !focusNode) return ''
  if (!host.contains(anchorNode) || !host.contains(focusNode)) return ''
  return selection.toString().trim()
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}
