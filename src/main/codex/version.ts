/**
 * Codex CLI 버전 파싱·비교.
 *
 * 프로세스 spawn 없이 순수 문자열만 다루므로 유닛 테스트가 가능하도록 executable.ts 에서 분리했다.
 */

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

/**
 * `codex --version` 출력에서 버전을 뽑는다.
 * "codex-cli 0.146.0", "codex 0.146.0", "0.146.0" 같은 형태를 모두 받아들인다.
 * 찾지 못하면 null — 호출부는 "버전 불명"으로 취급하고 차단하지 않는다(오탐으로 막는 것보다 낫다).
 */
export function parseVersion(output: string): string | null {
  return output.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0] ?? null
}

/**
 * semver 비교(a < b 면 음수, 같으면 0, 크면 양수). prerelease 접미사는 무시하고 숫자 세 자리만 본다
 * — 우리에게 필요한 건 "최소 버전 이상인가" 뿐이라 정밀한 semver 규칙까지는 필요 없다.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v
      .split('-')[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0)
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** 최소 요구 버전을 충족하는가. 버전을 알 수 없으면(null) 막지 않는다. */
export function meetsMinimum(version: string | null): boolean {
  if (!version) return true
  return compareVersions(version, MIN_CODEX_VERSION) >= 0
}
