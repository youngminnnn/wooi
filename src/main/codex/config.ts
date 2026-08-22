/**
 * Wooi 안에서 띄우는 Codex 프로세스에만 적용하는 설정 오버라이드.
 *
 * Codex 데스크톱은 Computer Use 설치 시 전역 config.toml 의 `notify`에
 * `SkyComputerUseClient turn-ended`를 등록할 수 있다. 그대로 상속하면 Wooi의 평범한 코딩 턴도
 * 끝날 때마다 Computer Use 앱을 깨우고, macOS가 "Wooi가 Codex Computer Use를 제어"한다는
 * Automation 권한을 묻게 된다. Wooi는 완료 알림을 직접 내므로 이 훅은 중복이기도 하다.
 *
 * 빈 notify는 Computer Use MCP를 끄지 않는다. 사용자가 실제로 Computer Use를 요청했을 때 쓰는
 * mcp_servers.computer-use 설정은 그대로 상속하고, 턴 종료 알림 프로세스만 막는다.
 */
export const WOOI_CODEX_CONFIG_ARGS = ['-c', 'notify=[]'] as const

/** 첫 서브커맨드 뒤에 전역 config override를 넣는다 (`exec resume`에도 같은 위치가 유효하다). */
export function withWooiCodexConfig(args: string[]): string[] {
  if (args.length === 0) return [...WOOI_CODEX_CONFIG_ARGS]
  return [args[0], ...WOOI_CODEX_CONFIG_ARGS, ...args.slice(1)]
}

/** `/debug-config` 카드에 자격 증명이 노출되지 않도록 app-server 응답을 복사하며 가린다. */
export function redactDebugConfig(value: unknown, parentKey = ''): unknown {
  if (parentKey.toLowerCase() === 'env' && (!value || typeof value !== 'object')) {
    return '[redacted]'
  }
  if (Array.isArray(value)) return value.map((item) => redactDebugConfig(item, parentKey))
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      const sensitive =
        parentKey.toLowerCase() === 'env' ||
        /(?:api[_-]?key|token|secret|password|credential)/i.test(key)
      return [key, sensitive ? '[redacted]' : redactDebugConfig(item, key)]
    })
  )
}

export const EXPERIMENTAL_UNSUPPORTED_REASON =
  'Codex app-server 0.146 does not expose experimental-feature metadata or a safe feature-toggle method.'
