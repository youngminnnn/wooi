/**
 * 오류 문구에서 "API 에 닿지 못했다" 를 읽어내는 규칙.
 *
 * 사용량 제한([[rateLimitText]])과 나란히 두는 이유는 처방이 같아서다 — 둘 다 사용자가 코드로
 * 고칠 것이 없고, 기다리면 풀리며, 그동안 하던 작업은 이어가야 한다. 다른 점은 언제 풀릴지를
 * 아무도 알려 주지 않는다는 것뿐이다.
 *
 * **판정을 문구로 하는 이유**: Electron 의 `net.isOnline()` 은 쓸 수 있는 인터페이스가 있으면
 * true 다. DNS 가 죽었거나(ENOTFOUND) 캡티브 포털에 갇힌 맥은 "온라인" 으로 보고되므로, 실제로
 * 못 닿았다는 사실은 실패한 턴의 문구에서만 읽을 수 있다.
 */
export const CONNECTION_ERROR =
  /\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ECONNABORTED|ETIMEDOUT|ENETUNREACH|ENETDOWN|EHOSTUNREACH|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)\b|can(?:'|’)?t reach the api server|fetch failed|socket hang up|getaddrinfo|network (?:error|is unreachable)|connection (?:error|refused|reset|timed out)/i

/** 이 오류 문구가 "API 에 닿지 못했다" 인가. */
export function isConnectionError(text: string | null | undefined): boolean {
  return Boolean(text && CONNECTION_ERROR.test(text))
}
