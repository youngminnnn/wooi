import { useCallback, useEffect, useRef, useState } from 'react'
import { Clipboard } from 'react-native'

/**
 * 클립보드 복사와 "복사했다" 는 짧은 표시.
 *
 * **`Clipboard` 를 이 파일에서만 import 한다.** RN 코어의 이 API 는 deprecated 이고 언젠가
 * 빠진다 — 그때 갈아 끼울 자리를 한 곳으로 묶어 두려는 것이다. `expo-clipboard` 를 쓰면 그
 * 문제가 없지만 그건 네이티브 모듈이라, 더하는 순간 이미 설치된 앱들이 새 JS 를 받고도 이
 * 화면에서 죽는다(apps/mobile/CLAUDE.md). 코어 쪽은 이미 앱 안에 구워져 있어 OTA 로 나간다.
 *
 * 경고는 `warnOnce` 라 한 번만 뜬다.
 *
 * 햅틱이 없으므로 **눈으로 보이는 확인**이 유일한 피드백이다 — 눌렀는데 아무 일도 없으면
 * 복사가 됐는지 알 방법이 없다.
 */
export function useCopy(): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 화면을 떠난 뒤 setState 가 불리지 않게 정리한다.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    []
  )

  const copy = useCallback((text: string): void => {
    if (text === '') return
    Clipboard.setString(text)
    setCopied(true)
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1500)
  }, [])

  return { copied, copy }
}
