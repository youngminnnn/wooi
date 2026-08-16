import { log } from './logger'

/**
 * 앱 밖에서 바뀌는 작은 텍스트 파일을 가져온다(원격 공지, 기능 플래그).
 *
 * 두 곳이 같은 방어를 필요로 한다 — 타임아웃, 크기 상한, 캐시 무시. 복사해 두면 한쪽만
 * 고쳐져 서서히 갈라지는데, 하필 갈라지는 것이 **보안 성격의 상한**이라 그러면 안 된다.
 *
 * 실패는 전부 `null` 이다. 오프라인·DNS 실패·타임아웃·잘못된 응답은 이 앱에서 정상 상황이고,
 * 부르는 쪽은 "못 가져왔다"와 "가져왔는데 비었다"를 구분할 수 있어야 한다.
 */
export async function fetchRemoteText(
  url: string,
  options: { label: string; timeoutMs?: number; maxBytes?: number }
): Promise<string | null> {
  const { label, timeoutMs = 10_000, maxBytes = 64 * 1024 } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-cache' })
    if (!response.ok) {
      log.warn(`${label}: fetch ${response.status}`)
      return null
    }
    const body = await response.text()
    if (body.length > maxBytes) {
      log.warn(`${label}: 응답이 너무 큼 — 무시`)
      return null
    }
    return body
  } catch (err) {
    log.info(`${label}: fetch 실패 — ${err instanceof Error ? err.message : String(err)}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}
