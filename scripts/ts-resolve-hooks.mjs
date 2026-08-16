/**
 * 확장자 없는 상대 import 를 `.ts` 로 해석하는 Node 로더 훅.
 *
 * `src/main/**` 은 electron-vite(번들러)가 확장자를 붙여 주는 것을 전제로 쓰였는데,
 * Node 의 ESM 은 상대 경로에 확장자를 요구한다. 스크립트에서 main 모듈을 **복사 없이**
 * 그대로 돌리려면 이 간극만 메우면 된다 — 그게 `scripts/remote-probe.ts` 가
 * 실제 `PairingManager` 를 검증할 수 있는 이유다.
 *
 * 소스를 고쳐 확장자를 붙이는 대안은 택하지 않았다: 번들러 설정과 어긋나고,
 * 스크립트 하나의 편의를 위해 앱 코드 전체를 건드리는 셈이 된다.
 */
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context)
  } catch (err) {
    const extensionless = specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)
    if (!extensionless) throw err
    // 디렉토리 import(`./remote`)는 index.ts 로도 시도한다.
    for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
      try {
        return await next(candidate, context)
      } catch {
        /* 다음 후보 */
      }
    }
    throw err
  }
}
