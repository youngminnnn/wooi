import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'

/**
 * 세션 테스트용 Wooi 도구 서버 자리표시자.
 *
 * SessionDeps.wooiMcp 를 선택 인자로 두지 않기 위해 존재한다 — 선택으로 두면 호스트가 넘기는
 * 것을 잊어도 타입이 통과하고, 도구가 조용히 사라진 채 모델만 "그런 도구 없음" 을 보게 된다.
 *
 * 진짜 서버를 만들지 않는 이유: 세션 테스트는 `@anthropic-ai/claude-agent-sdk` 를 통째로
 * 모킹하므로 createSdkMcpServer 가 없다. 어차피 이 값은 모킹된 query 로 그대로 넘어갈 뿐
 * 호출되지 않으니, 스텁이 정확한 표현이다.
 */
export const testWooiMcp = {
  type: 'sdk',
  name: 'wooi',
  instance: {}
} as unknown as McpSdkServerConfigWithInstance

/**
 * e2e 세션 테스트용 **진짜** 서버.
 *
 * 위 스텁을 e2e 에 쓰면 안 된다. e2e 는 SDK 를 모킹하지 않고 실물 CLI 를 띄우므로, SDK 가
 * `type: 'sdk'` 인 서버마다 인스턴스의 connect() 를 실제로 부른다 — `{}` 에는 그 메서드가 없어
 * `TypeError: t.connect is not a function` 으로 첫 query 가 산출 없이 죽는다. 세션이 시작조차
 * 못 하니 정작 검증하려던 것(훅 · 실패 턴 재시작)은 확인되지 않는다.
 *
 * 도구는 실제로 불리지 않으므로 callTool 은 자리표시자로 둔다. 필요한 것은 "SDK 가 붙일 수 있는
 * 서버" 하나뿐이고, 그것을 만드는 방법은 앱과 같아야 한다([[claude/wooiMcp]]).
 *
 * 동적 import 인 이유: 이 모듈은 SDK 를 모킹하는 유닛 테스트들도 함께 import 한다. 최상단에서
 * 끌어오면 그쪽 모킹 경계를 건드린다.
 */
export async function e2eWooiMcp(): Promise<McpSdkServerConfigWithInstance> {
  const { createWooiMcpServer } = await import('./wooiMcp')
  return createWooiMcpServer(async () => null)
}
