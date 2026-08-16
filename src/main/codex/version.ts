/**
 * Codex CLI 의 최소 버전과 그 판정.
 *
 * 파싱·비교 자체는 백엔드에 중립적이라 main/version.ts 에 있다. 여기 남는 것은 **Codex 가
 * 무엇을 요구하는가** 뿐이다. 기존 import 를 깨지 않도록 두 헬퍼를 그대로 다시 내보낸다.
 */

export { compareVersions, parseVersion } from '../version'
import { compareVersions } from '../version'

/**
 * Wooi 가 요구하는 최소 codex 버전.
 *
 * app-server 의 thread/turn(v2) API 표면을 쓰기 때문에 아주 옛 버전과는 붙지 않는다. 다만 어떤
 * 버전에서 정확히 그 표면이 굳었는지는 공개 문서에 없어, **직접 확인한 가장 낮은 버전**을 바닥으로
 * 잡았다(0.128.0 — 이 버전이 남긴 rollout 파일에서 turn/item 구조를 확인했다).
 *
 * 이 값은 "친절한 에러 메시지"용 소프트 게이트다. 실제 호환성 판단은 initialize 핸드셰이크와
 * 메서드별 -32601 감지(jsonrpc 의 tryRequest)가 담당한다 — 버전 번호만 믿지 않는다.
 */
export const MIN_CODEX_VERSION = '0.128.0'

/** 최소 요구 버전을 충족하는가. 버전을 알 수 없으면(null) 막지 않는다. */
export function meetsMinimum(version: string | null): boolean {
  if (!version) return true
  return compareVersions(version, MIN_CODEX_VERSION) >= 0
}
