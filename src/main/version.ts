/**
 * CLI 버전 문자열 파싱·비교. **백엔드에 중립적인 순수 함수**만 둔다.
 *
 * 백엔드마다 최소 버전을 요구하는데(codex/version.ts · antigravity/executable.ts), 그 판정에 쓰는
 * 문자열 조작까지 백엔드별로 복제하거나 한쪽이 다른 쪽을 import 하면 없는 결합이 생긴다 —
 * `antigravity/executable.ts` 가 `codex/version.ts` 를 부르는 그림은 읽는 사람에게 두 백엔드가
 * 얽혀 있다고 잘못 말한다. 그래서 공통분모만 여기로 올리고, **무엇이 최소 버전인가**는 각
 * 백엔드가 자기 자리에 둔다.
 */

/**
 * `<cli> --version` 출력에서 버전을 뽑는다.
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
