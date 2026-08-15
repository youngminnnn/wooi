import { log } from '../logger'
import type { AntigravityEvent } from './protocol'

export interface AntigravityStreamReader {
  push(chunk: string): void
  end(): void
}

const MAX_WARNINGS = 5

export function createAntigravityStream(
  onEvent: (event: AntigravityEvent) => void,
  onUnparsable?: (line: string) => void
): AntigravityStreamReader {
  let buffer = ''
  let warnings = 0

  const handleLine = (raw: string): void => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (!line.trim()) return

    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      unparsable(line)
      return
    }

    // 새 이벤트 이름은 버리지 않되, event 프레이밍조차 없는 JSON 은 진단 대상으로 분리한다.
    if (!isEvent(value)) {
      unparsable(line)
      return
    }
    onEvent(value)
  }

  const unparsable = (line: string): void => {
    onUnparsable?.(line)
    // agy 가 stdout 에 진단을 연속 출력해도 main.log 를 잠식하지 않도록 리더별 상한을 둔다.
    if (warnings < MAX_WARNINGS) {
      log.warn(`antigravity stream: dropping unparsable line (${line.slice(0, 120)})`)
      warnings++
    }
  }

  return {
    push(chunk) {
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        handleLine(line)
      }
    },
    end() {
      if (buffer) handleLine(buffer)
      buffer = ''
    }
  }
}

function isEvent(value: unknown): value is AntigravityEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'event' in value &&
    typeof value.event === 'string' &&
    value.event.length > 0
  )
}
