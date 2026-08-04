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
